// Single source of truth for turning HTML/XML-ish text from ANY external source
// (web search, RSS/Atom feeds, InnerTube, page scrapes, captions) into clean plain
// text. Everything that decodes entities or strips tags should import from here so
// behavior is consistent — no more per-file copies that each handle a different
// subset (and several of which silently dropped numeric entities like &#39;).
//
//   decodeEntities(s) — decode entities only (named + decimal + hex).
//   stripTags(html)   — remove all tags, decode, trim. For short snippets/titles.
//   stripHtml(html)   — drop script/style/svg blocks, tags → spaces, decode, collapse
//                       whitespace, trim. For article/body text where layout matters.

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

export function stripHtml(html: string | null | undefined): string {
  return decodeEntities(
    (html ?? '')
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim()
}
