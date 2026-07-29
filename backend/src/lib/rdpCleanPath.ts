import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { logger } from '@/lib/logger'

// Server side of the RDCleanPath protocol spoken by the IronRDP WASM web client
// (ironrdp-wasm). The browser can't open raw TCP or do the RDP X.224/TLS bootstrap, so
// it hands us an RDCleanPath *request* (ASN.1 DER) carrying its X.224 connection PDU; we
// TCP-connect to the RDP server, forward the X.224 request, read the confirm, do the TLS
// handshake, extract the server cert chain, and hand it all back in an RDCleanPath
// *response*. After that the WebSocket carries the TLS-wrapped RDP stream, relayed here.
//
// Ported from electerm/ironrdp-wasm's example/lib/rdp-proxy.js (MIT). Hardened for our
// use: the destination is NOT taken from the client (SSRF), the caller passes the
// registry host/port this socket is bound to, and the client-supplied destination is
// ignored. NLA/CredSSP + the RDP credentials themselves are handled entirely by the WASM
// client in the browser; this proxy only bootstraps the transport.

const VERSION_1 = 3390 // 3389 + 1
const TAG_SEQUENCE = 0x30
const TAG_INTEGER = 0x02
const TAG_OCTET_STRING = 0x04
const TAG_UTF8STRING = 0x0c
const TAG_CTX = (n: number) => 0xa0 + n

// ── ASN.1 DER helpers ──

function derEncodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let temp = length
  while (temp > 0) { bytes.unshift(temp & 0xff); temp >>= 8 }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derWrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derEncodeLength(content.length), content])
}

function derEncodeInteger(value: number): Buffer {
  if (value === 0) return derWrap(TAG_INTEGER, Buffer.from([0]))
  const bytes: number[] = []
  let temp = value
  while (temp > 0) { bytes.unshift(temp & 0xff); temp >>= 8 }
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0)
  return derWrap(TAG_INTEGER, Buffer.from(bytes))
}

function derEncodeUtf8String(str: string): Buffer { return derWrap(TAG_UTF8STRING, Buffer.from(str, 'utf-8')) }
function derEncodeOctetString(buf: Buffer): Buffer { return derWrap(TAG_OCTET_STRING, buf) }
function derWrapContext(tagNum: number, content: Buffer): Buffer { return derWrap(TAG_CTX(tagNum), content) }

function derDecodeLength(buf: Buffer, offset: number): { length: number; bytesRead: number } {
  const first = buf[offset] ?? 0
  if (first < 0x80) return { length: first, bytesRead: 1 }
  const numBytes = first & 0x7f
  let length = 0
  for (let i = 0; i < numBytes; i++) length = (length << 8) | (buf[offset + 1 + i] ?? 0)
  return { length, bytesRead: 1 + numBytes }
}

interface Tlv { tag: number; value: Buffer; totalLength: number }
function derDecodeTLV(buf: Buffer, offset: number): Tlv {
  const tag = buf[offset] ?? 0
  const { length, bytesRead } = derDecodeLength(buf, offset + 1)
  const headerLen = 1 + bytesRead
  return { tag, value: buf.subarray(offset + headerLen, offset + headerLen + length), totalLength: headerLen + length }
}

function derDecodeInteger(buf: Buffer): number {
  let val = 0
  for (let i = 0; i < buf.length; i++) val = (val << 8) | (buf[i] ?? 0)
  return val
}

function derDecodeChildren(buf: Buffer): Tlv[] {
  const children: Tlv[] = []
  let offset = 0
  while (offset < buf.length) {
    const tlv = derDecodeTLV(buf, offset)
    children.push(tlv)
    offset += tlv.totalLength
  }
  return children
}

// ── RDCleanPath PDU parse/build ──

interface RDCleanPathRequest { destination: string | null; x224ConnectionRequest: Buffer | null }

function parseRDCleanPathRequest(data: Buffer): RDCleanPathRequest {
  const outer = derDecodeTLV(data, 0)
  if (outer.tag !== TAG_SEQUENCE) throw new Error(`Expected SEQUENCE, got 0x${outer.tag.toString(16)}`)
  let version: number | null = null
  let destination: string | null = null
  let x224ConnectionRequest: Buffer | null = null
  for (const child of derDecodeChildren(outer.value)) {
    const ctxTag = child.tag & 0x1f
    if (ctxTag === 0) version = derDecodeInteger(derDecodeTLV(child.value, 0).value)
    else if (ctxTag === 2) destination = derDecodeTLV(child.value, 0).value.toString('utf-8')
    else if (ctxTag === 6) x224ConnectionRequest = Buffer.from(derDecodeTLV(child.value, 0).value)
  }
  if (version !== VERSION_1) throw new Error(`Unsupported RDCleanPath version: ${version}`)
  if (!x224ConnectionRequest) throw new Error('Missing x224_connection_pdu in RDCleanPath request')
  return { destination, x224ConnectionRequest }
}

function buildRDCleanPathResponse(serverAddr: string, x224Response: Buffer, certChain: Buffer[]): Buffer {
  const parts: Buffer[] = []
  parts.push(derWrapContext(0, derEncodeInteger(VERSION_1)))
  parts.push(derWrapContext(6, derEncodeOctetString(x224Response)))
  const certSeq = derWrap(TAG_SEQUENCE, Buffer.concat(certChain.map((c) => derEncodeOctetString(c))))
  parts.push(derWrapContext(7, certSeq))
  parts.push(derWrapContext(9, derEncodeUtf8String(serverAddr)))
  return derWrap(TAG_SEQUENCE, Buffer.concat(parts))
}

