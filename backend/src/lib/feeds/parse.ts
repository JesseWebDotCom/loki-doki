// Unified RSS/Atom parser for the Feeds app. Handles RSS <item> and Atom <entry>.
// Zero-dep regex parsing, consistent with the briefing/youtube feed readers (whose tiny
// helpers are intentionally duplicated here rather than refactoring those working paths).

export interface ParsedEntry {
  guid: string                 // dedup key: <guid>/<id> → <link> → hash(title+pubDate)
  title: string
  url: string
  author: string | null
  summary: string | null       // plaintext, capped
  contentHtml: string | null   // raw <content:encoded>/<content> if present
  imageUrl: string | null
  publishedAt: number | null   // Unix ms
}

export interface ParsedFeed {
  title: string | null
  siteUrl: string | null
  entries: ParsedEntry[]
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return m ? m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : ''
}

function attr(block: string, name: string, a: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*\\s${a}=["']([^"']*)["']`, 'i'))
  return m ? m[1]! : ''
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

function upscaleImage(url: string): string {
  return url.replace(/(ichef\.bbci\.co\.uk\/(?:ace\/standard|news\/[a-z]+)\/)\d+(\/)/i, '$1800$2')
}

function extractImage(block: string): string | null {
  let best: string | undefined
  let bestW = -1
  for (const t of block.match(/<media:(?:content|thumbnail)\b[^>]*>/gi) ?? []) {
    const url = t.match(/\burl=["']([^"']+)["']/i)?.[1]
    if (!url || !/^https?:/i.test(url)) continue
    const w = Number(t.match(/\bwidth=["'](\d+)["']/i)?.[1] ?? '0')
    if (w >= bestW) { best = url; bestW = w }
  }
  if (!best) best = block.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i)?.[1]
  return best ? upscaleImage(best) : null
}

// Atom <link rel="alternate" href> (or the first <link href>); RSS uses a text <link>.
function atomLink(block: string): string {
  const alt = block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i)
    ?? block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["']/i)
  if (alt) return alt[1]!
  const any = block.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i)
  return any ? any[1]! : ''
}

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `h${(h >>> 0).toString(36)}`
}

export function parseFeedXml(xml: string): ParsedFeed {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml)

  // Feed-level title/site: take from the header (before the first item/entry).
  const headerEnd = xml.search(/<(item|entry)[\s>]/i)
  const header = headerEnd > 0 ? xml.slice(0, headerEnd) : xml
  const feedTitle = stripHtml(tag(header, 'title')) || null
  const siteUrl = isAtom ? (atomLink(header) || null) : (tag(header, 'link') || null)

  const blockRe = isAtom ? /<entry[\s>]([\s\S]*?)<\/entry>/gi : /<item[\s>]([\s\S]*?)<\/item>/gi
  const entries: ParsedEntry[] = []
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1]!
    const title = stripHtml(tag(block, 'title'))
    if (!title) continue

    const url = isAtom ? atomLink(block) : tag(block, 'link')
    const rawPub = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date')
    const ts = rawPub ? Date.parse(rawPub) : NaN
    const publishedAt = Number.isNaN(ts) ? null : ts

    const guidRaw = tag(block, 'guid') || tag(block, 'id') || url || djb2(title + rawPub)
    const author = tag(block, 'dc:creator') || tag(block, 'name') || stripHtml(tag(block, 'author')) || null
    const summaryRaw = tag(block, 'description') || tag(block, 'summary')
    const summary = summaryRaw ? stripHtml(stripHtml(summaryRaw)).slice(0, 280) || null : null
    const contentHtml = tag(block, 'content:encoded') || (isAtom ? tag(block, 'content') : '') || null

    entries.push({
      guid: guidRaw,
      title,
      url,
      author,
      summary,
      contentHtml: contentHtml || null,
      imageUrl: extractImage(block),
      publishedAt,
    })
  }

  return { title: feedTitle, siteUrl, entries }
}
