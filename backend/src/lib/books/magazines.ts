import { searchArchiveOrg } from './archiveOrg'
import { searchOpenLibrary } from './openLibrary'
import type { BookSearchResult } from './types'
import { createTtlCache } from '@/lib/ttlCache'

export interface MagazineCategory {
  label: string
  // URL key for the category page (kept stable / human-readable).
  topic: string
  // Internet Archive advanced-search terms. We lead with named, still-publishing
  // (often Creative-Commons) titles so `sort:date desc` surfaces genuinely recent
  // issues instead of the ancient public-domain periodicals a bare topic word
  // ("science magazine") drags up. Falls back to a broad topic term at the end.
  query: string
  // A plain keyword string for Open Library, whose `q` parser doesn't handle the
  // big boolean/quoted IA queries well. Defaults to the topic when omitted.
  olQuery?: string
}

export const MAGAZINE_CATEGORIES: MagazineCategory[] = [
  {
    label: 'PC & Gaming',
    topic: 'pc gaming',
    query:
      '(magpi OR hackspace OR "retro gamer" OR "pc gamer" OR "computer gaming world" OR "nintendo power" OR "game informer" OR "edge magazine" OR "full circle magazine" OR "linux format" OR "linux voice" OR "amiga" OR videogames OR "video game")',
    olQuery: 'video games computer gaming',
  },
  {
    label: 'Current Magazines',
    topic: 'magazine',
    query:
      '("full circle magazine" OR magpi OR hackspace OR "make magazine" OR "2600 magazine" OR "linux format" OR "linux magazine" OR "wired magazine" OR magazine)',
    olQuery: 'magazine',
  },
  {
    label: 'Comics & Anthologies',
    topic: 'comic',
    query: '(comic OR "comic book" OR "graphic novel" OR anthology OR "comics magazine")',
    olQuery: 'comic anthology',
  },
  {
    label: 'Science & Technology',
    topic: 'science',
    query:
      '("scientific american" OR "new scientist" OR "popular science" OR "popular mechanics" OR "make magazine" OR magpi OR hackspace OR "science news" OR nasa)',
    olQuery: 'science technology',
  },
  {
    label: 'Arts & Photography',
    topic: 'art photography',
    query:
      '("photography magazine" OR aperture OR juxtapoz OR "creative review" OR "art magazine" OR "digital photographer" OR "amateur photographer")',
    olQuery: 'art photography',
  },
  {
    label: 'Fashion & Beauty',
    topic: 'fashion beauty',
    query: '(vogue OR "harper\'s bazaar" OR cosmopolitan OR elle OR glamour OR "fashion magazine" OR beauty)',
    olQuery: 'fashion beauty',
  },
  {
    label: 'Business & Finance',
    topic: 'business finance',
    query: '(forbes OR fortune OR "business week" OR "the economist" OR entrepreneur OR "money magazine" OR "financial magazine")',
    olQuery: 'business finance',
  },
  {
    label: 'Kids & Family',
    topic: 'children kids',
    query:
      '("highlights magazine" OR "national geographic kids" OR "ranger rick" OR "kids magazine" OR "children\'s magazine" OR "family magazine")',
    olQuery: 'children kids',
  },
  {
    label: 'Travel & Lifestyle',
    topic: 'travel lifestyle',
    query: '("national geographic" OR "conde nast traveler" OR "travel magazine" OR "afar magazine" OR "lifestyle magazine")',
    olQuery: 'travel lifestyle',
  },
  {
    label: 'Sports & Outdoors',
    topic: 'sports outdoor',
    query: '("sports illustrated" OR "outdoor life" OR "field & stream" OR "sports magazine" OR "runner\'s world" OR "outside magazine")',
    olQuery: 'sports outdoor',
  },
  {
    label: 'Music & Entertainment',
    topic: 'music entertainment',
    query: '("rolling stone" OR billboard OR "spin magazine" OR nme OR "guitar world" OR "music magazine" OR "entertainment weekly")',
    olQuery: 'music entertainment',
  },
]

function categoryForTopic(topic: string): MagazineCategory | undefined {
  return MAGAZINE_CATEGORIES.find((category) => category.topic === topic)
}

function blendResults<T extends { source: string; sourceRef: string }>(groups: T[][], limit = 12): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  const maxLen = Math.max(0, ...groups.map((group) => group.length))

  for (let idx = 0; idx < maxLen && out.length < limit; idx++) {
    for (const group of groups) {
      const item = group[idx]
      if (!item) continue
      const key = `${item.source}:${item.sourceRef}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
      if (out.length >= limit) return out
    }
  }

  return out
}

function isMagazine(item: BookSearchResult): boolean {
  return item.contentType === 'magazine'
}

// Magazine shelves fan out to IA + Open Library on every landing visit; the feeds
// barely move, so cache each (topic, source-toggle) combination for a while.
const BROWSE_TTL_MS = 30 * 60 * 1000
const browseCache = createTtlCache<BookSearchResult[]>(BROWSE_TTL_MS)

function magazineSearch(topic: string, opts: { archive?: boolean; openLibrary?: boolean } = {}, page = 1): Promise<BookSearchResult[]> {
  return browseCache.getOrCompute(`${topic}:${opts.archive !== false}:${opts.openLibrary !== false}:${page}`, () => magazineSearchUncached(topic, opts, page))
}

async function magazineSearchUncached(topic: string, opts: { archive?: boolean; openLibrary?: boolean } = {}, page = 1): Promise<BookSearchResult[]> {
  const category = categoryForTopic(topic)
  // A named-title IA query for the shelf, plus a plain keyword query for Open Library.
  const iaQuery = category?.query ?? `(${topic}) AND (magazine OR periodical OR journal)`
  const olQuery = `${category?.olQuery ?? topic} magazine`
  // Pages past the first are IA-only: searchOpenLibrary has no page parameter, and
  // re-blending its same top hits would just produce duplicates.
  const [archive, openLibrary] = await Promise.all([
    opts.archive === false ? Promise.resolve([]) : searchArchiveOrg(iaQuery, page).catch(() => []),
    opts.openLibrary === false || page > 1 ? Promise.resolve([]) : searchOpenLibrary(olQuery, 'magazine').catch(() => []),
  ])
  // The IA query is already magazine-scoped by named titles, so we trust it rather
  // than re-filtering on the `contentType` heuristic — that heuristic drops current
  // CC titles (MagPi, HackSpace, Full Circle) whose metadata never says "magazine",
  // which is exactly why the shelves used to show only decades-old periodicals.
  return blendResults([archive, openLibrary.filter(isMagazine)], 30)
}

export async function browseMagazineByTopic(topic: string, limit = 12, opts: { archive?: boolean; openLibrary?: boolean } = {}): Promise<BookSearchResult[]> {
  return (await magazineSearch(topic, opts)).slice(0, limit)
}

export async function browseAllMagazineCategories(opts: { archive?: boolean; openLibrary?: boolean } = {}): Promise<{ category: MagazineCategory; results: BookSearchResult[] }[]> {
  return Promise.all(
    MAGAZINE_CATEGORIES.map(async (category) => ({ category, results: await browseMagazineByTopic(category.topic, 12, opts) })),
  )
}

export async function browseMagazineByTopicFull(topic: string, opts: { archive?: boolean; openLibrary?: boolean } = {}, page = 1): Promise<BookSearchResult[]> {
  return magazineSearch(topic, opts, page)
}
