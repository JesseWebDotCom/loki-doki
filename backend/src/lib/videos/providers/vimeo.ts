// Vimeo provider. The official API powers browse, search, channels, and creator pages.
// With an admin API token (free at developer.vimeo.com/apps, personal access token with
// the public scope) it authenticates as usual; without one it borrows the anonymous
// viewer JWT Vimeo's own web client uses (vimeo.com/_next/viewer → `Authorization: jwt`,
// public scope, ~15 min TTL) — full public API keyless, including stats.plays view
// counts. That's undocumented plumbing, so every surface keeps the old RSS/oEmbed
// scrape path as its degradation floor if the JWT ever stops working.

import { cachedLookup, cachedLookupStale } from '@/lib/lookupCache'
import { getAppSetting } from '@/lib/settings'
import type { VideoProvider } from '@/lib/videos/provider'
import type { Creator, Pager, VideoItem } from '@/lib/videos/types'

export const VIMEO_TOKEN_KEY = 'videos.vimeo_token'

// Longer than feed.ts's 15-min warmBrowseCaches poll interval, so a warmed category/channel
// listing never goes stale before the next poll refreshes it — otherwise whoever hits a
// category in that gap eats a live ~7s fetch instead of the cache the poller just built.
const LIST_TTL = 20 * 60_000
const ITEM_TTL = 10 * 60_000
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const VIDEO_ID = /^\d{6,12}$/
const CHANNEL_ID = /^[a-z0-9]+$/i
// A Vimeo username/user-id (creator identifier): letters/digits/underscore/hyphen, matches
// both a numeric user id (token-path apiToItem) and a profile slug like "milkyeyes"
// (keyless-path oEmbed/RSS resolution) — Vimeo's /users/{id} API accepts either form.
const VIMEO_USER_ID = /^[\w-]{1,64}$/
// Reserved top-level Vimeo paths that look like a bare "vimeo.com/<slug>" profile URL but
// aren't one — matchUrl excludes these so pasting e.g. a search link doesn't misresolve.
const RESERVED_VIMEO_PATHS = new Set(['watch', 'upload', 'log_in', 'join', 'search', 'categories', 'ondemand', 'help', 'settings', 'channels', 'video', 'stats', 'purchases', 'notifications', 'messages'])

// Staff Picks is Vimeo's editorial channel, not a real category — kept as its own chip
// (first in the row) and reached via /channels, same as before. Verified to serve RSS.
const VIMEO_CHANNELS: Record<string, { label: string; slug: string }> = {
  staffpicks: { label: 'Staff Picks', slug: 'staffpicks' },
}

// Vimeo's real category taxonomy (GET /categories, live-verified: 10 top-level, keyless
// via the viewer JWT). Hardcoded like VIMEO_CHANNELS above — this list changes rarely
// enough that a live fetch on every browseFeeds read isn't worth the round trip.
const VIMEO_CATEGORIES: Record<string, { label: string; slug: string }> = {
  animation: { label: 'Animation', slug: 'animation' },
  documentary: { label: 'Documentary', slug: 'documentary' },
  comedy: { label: 'Comedy', slug: 'comedy' },
  music: { label: 'Music', slug: 'music' },
  travel: { label: 'Travel', slug: 'travel' },
  experimental: { label: 'Experimental', slug: 'experimental' },
  sports: { label: 'Sports', slug: 'sports' },
  narrative: { label: 'Narrative', slug: 'narrative' },
  brandedcontent: { label: 'Branded Content', slug: 'brandedcontent' },
  adsandcommercials: { label: 'Ads and Commercials', slug: 'adsandcommercials' },
}

