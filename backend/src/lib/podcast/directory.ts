// Podcast directory providers — how users FIND real podcasts to subscribe to.
//
// Default: Apple's iTunes Search API — keyless, huge catalog, returns feed URLs
// directly, plus per-genre charts. Optional: PodcastIndex (trending + search) when an
// admin configures API keys; iTunes stays the fallback so browsing always works keyless.
// All calls are server-side (iTunes blocks browser CORS) and cached via lookupCache.

import { createHash } from 'node:crypto'
import { cachedLookup } from '@/lib/lookupCache'
import { getAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

export interface DirectoryResult {
  itunesId: number | null
  title: string
  author: string | null
  feedUrl: string | null      // null for chart rows (iTunes charts omit it — lookup on subscribe)
  artworkUrl: string | null
  genre: string | null
  episodeCount: number | null
  explicit: number | null     // 1=explicit, 0=clean, null=unknown — for kid-safe storefront filtering
}

const CACHE_NS = 'podcast-dir'
const SEARCH_TTL = 60 * 60 * 1000        // 1h
const CHART_TTL = 12 * 60 * 60 * 1000    // 12h
const LOOKUP_TTL = 24 * 60 * 60 * 1000   // 24h
const UA = 'MaiPaiHome/3.0 podcast-directory'

// Apple podcast genre ids (stable public taxonomy).
export const PODCAST_GENRES: { id: number; name: string }[] = [
  { id: 1489, name: 'News' },
  { id: 1303, name: 'Comedy' },
  { id: 1488, name: 'True Crime' },
  { id: 1324, name: 'Society & Culture' },
  { id: 1318, name: 'Technology' },
  { id: 1321, name: 'Business' },
  { id: 1533, name: 'Science' },
  { id: 1487, name: 'History' },
  { id: 1545, name: 'Sports' },
  { id: 1512, name: 'Health & Fitness' },
  { id: 1310, name: 'Music' },
  { id: 1301, name: 'Arts' },
  { id: 1309, name: 'TV & Film' },
  { id: 1305, name: 'Kids & Family' },
  { id: 1502, name: 'Leisure' },
  { id: 1314, name: 'Religion & Spirituality' },
]

interface ItunesItem {
  collectionId?: number
  collectionName?: string
  artistName?: string
  feedUrl?: string
  artworkUrl600?: string
  artworkUrl100?: string
  primaryGenreName?: string
  trackCount?: number
  collectionExplicitness?: string
  contentAdvisoryRating?: string
}

/** Map iTunes' explicitness fields to 1 (explicit) / 0 (clean) / null (unknown). */
function itunesExplicit(r: ItunesItem): number | null {
  const e = (r.collectionExplicitness ?? r.contentAdvisoryRating ?? '').toLowerCase()
  if (e === 'explicit') return 1
  if (e === 'cleaned' || e === 'notexplicit' || e === 'clean') return 0
  return null
}

function fromItunes(r: ItunesItem): DirectoryResult {
  return {
    itunesId: r.collectionId ?? null,
    title: r.collectionName ?? '',
    author: r.artistName ?? null,
    feedUrl: r.feedUrl ?? null,
    artworkUrl: r.artworkUrl600 ?? r.artworkUrl100 ?? null,
    genre: r.primaryGenreName ?? null,
    episodeCount: r.trackCount ?? null,
    explicit: itunesExplicit(r),
  }
}

async function fetchJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${new URL(url).hostname} responded ${res.status}`)
  return await res.json() as T
}

// ── PodcastIndex (optional, keyed) ────────────────────────────────────────────────

export async function podcastIndexKeys(): Promise<{ key: string; secret: string } | null> {
  const key = await getAppSetting('podcast.podcastindex_key') as string | null
  const secret = await getAppSetting('podcast.podcastindex_secret') as string | null
  return key && secret ? { key, secret } : null
}

export async function podcastIndexConfigured(): Promise<boolean> {
  return (await podcastIndexKeys()) !== null
}

async function piFetch<T>(path: string): Promise<T> {
  const keys = await podcastIndexKeys()
  if (!keys) throw new Error('PodcastIndex not configured')
  const date = String(Math.floor(Date.now() / 1000))
  const auth = createHash('sha1').update(keys.key + keys.secret + date).digest('hex')
  const res = await fetch(`https://api.podcastindex.org/api/1.0${path}`, {
    headers: {
      'User-Agent': UA,
      'X-Auth-Key': keys.key,
      'X-Auth-Date': date,
      Authorization: auth,
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`PodcastIndex responded ${res.status}`)
  return await res.json() as T
}

