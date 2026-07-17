// Google Cast discovery over mDNS, without a dependency. We can't bind :5353
// alongside the OS mDNS responder on macOS, so instead we send a one-shot PTR
// query for _googlecast._tcp.local from an ephemeral socket with the unicast-
// response (QU) bit set, and parse the answers that come back: SRV gives host+port,
// TXT gives the friendly name, A gives the IPv4 address.

import { logger } from '@/lib/logger'

export interface CastDevice {
  id: string // the device's cast id (TXT `id=`), stable across sessions
  name: string // friendly name (TXT `fn=`)
  host: string // IPv4 address
  port: number
  model: string | null // TXT `md=`
}

const MDNS_ADDR = '224.0.0.251'
const MDNS_PORT = 5353
const SERVICE = '_googlecast._tcp.local'

// ── Query encoding ────────────────────────────────────────────────────────────

function encodeName(name: string): number[] {
  const out: number[] = []
  for (const label of name.split('.')) {
    out.push(label.length)
    for (const ch of label) out.push(ch.charCodeAt(0))
  }
  out.push(0)
  return out
}

function buildQuery(): Uint8Array {
  const q: number[] = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0] // header: qdcount=1
  q.push(...encodeName(SERVICE))
  q.push(0x00, 0x0c) // QTYPE PTR
  q.push(0x80, 0x01) // QCLASS IN with the QU (unicast-response) bit
  return new Uint8Array(q)
}

// ── Response parsing ──────────────────────────────────────────────────────────

interface Reader { buf: Uint8Array; offset: number }

/** Read a DNS name, following compression pointers. */
function readName(r: Reader, packet: Uint8Array): string {
  const labels: string[] = []
  let offset = r.offset
  let jumped = false
  let safety = 0
  while (safety++ < 128) {
    const len = packet[offset]!
    if (len === 0) { offset += 1; break }
    if ((len & 0xc0) === 0xc0) {
      const pointer = ((len & 0x3f) << 8) | packet[offset + 1]!
      if (!jumped) r.offset = offset + 2
      offset = pointer
      jumped = true
      continue
    }
    labels.push(new TextDecoder().decode(packet.subarray(offset + 1, offset + 1 + len)))
    offset += 1 + len
  }
  if (!jumped) r.offset = offset
  return labels.join('.')
}

interface ParsedAnswers {
  srv: Map<string, { host: string; port: number }> // instance -> host+port
  txt: Map<string, Record<string, string>> // instance -> TXT kv
  a: Map<string, string> // hostname -> ipv4
}

function parseResponse(packet: Uint8Array): ParsedAnswers {
  const out: ParsedAnswers = { srv: new Map(), txt: new Map(), a: new Map() }
  if (packet.length < 12) return out
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  const qd = view.getUint16(4)
  const an = view.getUint16(6) + view.getUint16(8) + view.getUint16(10) // answers + authority + additional
  const r: Reader = { buf: packet, offset: 12 }

  for (let i = 0; i < qd; i++) {
    readName(r, packet)
    r.offset += 4 // qtype + qclass
  }
  for (let i = 0; i < an; i++) {
    const name = readName(r, packet)
    if (r.offset + 10 > packet.length) break
    const type = view.getUint16(r.offset)
    const rdlength = view.getUint16(r.offset + 8)
    r.offset += 10
    const rdStart = r.offset
    if (type === 33) { // SRV
      const port = view.getUint16(rdStart + 4)
      const sub: Reader = { buf: packet, offset: rdStart + 6 }
      const target = readName(sub, packet)
      out.srv.set(name, { host: target, port })
    } else if (type === 16) { // TXT
      const kv: Record<string, string> = {}
      let p = rdStart
      while (p < rdStart + rdlength) {
        const len = packet[p]!
        const entry = new TextDecoder().decode(packet.subarray(p + 1, p + 1 + len))
        const eq = entry.indexOf('=')
        if (eq > 0) kv[entry.slice(0, eq)] = entry.slice(eq + 1)
        p += 1 + len
      }
      out.txt.set(name, kv)
    } else if (type === 1 && rdlength === 4) { // A
      out.a.set(name, `${packet[rdStart]}.${packet[rdStart + 1]}.${packet[rdStart + 2]}.${packet[rdStart + 3]}`)
    }
    r.offset = rdStart + rdlength
  }
  return out
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/** Broadcast a query and collect Cast devices for `timeoutMs`. */
export async function discoverCastDevices(timeoutMs = 2500): Promise<CastDevice[]> {
  const merged: ParsedAnswers = { srv: new Map(), txt: new Map(), a: new Map() }
  let sock: Awaited<ReturnType<typeof Bun.udpSocket>> | null = null
  try {
    sock = await Bun.udpSocket({
      socket: {
        data(_s, data) {
          const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
          try {
            const parsed = parseResponse(buf)
            for (const [k, v] of parsed.srv) merged.srv.set(k, v)
            for (const [k, v] of parsed.txt) merged.txt.set(k, v)
            for (const [k, v] of parsed.a) merged.a.set(k, v)
          } catch { /* a malformed packet from one responder must not abort discovery */ }
        },
      },
    })
    const query = buildQuery()
    sock.send(query, MDNS_PORT, MDNS_ADDR)
    // A second query mid-window catches devices that missed the first packet.
    await new Promise((r) => setTimeout(r, Math.floor(timeoutMs / 2)))
    try { sock.send(query, MDNS_PORT, MDNS_ADDR) } catch { /* */ }
    await new Promise((r) => setTimeout(r, Math.ceil(timeoutMs / 2)))
  } catch (err) {
    logger.warn(`[cast] discovery failed: ${err instanceof Error ? err.message : err}`)
  } finally {
    try { sock?.close() } catch { /* */ }
  }

  const devices: CastDevice[] = []
  for (const [instance, srv] of merged.srv) {
    const txt = merged.txt.get(instance) ?? {}
    const host = merged.a.get(srv.host) ?? null
    if (!host) continue // no A record resolved; can't reach it
    devices.push({
      id: txt['id'] ?? instance,
      name: txt['fn'] ?? instance.split('.')[0] ?? 'Cast device',
      host,
      port: srv.port,
      model: txt['md'] ?? null,
    })
  }
  // De-dupe by cast id (a device answers on multiple interfaces sometimes).
  const byId = new Map(devices.map((d) => [d.id, d]))
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}
