// Reddit provider. Reddit blocked ALL anonymous access in the 2024+ lockdown
// (public .json, api.reddit.com, RSS-with-script-UAs, and yt-dlp's extractor all
// require credentials now), so this source needs a free registered app client id
// (see redditAuth.ts) and talks to oauth.reddit.com with an app-only bearer token.
// No reddit account login is required. Subreddits act as creators. v.redd.it video
// is DASH with split audio, so inline playback uses the post's HLS manifest through
// our proxy (routes/videos.ts) and downloads remux that manifest with ffmpeg.
//
// The app token is rate-limited (~100 req/min), so every fetch is wrapped in
// cachedLookup with a short TTL — heavy browsing hits the cache, not reddit.

import { cachedLookup } from '@/lib/lookupCache'
import { getRedditAccessToken, getRedditClientId, redditUserAgent } from '@/lib/videos/redditAuth'
import type { VideoProvider } from '@/lib/videos/provider'
import type { Creator, Pager, VideoItem } from '@/lib/videos/types'
const LIST_TTL = 90_000          // listings: 90s — fresh enough, cheap on the rate limit
const ITEM_TTL = 10 * 60_000     // single posts: 10 min
const ABOUT_TTL = 60 * 60_000    // subreddit about: 1h

// Default browse surface: a multireddit of broadly liked video subs. Category chips
// map to topical multireddits of the same shape.
const DEFAULT_MULTI = 'videos+mealtimevideos+Documentaries+artisanvideos+educationalgifs+nextfuckinglevel+oddlysatisfying+interestingasfuck'
const FEED_MULTIS: Record<string, { label: string; multi: string }> = {
  popular: { label: 'Popular', multi: DEFAULT_MULTI },
  funny: { label: 'Funny', multi: 'funny+ContagiousLaughter+youtubehaiku+instantregret' },
  docs: { label: 'Documentaries', multi: 'Documentaries+mealtimevideos+lectures' },
  gaming: { label: 'Gaming', multi: 'gaming+GamePhysics+gamingclips' },
  nature: { label: 'Nature', multi: 'NatureIsFuckingLit+AnimalsBeingBros+aww' },
  sports: { label: 'Sports', multi: 'sports+TheOcho+MMA' },
  science: { label: 'Science & Space', multi: 'space+science+EngineeringPorn+educationalgifs' },
  food: { label: 'Food', multi: 'food+cooking+GifRecipes' },
}

const POST_ID = /^[a-z0-9]{4,10}$/i
const SUB_NAME = /^[A-Za-z0-9_]{2,21}$/

interface RedditPost {
  id: string
  subreddit: string
  title: string
  author: string
  permalink: string
  url?: string
  over_18?: boolean
  is_video?: boolean
  post_hint?: string
  thumbnail?: string
  preview?: { images?: Array<{ source?: { url?: string } }> }
  created_utc?: number
  score?: number
  media?: { reddit_video?: { hls_url?: string; fallback_url?: string; duration?: number; height?: number; width?: number } }
  secure_media?: { reddit_video?: { hls_url?: string; fallback_url?: string; duration?: number; height?: number; width?: number } }
  crosspost_parent_list?: RedditPost[]
}

export class RedditNotConfiguredError extends Error {
  constructor() { super('Reddit needs a (free) app client id to enable browsing here. Add one on the Reddit page in Videos.') }
}

// Roffline-style public .json works on SOME networks (reddit gates anonymous access by
// IP reputation since the 2023 lockdown). Probe it once and remember: anonymous when
// possible, OAuth app token when configured, honest error otherwise.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
let anonWorks: boolean | null = null

export async function anonymousRedditWorks(): Promise<boolean> {
  if (anonWorks !== null) return anonWorks
  try {
    const res = await fetch('https://www.reddit.com/r/videos/hot.json?raw_json=1&limit=1', {
      headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(8_000),
    })
    anonWorks = res.ok && (res.headers.get('content-type') ?? '').includes('json')
  } catch {
    anonWorks = false
  }
  setTimeout(() => { anonWorks = null }, 30 * 60_000).unref?.()   // re-probe every 30 min
  return anonWorks
}

async function redditJson<T>(path: string, ttl: number): Promise<T> {
  const token = await getRedditAccessToken()
  if (!token && !(await anonymousRedditWorks())) throw new RedditNotConfiguredError()
  return cachedLookup('reddit', path, ttl, async () => {
    const res = token
      ? await fetch(`https://oauth.reddit.com${path}`, {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': redditUserAgent(), Accept: 'application/json' },
        })
      : await fetch(`https://www.reddit.com${path}`, { headers: { 'User-Agent': BROWSER_UA } })
    if (!res.ok) throw new Error(`reddit ${res.status} for ${path}`)
    return res.json() as Promise<T>
  })
}

function redditVideo(p: RedditPost) {
  return p.media?.reddit_video
    ?? p.secure_media?.reddit_video
    ?? p.crosspost_parent_list?.[0]?.media?.reddit_video
    ?? p.crosspost_parent_list?.[0]?.secure_media?.reddit_video
    ?? null
}