export async function getVimeoToken(): Promise<string | null> {
  const v = await getAppSetting(VIMEO_TOKEN_KEY)
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

interface VimeoApiVideo {
  uri?: string
  name?: string
  description?: string
  duration?: number
  release_time?: string
  pictures?: { sizes?: Array<{ width?: number; link?: string }> }
  stats?: { plays?: number | null }
  user?: { uri?: string; name?: string; pictures?: { sizes?: Array<{ link?: string }> } }
  width?: number
  height?: number
  /** Vimeo's self-labels: 'safe' | 'unrated' | 'nudity' | 'violence' | 'drugs' | 'language' | 'advertisement' */
  content_rating?: string[]
  /** Present on the default (unfiltered) /videos/{id} fields — no extra request needed. */
  metadata?: { connections?: { likes?: { total?: number | null }; comments?: { total?: number | null } } }
}

const compactNumber = (n: number): string => Intl.NumberFormat('en', { notation: 'compact' }).format(n)

// Anonymous viewer JWT (the keyless auth described in the header comment). Cached
// in-memory well under its ~15 min TTL; a 401 in vimeoApi drops it so the next call
// fetches a fresh one.
let viewerJwt: { token: string; expiresAt: number } | null = null
async function getViewerJwt(): Promise<string | null> {
  if (viewerJwt && viewerJwt.expiresAt > Date.now()) return viewerJwt.token
  try {
    const res = await fetch('https://vimeo.com/_next/viewer', {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const data = await res.json() as { jwt?: string }
    if (!data.jwt) return null
    viewerJwt = { token: data.jwt, expiresAt: Date.now() + 8 * 60_000 }
    return data.jwt
  } catch { return null }
}

async function vimeoApi<T>(path: string, ttl: number): Promise<T> {
  return cachedLookup('vimeo', path, ttl, async () => {
    const token = await getVimeoToken()
    const auth = token ? `Bearer ${token}` : await getViewerJwt().then((j) => (j ? `jwt ${j}` : null))
    if (!auth) throw new Error('Vimeo API unavailable (viewer session fetch failed and no API token configured)')
    const res = await fetch(`https://api.vimeo.com${path}`, {
      headers: {
        Authorization: auth,
        Accept: 'application/vnd.vimeo.*+json;version=3.4',
        ...(token ? {} : { 'User-Agent': BROWSER_UA }),
      },
    })
    if (res.status === 401 && !token) viewerJwt = null
    if (!res.ok) throw new Error(`vimeo ${res.status} for ${path}`)
    return res.json() as Promise<T>
  })
}

function apiToItem(v: VimeoApiVideo): VideoItem | null {
  const id = v.uri?.split('/').pop()
  if (!id || !VIDEO_ID.test(id)) return null
  const thumb = v.pictures?.sizes?.reduce<{ width: number; link: string } | null>((best, s) =>
    s.link && (s.width ?? 0) > (best?.width ?? 0) && (s.width ?? 0) <= 1280
      ? { width: s.width ?? 0, link: s.link } : best, null)
  return {
    source: 'vimeo',
    id,
    url: `https://vimeo.com/${id}`,
    title: v.name ?? 'Vimeo video',
    creator: v.user?.name ? {
      id: v.user.uri?.split('/').pop() ?? '',
      name: v.user.name,
      avatarUrl: v.user.pictures?.sizes?.at(-1)?.link ?? null,
    } : null,
    thumbnailUrl: thumb?.link ?? null,
    durationSec: v.duration ?? null,
    publishedAt: v.release_time ? Date.parse(v.release_time) : null,
    viewsText: typeof v.stats?.plays === 'number'
      ? `${Intl.NumberFormat('en', { notation: 'compact' }).format(v.stats.plays)} plays` : null,
    // Of Vimeo's self-labels only nudity maps to the hub's adult gating (violence/drugs/
    // language are content advisories, not adult content; porn isn't allowed on Vimeo).
    isAdult: !!v.content_rating?.includes('nudity'),
    vertical: !!(v.width && v.height && v.height > v.width),
  }
}

/** Compact relative age for comment timestamps ("3d ago"). */
function relAge(iso?: string): string | null {
  const ms = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(ms)) return null
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

// 50/page (Vimeo's API allows up to 100): a denser popular/trending shelf and a meatier
// first page for the "More to explore" grid before it has to fetch again.
function pageParams(cursor?: string | null): string {
  const page = cursor ? Math.max(1, parseInt(cursor, 10) || 1) : 1
  return `page=${page}&per_page=50`
}

function listToPager(data: { data?: VimeoApiVideo[]; paging?: { next?: string | null } }, cursor?: string | null): Pager<VideoItem> {
  const items = (data.data ?? []).map(apiToItem).filter((x): x is VideoItem => x !== null)
  const page = cursor ? parseInt(cursor, 10) || 1 : 1
  return { items, cursor: data.paging?.next ? String(page + 1) : null }
}

/** Keyless listings via Vimeo's native RSS (one ~300ms fetch: title, link with id,
 *  thumbnail, duration, pubDate) — far cheaper than yt-dlp + per-item oEmbed. */
async function vimeoRssItems(feedPath: string, ttl: number): Promise<VideoItem[]> {
  return cachedLookup('vimeo:rss', feedPath, ttl, async () => {
    const res = await fetch(`https://vimeo.com${feedPath}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`vimeo rss ${res.status} for ${feedPath}`)
    const xml = await res.text()
    const items: VideoItem[] = []
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = m[1]!
      const link = /<link>([^<]+)<\/link>/.exec(block)?.[1] ?? ''
      const id = link.split('/').pop() ?? ''
      if (!VIDEO_ID.test(id)) continue
      const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1]?.trim() ?? 'Vimeo video'
      const thumb = /<media:thumbnail[^>]*url="([^"]+)"/.exec(block)?.[1] ?? null
      const duration = /<media:content[^>]*duration="(\d+)"/.exec(block)?.[1]
      const pub = /<pubDate>([^<]+)<\/pubDate>/.exec(block)?.[1]
      // Every RSS item carries the uploader in <media:credit role="author">; fall back to a
      // leading "by …" line in the description only if that's somehow absent.
      const credit = /<media:credit[^>]*>([^<]+)<\/media:credit>/.exec(block)?.[1]?.trim()
        || /<description>(?:\s*by\s+)([^.<]{2,60})/i.exec(block)?.[1]?.trim()
      items.push({
        source: 'vimeo',
        id,
        url: `https://vimeo.com/${id}`,
        title: title.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'"),
        creator: credit ? { id: '', name: credit.replace(/&amp;/g, '&') } : null,
        thumbnailUrl: thumb,
        durationSec: duration ? parseInt(duration, 10) : null,
        publishedAt: pub ? Date.parse(pub) : null,
      })
    }
    return items
  })
}

const PROFILE_TTL = 24 * 60 * 60_000

async function vimeoOembed(videoId: string): Promise<{ author_url?: string; author_name?: string } | null> {
  return cachedLookup('vimeo:oembed-raw', videoId, ITEM_TTL, async () => {
    const res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${videoId}`)}`, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    return res.json() as Promise<{ author_url?: string; author_name?: string }>
  })
}

/** Scrape a keyless user profile page for name/avatar/bio (its OpenGraph tags) — used both
 *  for a full creator page and, via resolveAuthorProfile below, per-card avatar resolution. */
async function scrapeVimeoProfile(slug: string): Promise<{ name: string | null; avatarUrl: string | null; description: string | null } | null> {
  return cachedLookup('vimeo:profile-page', slug, PROFILE_TTL, async () => {
    try {
      const res = await fetch(`https://vimeo.com/${slug}`, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(8_000) })
      if (!res.ok) return null
      const html = await res.text()
      const unescape = (s: string) => s.replace(/&amp;/g, '&')
      const name = /<meta property="og:title" content="([^"]+)"/.exec(html)?.[1]
      const avatarUrl = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1]
      const description = /<meta property="og:description" content="([^"]*)"/.exec(html)?.[1]
      return { name: name ? unescape(name) : null, avatarUrl: avatarUrl ? unescape(avatarUrl) : null, description: description ? unescape(description) : null }
    } catch { return null }
  })
}

