// Single source of truth (frontend) for decoding HTML/XML entities and stripping
// tags in text that reaches the client. Mirrors backend/src/lib/htmlText.ts — most
// decoding happens server-side at ingestion, but the few places the client handles
// raw text (e.g. caption VTT) should use this rather than a private copy.

function codePoint(n: number): string {
  try { return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '' } catch { return '' }
}

export function decodeEntities(s: string | null | undefined): string {
  if (!s) return s ?? ''
  if (!s.includes('&')) return s
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')  // last, so it never re-creates the entities decoded above
}

export function stripTags(html: string | null | undefined): string {
  return decodeEntities((html ?? '').replace(/<[^>]+>/g, '')).trim()
}
