// Common Sense Media parental content guide. No official API → find the review URL via
// web search, then scrape the review page. CSM renders its data as JSON-LD (age rating +
// review body) plus per-category severity rows whose filled dots are <i class="icon-circle-solid">.
// We read both; anything unparseable simply degrades (categories omitted, or the whole
// thing falls back to the search snippet). All fragility is isolated to this file.

import { webSearch } from '@/lib/webSearch'
import { stripHtml } from './rss'

// CSM category labels, in display order. We surface whichever rows we can parse.
const KNOWN_CATEGORIES = [
  'Educational Value',
  'Positive Messages',
  'Positive Role Models',
  'Diverse Representations',
  'Violence & Scariness',
  'Sex, Romance & Nudity',
  'Language',
  'Products & Purchases',
  'Drinking, Drugs & Smoking',
]

export interface ContentCategory {
  label: string
  rating?: number // 0–5 filled dots, when extractable
  detail?: string
}

export interface ContentRating {
  title: string
  url: string
  ageRating?: string // e.g. "13+"
  parentsNeedToKnow?: string
  categories: ContentCategory[]
  fallback: boolean // true when we couldn't parse structured fields
}

function findReviewUrl(results: { url: string }[]): string | null {
  for (const r of results) {
    if (/commonsensemedia\.org\/[a-z-]*reviews?\//i.test(r.url)) return r.url
  }
  for (const r of results) {
    if (/commonsensemedia\.org\//i.test(r.url) && /review/i.test(r.url)) return r.url
  }
  return null
}

interface JsonLdReview {
  name?: string
  age?: string
  reviewBody?: string
}

function extractJsonLdReview(html: string): JsonLdReview {
  const out: JsonLdReview = {}
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  const nodes: Record<string, unknown>[] = []
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]!.trim()) as unknown
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      for (const n of arr) {
        if (n && typeof n === 'object') {
          const obj = n as Record<string, unknown>
          if (Array.isArray(obj['@graph'])) nodes.push(...(obj['@graph'] as Record<string, unknown>[]))
          else nodes.push(obj)
        }
      }
    } catch {
      /* skip */
    }
  }
  for (const n of nodes) {
    const t = String(n['@type'] ?? '')
    if (/Review/i.test(t) || n['typicalAgeRange']) {
      if (!out.name && typeof n['name'] === 'string') out.name = (n['name'] as string).trim()
      const age = n['typicalAgeRange'] ?? n['contentRating']
      if (!out.age && typeof age === 'string') {
        const mm = String(age).match(/(\d{1,2})\+?/)
        if (mm) out.age = `${mm[1]}+`
      }
      if (!out.reviewBody && typeof n['reviewBody'] === 'string') out.reviewBody = stripHtml(n['reviewBody'] as string)
    }
  }
  return out
}

function labelVariants(label: string): string[] {
  return [label, label.replace(/&/g, '&amp;')]
}

// Find every byte offset where `needle` occurs in `hay`.
function allIndexesOf(hay: string, needle: string): number[] {
  const out: number[] = []
  let from = 0
  for (;;) {
    const i = hay.indexOf(needle, from)
    if (i < 0) break
    out.push(i)
    from = i + needle.length
  }
  return out
}

// Earliest position of any OTHER category label after `from` — bounds a category's window
// so its dot count can't bleed into the next category.
function nextCategoryPos(html: string, self: string, from: number): number {
  let best = html.length
  for (const label of KNOWN_CATEGORIES) {
    if (label === self) continue
    for (const v of labelVariants(label)) {
      const i = html.indexOf(v, from)
      if (i >= 0 && i < best) best = i
    }
  }
  return best
}

export function parseCategories(html: string): ContentCategory[] {
  const cats: ContentCategory[] = []
  for (const label of KNOWN_CATEGORIES) {
    // Scan ALL occurrences and pick the real rating row — the label closely followed by a
    // filled dot. The dots render ~230 chars after the label, so look within ~360. The
    // first occurrence is usually a JSON-LD/meta mention with no nearby dots.
    let chosen = -1
    for (const v of labelVariants(label)) {
      for (const i of allIndexesOf(html, v)) {
        if (html.slice(i, i + 360).includes('icon-circle-solid')) { chosen = i; break }
      }
      if (chosen >= 0) break
    }
    if (chosen < 0) continue
    const bound = nextCategoryPos(html, label, chosen + 20)
    // Filled dots carry the `active` modifier (`icon-circle-solid active`); empty ones are
    // bare `icon-circle-solid`. The filled count IS the 0–5 severity/quality rating.
    const dotWindow = html.slice(chosen, Math.min(chosen + 520, bound))
    const rating = (dotWindow.match(/icon-circle-solid active/g) ?? []).length
    // Detail lives in the rating__teaser span that follows the dots.
    let detail: string | undefined
    const teaserIdx = html.indexOf('rating__teaser', chosen)
    if (teaserIdx >= 0 && teaserIdx < bound) {
      const tStart = html.indexOf('>', teaserIdx) // skip past the opening tag
      if (tStart >= 0) {
        const text = stripHtml(html.slice(tStart + 1, Math.min(tStart + 1 + 400, bound))).replace(/\s+/g, ' ').trim()
        if (text && !text.includes('":') && text.length > 8) detail = text.slice(0, 160)
      }
    }
    cats.push({ label, rating: rating > 0 ? Math.min(rating, 5) : undefined, detail })
  }
  return cats
}

function regexAge(html: string): string | undefined {
  const m = html.match(/age\s*(\d{1,2})\s*\+/i)
  return m ? `${m[1]}+` : undefined
}

function parentsNeedToKnow(html: string): string | undefined {
  const m = html.match(/Parents need to know that([\s\S]{0,600}?)(?:<\/p>|<\/div>)/i)
  if (!m) return undefined
  const text = stripHtml(m[1]!).trim()
  return text.length > 30 ? `Parents need to know that ${text}`.slice(0, 400) : undefined
}

function titleFromHtml(html: string, query: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
  if (og) return stripHtml(og[1]!).replace(/\s*[-|]\s*Common Sense Media.*$/i, '').trim()
  const t = html.match(/<title>([^<]+)<\/title>/i)
  if (t) return stripHtml(t[1]!).replace(/\s*[-|]\s*Common Sense Media.*$/i, '').trim()
  return query
}

/**
 * Look up a movie/show/book/game/app on Common Sense Media. Returns best-effort structured
 * parental data, or null if no review page could be found at all.
 */
export async function commonSenseRating(query: string, timeoutMs = 7000): Promise<ContentRating | null> {
  const results = await webSearch(`${query} common sense media review`, 6, timeoutMs)
  const url = findReviewUrl(results)
  if (!url) return null

  let html: string
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaiPaiHome/1.0)', Accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(String(res.status))
    html = await res.text()
  } catch {
    const lead = results.find((r) => r.url === url) as { snippet?: string } | undefined
    return { title: query, url, categories: [], parentsNeedToKnow: lead?.snippet, fallback: true }
  }

  const ld = extractJsonLdReview(html)
  const title = ld.name || titleFromHtml(html, query)
  const ageRating = ld.age ?? regexAge(html)
  const categories = parseCategories(html)
  // Prefer the explicit "Parents need to know" paragraph; fall back to the review body.
  const pntk = parentsNeedToKnow(html) ?? (ld.reviewBody ? ld.reviewBody.slice(0, 400) : undefined)
  const fallback = !ageRating && !pntk && categories.length === 0

  return { title, url, ageRating, parentsNeedToKnow: pntk, categories, fallback }
}