interface VimeoAuthorProfile { slug: string | null; avatarUrl: string | null }

// Keyless creator id/avatar: the RSS feed's <media:credit> is a display name only — no
// profile slug, so there's no id or avatar to be had from RSS alone (and without a real id,
// Follow has nothing to send — externalId ends up '' and the request 400s). Resolving both
// needs two hops: oEmbed for this video gives the uploader's profile URL (author_url slug),
// then that profile page's og:image is their real avatar. Both steps cached hard (rarely
// change) and always run off the request path — a browse call must never pay two extra
// fetches per card, so cards render immediately without one and it fills in on the next
// load once the background warm below completes (same "grows as it warms" idiom as
// TikTok's own avatar resolution).
async function resolveAuthorProfile(videoId: string): Promise<VimeoAuthorProfile> {
  return cachedLookup('vimeo:creator-profile', videoId, PROFILE_TTL, async () => {
    const oembed = await vimeoOembed(videoId).catch(() => null)
    const slug = oembed?.author_url?.split('/').filter(Boolean).pop() ?? null
    if (!slug) return { slug: null, avatarUrl: null }
    const profile = await scrapeVimeoProfile(slug).catch(() => null)
    return { slug, avatarUrl: profile?.avatarUrl ?? null }
  })
}
const profileWarming = new Set<string>()
function warmAuthorProfile(videoId: string): void {
  if (profileWarming.has(videoId)) return
  profileWarming.add(videoId)
  void resolveAuthorProfile(videoId).catch(() => {}).finally(() => profileWarming.delete(videoId))
}
/** Stale-read every item's creator id/avatar (never blocks); kicks a background resolve on
 *  a miss. Populating a real id (the profile slug) is what makes Follow work from a card. */