function bestThumb(p: RedditPost): string | null {
  const preview = p.preview?.images?.[0]?.source?.url
  if (preview) return preview
  if (p.thumbnail && p.thumbnail.startsWith('http')) return p.thumbnail
  return null
}

/** Keep only posts we can actually play: native v.redd.it video. (YouTube links inside
 *  reddit deep-link to the YouTube source instead; the hub's registry handles that.) */
function toItem(p: RedditPost): VideoItem | null {
  const rv = redditVideo(p)
  if (!rv?.hls_url && !rv?.fallback_url) return null
  return {
    source: 'reddit',
    id: p.id,
    url: `https://www.reddit.com${p.permalink}`,
    title: p.title,
    creator: { id: p.subreddit, name: `r/${p.subreddit}` },
    thumbnailUrl: bestThumb(p),
    durationSec: rv.duration ?? null,
    publishedAt: p.created_utc ? Math.round(p.created_utc * 1000) : null,
    viewsText: typeof p.score === 'number' ? `${Intl.NumberFormat('en', { notation: 'compact' }).format(p.score)} points` : null,
    isAdult: !!p.over_18,
    vertical: !!(rv.height && rv.width && rv.height > rv.width),
    meta: {
      permalink: p.permalink,
      subreddit: p.subreddit,
      hlsUrl: rv.hls_url ?? null,
      fallbackUrl: rv.fallback_url ?? null,
      postedBy: p.author,
    },
  }
}

function listingToPager(data: { data?: { children?: Array<{ data: RedditPost }>; after?: string | null } }): Pager<VideoItem> {
  const children = data.data?.children ?? []
  const items = children.map((c) => toItem(c.data)).filter((x): x is VideoItem => x !== null)
  return { items, cursor: data.data?.after ?? null }
}

/** Fetch a single post by base36 id. Exported for the HLS proxy route, which needs
 *  the post's v.redd.it manifest URL. */
export async function redditPost(id: string): Promise<VideoItem | null> {
  if (!POST_ID.test(id)) return null
  const data = await redditJson<{ data?: { children?: Array<{ data: RedditPost }> } }>(
    `/by_id/t3_${id}.json?raw_json=1`, ITEM_TTL)
  const post = data.data?.children?.[0]?.data
  return post ? toItem(post) : null
}

