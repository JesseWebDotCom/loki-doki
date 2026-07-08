// crypto.randomUUID is secure-context-only (https or localhost) — on a plain
// http LAN origin (e.g. http://172.19.x.x:5173 from another device) it's
// undefined and a bare call throws. crypto.getRandomValues works everywhere,
// so fall back to building a v4 UUID from it.
export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
