// Decode HTML/XML entities in YouTube display text (titles, channel/author names).
// Different sources encode differently: channel RSS feeds carry XML entities like
// `&amp;`, while InnerTube JSON and HTML scrapes carry `&#39;`, `&quot;`, etc. Left
// undecoded these render literally ("Foo &amp; Bar"). Apply at ingestion so stored
// and displayed text is clean.

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
    .replace(/&amp;/gi, '&')  // last, so it never re-creates the entities above
}