export const redditProvider: VideoProvider = {
  source: 'reddit',
  label: 'Reddit',
  capabilities: {
    browse: true,
    search: true,
    creators: true,
    comments: true,
    live: false,
    downloadKinds: ['video'],
    authConfig: 'apiKey',
  },
  discovery: ['popular', 'trending'],
  browseFeeds: Object.entries(FEED_MULTIS).map(([id, f]) => ({ id, label: f.label })),

  async status() {
    if (await getRedditClientId()) return { configured: true }
    // No client id: usable anyway when reddit's anonymous JSON is open to this network.
    if (await anonymousRedditWorks()) return { configured: true }
    return { configured: false, note: 'Add a free Reddit app client id (reddit.com/prefs/apps) to enable browsing.' }
  },

  matchUrl(url) {
    const host = url.hostname.replace(/^www\.|^old\.|^new\.|^np\./, '')
    if (host === 'redd.it') {
      const id = url.pathname.slice(1).split('/')[0] ?? ''
      return POST_ID.test(id) ? { kind: 'video', id } : null
    }
    if (host !== 'reddit.com') return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'r' && parts[1] && parts[2] === 'comments' && parts[3] && POST_ID.test(parts[3])) {
      return { kind: 'video', id: parts[3] }
    }
    if (parts[0] === 'r' && parts[1] && SUB_NAME.test(parts[1]) && parts.length <= 2) {
      return { kind: 'creator', id: parts[1] }
    }
    return null
  },

  async browse({ feed, cursor, allowAdult }) {
    const after = cursor ? `&after=${encodeURIComponent(cursor)}` : ''
    // Reserved discovery feeds rank the curated video multi: 'trending' = hot right now,
    // 'popular' = top of the week. Category chip ids map to curated multis; anything else
    // (a followed subreddit chip passes its name) is used directly, sorted by hot.
    const discovery = feed === 'popular' || feed === 'trending'
    const sort = feed === 'popular' ? 'top' : 'hot'
    const t = feed === 'popular' ? '&t=week' : ''
    const multi = discovery ? DEFAULT_MULTI
      : feed && FEED_MULTIS[feed] ? FEED_MULTIS[feed]!.multi
      : feed && /^[A-Za-z0-9_+]+$/.test(feed) ? feed : DEFAULT_MULTI
    const data = await redditJson<Parameters<typeof listingToPager>[0]>(
      `/r/${multi}/${sort}.json?raw_json=1&limit=50${t}${after}`, LIST_TTL)
    const page = listingToPager(data)
    if (!allowAdult) page.items = page.items.filter((i) => !i.isAdult)
    return page
  },

  async search(q, { cursor, allowAdult }) {
    const after = cursor ? `&after=${encodeURIComponent(cursor)}` : ''
    const nsfw = allowAdult ? '&include_over_18=on' : '&include_over_18=off'
    const data = await redditJson<Parameters<typeof listingToPager>[0]>(
      `/search.json?raw_json=1&q=${encodeURIComponent(q)}&type=link&limit=50${nsfw}${after}`, LIST_TTL)
    const page = listingToPager(data)
    if (!allowAdult) page.items = page.items.filter((i) => !i.isAdult)
    return page
  },

  async getCreator(id, cursor) {
    if (!SUB_NAME.test(id)) throw new Error('invalid subreddit')
    const [about, listing] = await Promise.all([
      redditJson<{ data?: { display_name?: string; title?: string; icon_img?: string; community_icon?: string; banner_background_image?: string; public_description?: string; subscribers?: number; over18?: boolean } }>(
        `/r/${id}/about.json?raw_json=1`, ABOUT_TTL),
      redditJson<Parameters<typeof listingToPager>[0]>(
        `/r/${id}/hot.json?raw_json=1&limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, LIST_TTL),
    ])
    const a = about.data ?? {}
    const icon = (a.community_icon || a.icon_img || '').split('?')[0] || null
    const creator: Creator = {
      source: 'reddit',
      kind: 'subreddit',
      id,
      name: `r/${a.display_name ?? id}`,
      avatarUrl: icon,
      bannerUrl: (a.banner_background_image || '').split('?')[0] || null,
      description: a.public_description ?? null,
      subscriberText: typeof a.subscribers === 'number'
        ? `${Intl.NumberFormat('en', { notation: 'compact' }).format(a.subscribers)} members` : null,
      isAdult: !!a.over18,
    }
    return { creator, videos: listingToPager(listing) }
  },

  async getItem(id) {
    return redditPost(id)
  },

  async getPlayback(id) {
    const item = await redditPost(id)
    const hls = item?.meta?.hlsUrl as string | undefined
    if (hls) {
      // App-relative manifest through our proxy; hls.js resolves child playlist/segment
      // URIs relative to this path and the proxy forwards them to v.redd.it.
      return { mode: 'hls', manifestUrl: `/api/videos/reddit/hls/${encodeURIComponent(id)}/manifest.m3u8` }
    }
    const fallback = item?.meta?.fallbackUrl as string | undefined
    if (fallback) return { mode: 'proxy-progressive', upstreamUrl: fallback }
    throw new Error('no playable stream for this post')
  },

  async getComments(id) {
    if (!POST_ID.test(id)) return []
    const data = await redditJson<Array<{ data?: { children?: Array<{ kind: string; data: { author?: string; body?: string; score?: number; created_utc?: number } }> } }>>(
      `/comments/${id}.json?raw_json=1&limit=30&depth=1`, ITEM_TTL)
    const comments = data[1]?.data?.children ?? []
    return comments
      .filter((c) => c.kind === 't1' && c.data.body)
      .slice(0, 25)
      .map((c) => ({
        author: c.data.author ?? '[deleted]',
        text: c.data.body ?? '',
        likes: typeof c.data.score === 'number' ? String(c.data.score) : null,
        publishedText: null,
      }))
  },

  async fetchCreatorFeed(externalId, knownIds) {
    if (!SUB_NAME.test(externalId)) return []
    // RSS-first (free: subreddit .rss serves with a browser UA and costs no API quota).
    // Only when it lists post ids we haven't stored does ONE batched by_id call fetch
    // full data (over_18, v.redd.it urls, duration) for exactly the new posts.
    if (knownIds) {
      try {
        const res = await fetch(`https://www.reddit.com/r/${externalId}/new/.rss`, {
          headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(10_000),
        })
        if (res.ok) {
          const xml = await res.text()
          if (xml.trimStart().startsWith('<?xml')) {
            const ids = [...xml.matchAll(/<id>t3_([a-z0-9]+)<\/id>/gi)].map((m) => m[1]!)
            const fresh = ids.filter((id) => !knownIds.has(id)).slice(0, 25)
            if (ids.length > 0 && fresh.length === 0) return []   // nothing new: zero API calls
            if (fresh.length > 0) {
              const data = await redditJson<{ data?: { children?: Array<{ data: RedditPost }> } }>(
                `/by_id/${fresh.map((id) => `t3_${id}`).join(',')}.json?raw_json=1`, LIST_TTL)
              return (data.data?.children ?? []).map((c) => toItem(c.data)).filter((x): x is VideoItem => x !== null)
            }
          }
        }
      } catch { /* RSS unavailable: fall through to the listing call */ }
    }
    const data = await redditJson<Parameters<typeof listingToPager>[0]>(
      `/r/${externalId}/new.json?raw_json=1&limit=25`, LIST_TTL)
    return listingToPager(data).items
  },

  async downloadSpec(id) {
    const item = await redditPost(id)
    if (!item) throw new Error('post not found')
    const hls = item.meta?.hlsUrl as string | undefined
    // yt-dlp's reddit extractor needs account auth, but the v.redd.it CDN doesn't:
    // remux the HLS manifest with ffmpeg instead.
    if (hls) return { method: 'hls', url: hls }
    const fallback = item.meta?.fallbackUrl as string | undefined
    if (fallback) return { method: 'ytdlp', url: fallback }
    throw new Error('no downloadable stream for this post')
  },
}