interface PiFeed {
  itunesId?: number | null
  title?: string
  author?: string
  url?: string
  image?: string
  artwork?: string
  categories?: Record<string, string> | null
  episodeCount?: number
  explicit?: boolean | number | null
}

function fromPi(f: PiFeed): DirectoryResult {
  return {
    itunesId: f.itunesId ?? null,
    title: f.title ?? '',
    author: f.author ?? null,
    feedUrl: f.url ?? null,
    artworkUrl: f.artwork || f.image || null,
    genre: f.categories ? Object.values(f.categories)[0] ?? null : null,
    episodeCount: f.episodeCount ?? null,
    explicit: f.explicit == null ? null : (f.explicit ? 1 : 0),
  }
}

// ── Public API ────────────────────────────────────────────────────────────────────

/** Search podcasts by term. PodcastIndex when configured, else iTunes. */
export async function searchPodcasts(term: string, limit = 25): Promise<DirectoryResult[]> {
  const q = term.trim()
  if (!q) return []
  const usePi = await podcastIndexConfigured()
  return cachedLookup(CACHE_NS, `search:${usePi ? 'pi' : 'it'}:${limit}:${q}`, SEARCH_TTL, async () => {
    if (usePi) {
      try {
        const data = await piFetch<{ feeds?: PiFeed[] }>(`/search/byterm?q=${encodeURIComponent(q)}&max=${limit}`)
        const results = (data.feeds ?? []).filter(f => f.url).map(fromPi)
        if (results.length) return results
      } catch (err) {
        logger.warn(`[podcast-dir] PodcastIndex search failed, falling back to iTunes: ${err}`)
      }
    }
    const data = await fetchJson<{ results?: ItunesItem[] }>(
      `https://itunes.apple.com/search?media=podcast&limit=${limit}&term=${encodeURIComponent(q)}`)
    return (data.results ?? []).map(fromItunes).filter(r => r.title)
  })
}

/** Genre charts ("Top Podcasts"). PodcastIndex trending when configured, else iTunes RSS
 *  charts (whose rows lack feedUrl — subscribing resolves it via lookupItunes). */
