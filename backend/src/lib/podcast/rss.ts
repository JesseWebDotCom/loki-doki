// Podcast RSS parser — the feeds-app parser (lib/feeds/parse.ts) deliberately ignores
// audio enclosures and itunes:* tags, so podcasts get their own zero-dep regex parser
// with the same tiny helpers (duplicated per that file's stated convention). Items
// without an audio enclosure are skipped: a podcast feed's blog posts aren't episodes.

import { stripHtml, decodeEntities } from '@/lib/htmlText'

export interface ParsedPodcastEpisode {
  guid: string                 // dedup key: <guid> → enclosure URL → hash(title+pubDate)
  title: string
  description: string | null   // plaintext, capped
  link: string | null
  enclosureUrl: string
  enclosureType: string | null
  enclosureBytes: number | null
  imageUrl: string | null      // itunes:image href, episode-level
  durationSec: number | null   // itunes:duration (HH:MM:SS / MM:SS / seconds)
  publishedAt: number | null   // Unix ms
  explicit: number | null      // <itunes:explicit>: 1=explicit, 0=clean, null=unknown (inherits channel)
}

export interface ParsedPodcastFeed {
  title: string | null
  description: string | null
  link: string | null
  author: string | null
  imageUrl: string | null
  categories: string[]
  explicit: number | null      // channel-level <itunes:explicit>
  episodes: ParsedPodcastEpisode[]
}

/** <itunes:explicit> is self-declared by publishers: yes/true/explicit → 1, no/false/clean
 *  → 0, absent/other → null (unknown). Used for kid-safe podcast filtering. */
function parseExplicit(raw: string): number | null {
  const v = raw.trim().toLowerCase()
  if (!v) return null
  if (v === 'yes' || v === 'true' || v === 'explicit') return 1
  if (v === 'no' || v === 'false' || v === 'clean') return 0
  return null
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return m ? m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : ''
}

function attr(block: string, name: string, a: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*\\s${a}=["']([^"']*)["']`, 'i'))
  return m ? m[1]! : ''
}

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `h${(h >>> 0).toString(36)}`
}

/** itunes:duration comes as "1:02:33", "62:33", or plain seconds ("3753"). */
export function parseItunesDuration(raw: string): number | null {
  const v = raw.trim()
  if (!v) return null
  if (/^\d+(\.\d+)?$/.test(v)) {
    const sec = Math.round(Number(v))
    return sec > 0 ? sec : null
  }
  const parts = v.split(':').map(p => Number.parseInt(p, 10))
  if (parts.some(p => Number.isNaN(p) || p < 0)) return null
  let sec = 0
  for (const p of parts) sec = sec * 60 + p
  return sec > 0 ? sec : null
}

/** True when an enclosure's MIME (or URL extension, when MIME is junk) looks like audio. */
function isAudioEnclosure(url: string, mime: string): boolean {
  const m = mime.toLowerCase()
  if (m.startsWith('audio/')) return true
  if (m === 'application/ogg' || m === 'application/octet-stream' || m === '') {
    return /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac)(\?|$)/i.test(url)
  }
  return false
}

export function parsePodcastFeed(xml: string): ParsedPodcastFeed {
  // Channel header = everything before the first item.
  const headerEnd = xml.search(/<item[\s>]/i)
  const header = headerEnd > 0 ? xml.slice(0, headerEnd) : xml

  const title = stripHtml(tag(header, 'title')) || null
  const description = stripHtml(tag(header, 'itunes:summary') || tag(header, 'description')).slice(0, 1000) || null
  const link = tag(header, 'link') || null
  const author = stripHtml(tag(header, 'itunes:author')) || null
  // Channel art: itunes:image href beats the RSS <image><url> form.
  const imageUrl = decodeEntities(attr(header, 'itunes:image', 'href'))
    || tag(tag(header, 'image'), 'url')
    || null

  // <itunes:category text="News"> — may nest; collect unique text attrs.
  const categories: string[] = []
  for (const m of header.match(/<itunes:category\b[^>]*\btext=["']([^"']+)["']/gi) ?? []) {
    const text = decodeEntities(m.match(/text=["']([^"']+)["']/i)?.[1] ?? '')
    if (text && !categories.includes(text)) categories.push(text)
  }
  const feedExplicit = parseExplicit(tag(header, 'itunes:explicit'))

  const episodes: ParsedPodcastEpisode[] = []
  const blockRe = /<item[\s>]([\s\S]*?)<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1]!
    const epTitle = stripHtml(tag(block, 'title'))
    if (!epTitle) continue

    const encTag = block.match(/<enclosure\b[^>]*>/i)?.[0] ?? ''
    const enclosureUrl = decodeEntities(encTag.match(/\burl=["']([^"']+)["']/i)?.[1] ?? '')
    const enclosureType = encTag.match(/\btype=["']([^"']+)["']/i)?.[1] ?? ''
    if (!enclosureUrl || !/^https?:/i.test(enclosureUrl)) continue
    if (!isAudioEnclosure(enclosureUrl, enclosureType)) continue
    const lengthRaw = Number.parseInt(encTag.match(/\blength=["'](\d+)["']/i)?.[1] ?? '', 10)

    const rawPub = tag(block, 'pubDate') || tag(block, 'dc:date')
    const ts = rawPub ? Date.parse(rawPub) : NaN

    episodes.push({
      guid: tag(block, 'guid') || enclosureUrl || djb2(epTitle + rawPub),
      title: epTitle,
      description: stripHtml(tag(block, 'description') || tag(block, 'itunes:summary')).slice(0, 1000) || null,
      link: tag(block, 'link') || null,
      enclosureUrl,
      enclosureType: enclosureType || null,
      enclosureBytes: Number.isNaN(lengthRaw) || lengthRaw <= 0 ? null : lengthRaw,
      imageUrl: decodeEntities(attr(block, 'itunes:image', 'href')) || null,
      durationSec: parseItunesDuration(tag(block, 'itunes:duration')),
      publishedAt: Number.isNaN(ts) ? null : ts,
      // Episode explicit tag, inheriting the channel's when the item omits its own (common:
      // publishers often set it once at the channel level).
      explicit: parseExplicit(tag(block, 'itunes:explicit')) ?? feedExplicit,
    })
  }

  return { title, description, link, author, imageUrl, categories, explicit: feedExplicit, episodes }
}