async function stampCreatorInfo(items: VideoItem[]): Promise<VideoItem[]> {
  return Promise.all(items.map(async (it) => {
    if (!it.creator) return it
    const cached = await cachedLookupStale<VimeoAuthorProfile>('vimeo:creator-profile', it.id)
    if (!cached.fresh) warmAuthorProfile(it.id)
    if (!cached.value?.slug) return it
    return { ...it, creator: { ...it.creator, id: cached.value.slug, avatarUrl: cached.value.avatarUrl ?? it.creator.avatarUrl } }
  }))
}

/** Keyless item metadata via oEmbed (title/author/thumbnail/duration). `author_url` gives
 *  the uploader's real profile slug — used as creator.id so Follow works from the watch
 *  page (an empty id there is exactly what used to 400 on "source and externalId required"). */
async function oembedItem(id: string): Promise<(VideoItem & { description?: string | null }) | null> {
  return cachedLookup('vimeo:oembed', id, ITEM_TTL, async () => {
    const res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}`)
    if (!res.ok) return null
    const o = await res.json() as { title?: string; author_name?: string; author_url?: string; thumbnail_url?: string; duration?: number; width?: number; height?: number }
    const authorId = o.author_url?.split('/').filter(Boolean).pop() ?? ''
    return {
      source: 'vimeo' as const,
      id,
      url: `https://vimeo.com/${id}`,
      title: o.title ?? 'Vimeo video',
      creator: o.author_name ? { id: authorId, name: o.author_name } : null,
      thumbnailUrl: o.thumbnail_url ?? null,
      durationSec: o.duration ?? null,
      vertical: !!(o.width && o.height && o.height > o.width),
    }
  })
}