function buildRDCleanPathError(errorCode: number, httpStatusCode?: number): Buffer {
  const errParts: Buffer[] = [derWrapContext(0, derEncodeInteger(errorCode))]
  if (httpStatusCode != null) errParts.push(derWrapContext(1, derEncodeInteger(httpStatusCode)))
  const errSeq = derWrap(TAG_SEQUENCE, Buffer.concat(errParts))
  return derWrap(TAG_SEQUENCE, Buffer.concat([derWrapContext(0, derEncodeInteger(VERSION_1)), derWrapContext(1, errSeq)]))
}

// ── TCP + X.224 + TLS + cert extraction ──

interface PeerCert { raw?: Buffer; fingerprint256?: string; issuerCertificate?: PeerCert }
function extractCertChain(peerCert: PeerCert | null): Buffer[] {
  const certs: Buffer[] = []
  if (!peerCert || !peerCert.raw) return certs
  const seen = new Set<string>()
  let current: PeerCert | undefined = peerCert
  while (current && current.raw) {
    const fp = current.fingerprint256 || current.raw.toString('hex')
    if (seen.has(fp)) break
    seen.add(fp)
    certs.push(Buffer.from(current.raw))
    current = current.issuerCertificate && current.issuerCertificate !== current ? current.issuerCertificate : undefined
  }
  return certs
}

function performRDPHandshake(host: string, port: number, x224Request: Buffer): Promise<{ x224Response: Buffer; certChain: Buffer[]; tlsSocket: TLSSocket }> {
  return new Promise((resolve, reject) => {
    const tcpSocket: Socket = netConnect({ host, port }, () => { tcpSocket.write(x224Request) })
    tcpSocket.once('error', (err) => reject(new Error(`TCP connection failed: ${err.message}`)))
    tcpSocket.once('data', (x224Response: Buffer) => {
      // A sync throw in this callback is NOT caught by the Promise: it unwinds through the
      // socket's emit into uncaughtException and kills the whole server (which is exactly
      // what tls.connect did when handed an IP-literal servername — RDP-to-IP crashed
      // production on 7/29). Everything here stays inside the try.
      try {
        if (x224Response.length === 0) { tcpSocket.destroy(); reject(new Error('RDP server closed without X.224 response')); return }
        tcpSocket.removeAllListeners('error')
        tcpSocket.removeAllListeners('data')
        const tlsSocket = tlsConnect({
          socket: tcpSocket,
          // SNI is DNS-names-only (RFC 6066); node throws on an IP literal, so omit it there.
          ...(isIP(host) ? {} : { servername: host }),
          rejectUnauthorized: false,
        }, () => {
          const certChain = extractCertChain(tlsSocket.getPeerCertificate(true) as unknown as PeerCert)
          resolve({ x224Response: Buffer.from(x224Response), certChain, tlsSocket })
        })
        tlsSocket.once('error', (err) => reject(new Error(`TLS handshake failed: ${err.message}`)))
      } catch (err) {
        tcpSocket.destroy()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    tcpSocket.setTimeout(15000, () => { tcpSocket.destroy(); reject(new Error('Connection timed out')) })
  })
}

// ── Controller adapted to the hono/Bun upgradeWebSocket handler shape ──

interface MinimalWs {
  send: (data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) => void
  close: (code?: number, reason?: string) => void
}

export interface RdpCleanPathController {
  /** Handle the browser's first frame (the RDCleanPath request), do the handshake, and start relaying. */
  onFirstMessage(data: ArrayBuffer | Uint8Array | string): Promise<void>
  /** Relay a subsequent browser frame (TLS-wrapped RDP) to the server. */
  onData(data: ArrayBuffer | Uint8Array | string): void
  close(): void
}

function toBuffer(data: ArrayBuffer | Uint8Array | string): Buffer {
  if (typeof data === 'string') return Buffer.from(data)
  return Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data))
}

export function createRdpCleanPath(ws: MinimalWs, host: string, port: number): RdpCleanPathController {
  let tlsSocket: TLSSocket | null = null
  const preRelay: Buffer[] = []
  let closed = false

  return {
    async onFirstMessage(data) {
      try {
        const request = parseRDCleanPathRequest(toBuffer(data))
        // Deliberately ignore request.destination, connect only to the registry host.
        const { x224Response, certChain, tlsSocket: sock } = await performRDPHandshake(host, port, request.x224ConnectionRequest!)
        if (closed) { sock.destroy(); return }
        tlsSocket = sock
        sock.on('data', (d: Buffer) => { try { ws.send(new Uint8Array(d)) } catch { /* client gone */ } })
        sock.on('end', () => { try { ws.close() } catch { /* closed */ } })
        sock.on('error', (err) => { logger.warn(`[rdp] tls error ${host}:${port}: ${err.message}`); try { ws.close() } catch { /* closed */ } })
        ws.send(new Uint8Array(buildRDCleanPathResponse(`${host}:${port}`, x224Response, certChain)))
        for (const b of preRelay) sock.write(b)
        preRelay.length = 0
      } catch (err) {
        logger.warn(`[rdp] RDCleanPath handshake failed ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`)
        try { ws.send(new Uint8Array(buildRDCleanPathError(1, 502))) } catch { /* ignore */ }
        try { ws.close(1011, 'rdp handshake failed') } catch { /* ignore */ }
      }
    },
    onData(data) {
      const buf = toBuffer(data)
      if (tlsSocket && !tlsSocket.destroyed) { try { tlsSocket.write(buf) } catch { /* gone */ } }
      else preRelay.push(buf)
    },
    close() { closed = true; try { tlsSocket?.destroy() } catch { /* gone */ } },
  }
}
