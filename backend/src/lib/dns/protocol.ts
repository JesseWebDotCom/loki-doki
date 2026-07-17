// Minimal DNS wire-format helpers: just enough to read the queried name from a
// request and synthesize a block response. Anything we don't block is forwarded
// verbatim to an upstream resolver, so we never need to parse resource records.

export interface ParsedQuery {
  id: number
  name: string // lowercased, no trailing dot
  qtype: number
  qclass: number
  /** Byte length of the question section, so a block reply can echo it back. */
  questionEnd: number
}

/** Parse the header + first question. Returns null on anything malformed or on a
 *  packet with no questions (we forward those untouched rather than guess). */
export function parseQuery(buf: Uint8Array): ParsedQuery | null {
  if (buf.length < 12) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const id = view.getUint16(0)
  const qdcount = view.getUint16(4)
  if (qdcount < 1) return null

  const labels: string[] = []
  let offset = 12
  // No compression pointers appear in the question section of a query, so a plain
  // label walk is safe here.
  while (offset < buf.length) {
    const len = buf[offset]!
    if (len === 0) {
      offset += 1
      break
    }
    if (len > 63 || offset + 1 + len > buf.length) return null
    labels.push(new TextDecoder().decode(buf.subarray(offset + 1, offset + 1 + len)))
    offset += 1 + len
  }
  if (offset + 4 > buf.length) return null
  const qtype = view.getUint16(offset)
  const qclass = view.getUint16(offset + 2)
  return {
    id,
    name: labels.join('.').toLowerCase(),
    qtype,
    qclass,
    questionEnd: offset + 4,
  }
}

/** Build an authoritative-looking NXDOMAIN response echoing the request's question.
 *  Clients treat NXDOMAIN as "no such host" and give up cleanly — the standard
 *  sinkhole behavior for ad/tracker blocking. */
export function buildBlockedResponse(query: Uint8Array, parsed: ParsedQuery): Uint8Array {
  const out = new Uint8Array(parsed.questionEnd)
  out.set(query.subarray(0, parsed.questionEnd))
  const view = new DataView(out.buffer)
  // Flags: QR=1 (response), Opcode=0, AA=1, RD copied from request, RA=1, RCODE=3 (NXDOMAIN).
  const rd = (query[2]! & 0x01)
  view.setUint16(2, 0x8400 | (rd << 8) | 0x0003)
  view.setUint16(4, 1) // qdcount (echo the one question)
  view.setUint16(6, 0) // ancount
  view.setUint16(8, 0) // nscount
  view.setUint16(10, 0) // arcount
  return out
}