export const vimeoProvider: VideoProvider = {
  source: 'vimeo',
  label: 'Vimeo',
  capabilities: {
    browse: true,           // keyless via viewer JWT; a token is an optional stability hedge
    search: true,
    creators: true,
    comments: true,
    live: false,
    downloadKinds: ['audio', 'video'],
    authConfig: 'apiKey',
    related: true,
  },
  // Trending needs API access (filter=trending) — available with a token or the viewer
  // JWT, i.e. essentially always; it drops off only when both are unavailable and the
  // RSS floor is all that's left.
  discovery: ['popular', 'trending'],
  async resolveDiscovery() {
    if (await getVimeoToken()) return ['popular', 'trending']
    return (await getViewerJwt()) ? ['popular', 'trending'] : ['popular']
  },
  browseFeeds: [
    ...Object.entries(VIMEO_CHANNELS).map(([id, ch]) => ({ id, label: ch.label })),
    ...Object.entries(VIMEO_CATEGORIES).map(([id, cat]) => ({ id, label: cat.label })),
  ],

  async status() {
    // Everything works keyless via the viewer JWT; a token is just a stability hedge
    // against that internal mechanism changing, so the source is configured either way.
    const hasToken = !!(await getVimeoToken())
    return hasToken
      ? { configured: true }
      : { configured: true, note: 'Optional: a free Vimeo API token (developer.vimeo.com/apps) makes browsing and search more reliable.' }
  },

  matchUrl(url) {
    const host = url.hostname.replace(/^www\.|^player\./, '')
    if (host !== 'vimeo.com') return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'video' && parts[1] && VIDEO_ID.test(parts[1])) return { kind: 'video', id: parts[1] }
    if (parts[0] && VIDEO_ID.test(parts[0])) return { kind: 'video', id: parts[0] }
    if (parts[0] === 'channels' && parts[1] && CHANNEL_ID.test(parts[1])) return { kind: 'creator', id: parts[1] }
    // A bare vimeo.com/<username> is a creator's own profile — the common case when
    // pasting a creator link (vs. the channels/ prefix above, a curated Vimeo channel).
    if (parts.length === 1 && VIMEO_USER_ID.test(parts[0]!) && !RESERVED_VIMEO_PATHS.has(parts[0]!.toLowerCase())) {
      return { kind: 'creator', id: parts[0]! }
    }
    return null
  },

  async browse({ feed, cursor }) {
    // Trending uses Vimeo's real ranking; Staff Picks uses its channel; every other chip
    // is a real Vimeo category via /categories/{slug}/videos, sorted by plays so the deep
    // catalog (hundreds of thousands of videos per category) surfaces the popular ones
    // first. The default "popular" differs by auth: a bare /videos?sort=plays needs a
    // real token (the viewer JWT gets a 400 — the endpoint demands a query param), so
    // keyless popular is the Staff Picks channel via the API (still carries stats.plays).
    const category = feed ? VIMEO_CATEGORIES[feed] : undefined
    const path = feed === 'trending'
      ? `/videos?filter=trending&${pageParams(cursor)}`
      : feed && VIMEO_CHANNELS[feed]
        ? `/channels/${VIMEO_CHANNELS[feed]!.slug}/videos?${pageParams(cursor)}&sort=added`
        : category
          ? `/categories/${category.slug}/videos?${pageParams(cursor)}&sort=plays`
          : (await getVimeoToken())
            ? `/videos?sort=plays&direction=desc&${pageParams(cursor)}`
            : `/channels/${VIMEO_CHANNELS['staffpicks']!.slug}/videos?${pageParams(cursor)}&sort=added`
    try {
      const data = await vimeoApi<{ data?: VimeoApiVideo[]; paging?: { next?: string | null } }>(path, LIST_TTL)
      return listToPager(data, cursor)
    } catch {
      // API floor: native RSS. Categories don't have one, only channels do, so any
      // category-feed failure (or plain outage) falls back to the Staff Picks RSS —
      // single page, no view counts.
      if (cursor) return { items: [], cursor: null }
      const channel = (feed && VIMEO_CHANNELS[feed]) ? VIMEO_CHANNELS[feed]! : VIMEO_CHANNELS['staffpicks']!
      const items = await vimeoRssItems(`/channels/${channel.slug}/videos/rss`, LIST_TTL)
      return { items: await stampCreatorInfo(items), cursor: null }
    }
  },

  async search(q, { cursor }) {
    const data = await vimeoApi<{ data?: VimeoApiVideo[]; paging?: { next?: string | null } }>(
      `/videos?query=${encodeURIComponent(q)}&${pageParams(cursor)}`, LIST_TTL)
    return listToPager(data, cursor)
  },

  // `id` is a creator's own Vimeo user id/username (a numeric id from apiToItem's token
  // path, or a profile slug like "milkyeyes" resolved keyless via oEmbed) — almost every
  // follow is a person's own upload feed, not one of the curated VIMEO_CHANNELS categories
  // (those are reached through browse({feed}) instead and never need a creator page).
  async getCreator(id, cursor) {
    if (!VIMEO_USER_ID.test(id)) throw new Error('invalid vimeo creator')
    try {
      const [info, listing] = await Promise.all([
        vimeoApi<{ name?: string; bio?: string; pictures?: { sizes?: Array<{ link?: string }> }; metadata?: { connections?: { followers?: { total?: number } } } }>(
          `/users/${id}`, 60 * 60_000),
        vimeoApi<{ data?: VimeoApiVideo[]; paging?: { next?: string | null } }>(
          `/users/${id}/videos?${pageParams(cursor)}&sort=date`, LIST_TTL),
      ])
      const creator: Creator = {
        source: 'vimeo',
        kind: 'user',
        id,
        name: info.name ?? id,
        avatarUrl: info.pictures?.sizes?.at(-1)?.link ?? null,
        description: info.bio ?? null,
        subscriberText: info.metadata?.connections?.followers?.total != null
          ? `${Intl.NumberFormat('en', { notation: 'compact' }).format(info.metadata.connections.followers.total)} followers` : null,
      }
      return { creator, videos: listToPager(listing, cursor) }
    } catch { /* fall through to the scrape floor */ }
    // API floor: scrape the profile page for name/avatar/bio, its RSS for uploads (single page).
    const [profile, items] = await Promise.all([
      scrapeVimeoProfile(id),
      cursor ? Promise.resolve([]) : vimeoRssItems(`/${id}/videos/rss`, LIST_TTL),
    ])
    const creator: Creator = {
      source: 'vimeo',
      kind: 'user',
      id,
      name: profile?.name ?? id,
      avatarUrl: profile?.avatarUrl ?? null,
      description: profile?.description ?? null,
    }
    return { creator, videos: { items, cursor: null } }
  },

  async getItem(id) {
    if (!VIDEO_ID.test(id)) return null
    const v = await vimeoApi<VimeoApiVideo>(`/videos/${id}`, ITEM_TTL).catch(() => null)
    const apiItem = v && apiToItem(v)
    if (apiItem) {
      const conn = v!.metadata?.connections
      const likes = conn?.likes?.total
      const comments = conn?.comments?.total
      return {
        ...apiItem,
        description: v!.description ?? null,
        likesText: typeof likes === 'number' ? `${compactNumber(likes)} likes` : null,
        commentsCount: typeof comments === 'number' ? compactNumber(comments) : null,
      }
    }
    // API path failed (private/deleted, or a transient error) — fall through to the
    // scrape metadata + minimal fallback below rather than 404ing a maybe-playable video.
    // oEmbed metadata (title/author/thumbnail/duration). oEmbed is IP-rate-limited
    // and can hard-block a whole network, which would 404 EVERY Vimeo video even though the
    // iframe player still works. So a metadata miss degrades to a minimal item (id is enough
    // for getPlayback's embed) instead of null — the watch page renders and plays, and Vimeo
    // itself shows an "unavailable" notice for the rare genuinely-dead video.
    const item = (await oembedItem(id).catch(() => null)) ?? {
      source: 'vimeo' as const,
      id,
      url: `https://vimeo.com/${id}`,
      title: 'Vimeo video',
      creator: null,
      thumbnailUrl: null,
      durationSec: null,
      description: null,
    }
    // Stamp the avatar the same stale-read/background-warm way as browse cards — the watch
    // page's own creator header (WatchPage.tsx) renders item.creator.avatarUrl directly, and
    // oEmbed alone never carries one.
    const [stamped] = await stampCreatorInfo([item])
    return { ...stamped!, description: item.description }
  },

  async getComments(id) {
    if (!VIDEO_ID.test(id)) return []
    const data = await vimeoApi<{ data?: Array<{ user?: { name?: string }; text?: string; created_on?: string }> }>(
      `/videos/${id}/comments?page=1&per_page=30&fields=user.name,text,created_on`, ITEM_TTL).catch(() => null)
    return (data?.data ?? [])
      .filter((cm) => cm.text)
      .map((cm) => ({ author: cm.user?.name ?? 'Anonymous', text: cm.text!, likes: null, publishedText: relAge(cm.created_on) }))
  },

  async getRelated(id) {
    if (!VIDEO_ID.test(id)) return []
    const data = await vimeoApi<{ data?: VimeoApiVideo[] }>(
      `/videos/${id}/videos?filter=related&page=1&per_page=15`, LIST_TTL).catch(() => null)
    return (data?.data ?? []).map(apiToItem).filter((x): x is VideoItem => x !== null)
  },

  // Vimeo auto-generates English captions for most uploads and the texttrack's signed CDN
  // link fetches with no auth — one API call + one small text fetch, vs the ~10s yt-dlp
  // subtitle path the transcript resolver otherwise pays.
  async getCaptions(id) {
    if (!VIDEO_ID.test(id)) return null
    return cachedLookup('vimeo:captions', id, 24 * 60 * 60_000, async () => {
      const tracks = await vimeoApi<{ data?: Array<{ language?: string; link?: string; active?: boolean }> }>(
        `/videos/${id}/texttracks`, ITEM_TTL)
      const usable = (tracks.data ?? []).filter((t) => t.link && t.active !== false)
      const track = usable.find((t) => t.language?.startsWith('en')) ?? usable[0]
      if (!track?.link) return null
      const res = await fetch(track.link, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return null
      const vtt = await res.text()
      return vtt.startsWith('WEBVTT') ? vtt : null
    })
  },

  async getPlayback(id) {
    if (!VIDEO_ID.test(id)) throw new Error('no playable stream for this video')
    // Play via Vimeo's official embed player (an <iframe>): instant, no yt-dlp. Replaces the
    // old yt-dlp -J resolve + progressive byte-proxy, which worked but paid yt-dlp's ~10s
    // cold start on every click. yt-dlp now runs only for downloads (downloadSpec).
    // controls=0 strips Vimeo's native chrome (including its Like/Watch Later buttons, which
    // an embedder can't hide individually for someone else's video on the free tier) — the
    // frontend drives its own minimal controls over the Player.js postMessage API instead.
    return { mode: 'embed', embedUrl: `https://player.vimeo.com/video/${id}?autoplay=1&controls=0&title=0&byline=0&portrait=0` }
  },

  async fetchCreatorFeed(externalId) {
    if (!VIMEO_USER_ID.test(externalId)) return []
    try {
      const data = await vimeoApi<{ data?: VimeoApiVideo[] }>(
        `/users/${externalId}/videos?page=1&per_page=10&sort=date`, LIST_TTL)
      return (data.data ?? []).map(apiToItem).filter((x): x is VideoItem => x !== null)
    } catch {
      // API floor: the creator's own profile RSS gives the same listing shape as a channel's.
      return vimeoRssItems(`/${externalId}/videos/rss`, LIST_TTL).then(stampCreatorInfo).catch(() => [])
    }
  },

  async downloadSpec(id) {
    return { method: 'ytdlp', url: `https://vimeo.com/${id}` }
  },
}