export async function chartPodcasts(genreId: number | null, limit = 40): Promise<{ results: DirectoryResult[]; provider: 'itunes' | 'podcastindex' }> {
  const usePi = await podcastIndexConfigured()
  if (usePi) {
    try {
      const genre = genreId ? PODCAST_GENRES.find(g => g.id === genreId) : null
      const cat = genre ? `&cat=${encodeURIComponent(genre.name)}` : ''
      const results = await cachedLookup(CACHE_NS, `trend:pi:${genreId ?? 'all'}:${limit}`, CHART_TTL, async () => {
        const data = await piFetch<{ feeds?: PiFeed[] }>(`/podcasts/trending?max=${limit}${cat}`)
        return (data.feeds ?? []).filter(f => f.url).map(fromPi)
      })
      if (results.length) return { results, provider: 'podcastindex' }
    } catch (err) {
      logger.warn(`[podcast-dir] PodcastIndex trending failed, falling back to iTunes: ${err}`)
    }
  }
  const results = await cachedLookup(CACHE_NS, `chart:it:${genreId ?? 'all'}:${limit}`, CHART_TTL, async () => {
    const genrePath = genreId ? `/genre=${genreId}` : ''
    const data = await fetchJson<{
      feed?: { entry?: Array<{
        id?: { attributes?: { 'im:id'?: string } }
        'im:name'?: { label?: string }
        'im:artist'?: { label?: string }
        'im:image'?: Array<{ label?: string }>
        category?: { attributes?: { label?: string } }
      }> }
    }>(`https://itunes.apple.com/us/rss/toppodcasts/limit=${limit}${genrePath}/json`)
    const entries = data.feed?.entry ?? []
    return entries.map((e): DirectoryResult => ({
      itunesId: e.id?.attributes?.['im:id'] ? Number(e.id.attributes['im:id']) : null,
      title: e['im:name']?.label ?? '',
      author: e['im:artist']?.label ?? null,
      feedUrl: null,  // charts omit it — resolved at subscribe time
      artworkUrl: e['im:image']?.at(-1)?.label ?? null,
      genre: e.category?.attributes?.label ?? null,
      episodeCount: null,
      explicit: null,  // the toppodcasts RSS feed carries no explicit flag per entry
    })).filter(r => r.title && r.itunesId)
  })
  return { results, provider: 'itunes' }
}

/** Resolve an iTunes collection id to its feed URL (needed when subscribing from charts). */
export async function lookupItunes(itunesId: number): Promise<DirectoryResult | null> {
  return cachedLookup(CACHE_NS, `lookup:${itunesId}`, LOOKUP_TTL, async () => {
    const data = await fetchJson<{ results?: ItunesItem[] }>(`https://itunes.apple.com/lookup?id=${itunesId}`)
    const r = data.results?.[0]
    return r?.feedUrl ? fromItunes(r) : null
  })
}

// ── Pre-subscribe preview ─────────────────────────────────────────────────────────

export interface DirectoryPreview {
  feedUrl: string
  title: string | null
  author: string | null
  description: string | null
  imageUrl: string | null
  link: string | null
  categories: string[]
  episodeCount: number
  episodes: Array<{ title: string; description: string | null; durationSec: number | null; publishedAt: number | null }>
}

const PREVIEW_TTL = 6 * 60 * 60 * 1000  // 6h — directory browsing detail, not the live feed

/** "What is this show about?" — fetch + parse the feed WITHOUT subscribing, so clicking
 *  a directory card shows description/categories/recent episodes before any commitment.
 *  Cached; the parse reuses exactly what subscribe would ingest, so preview == reality. */
export async function previewFeed(feedUrl: string): Promise<DirectoryPreview> {
  const { parsePodcastFeed } = await import('@/lib/podcast/rss')
  const { safeFetch } = await import('@/lib/ssrfGuard')
  // v2: key versioned when the payload shape/size changes, else stale cached previews
  // (e.g. the old 10-episode teaser) survive for a full TTL.
  return cachedLookup(CACHE_NS, `preview:v2:${feedUrl}`, PREVIEW_TTL, async () => {
    const res = await safeFetch(feedUrl, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    }, { timeoutMs: 15_000 })
    if (!res.ok) { res.body?.cancel().catch(() => {}); throw new Error(`Feed responded ${res.status}`) }
    const parsed = parsePodcastFeed(await res.text())
    // Enough backlog for the full-page preview's episode list, not just a teaser.
    const episodes = [...parsed.episodes]
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
      .slice(0, 50)
      .map(e => ({ title: e.title, description: e.description, durationSec: e.durationSec, publishedAt: e.publishedAt }))
    return {
      feedUrl,
      title: parsed.title,
      author: parsed.author,
      description: parsed.description,
      imageUrl: parsed.imageUrl,
      link: parsed.link,
      categories: parsed.categories,
      episodeCount: parsed.episodes.length,
      episodes,
    }
  })
}
