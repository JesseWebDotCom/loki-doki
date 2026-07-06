import type { Tool, ToolResult } from './index'
import { innertubeSearch } from '@/lib/youtube/innertube'
import { stripTags } from '@/lib/htmlText'

const DDG_HTML = 'https://html.duckduckgo.com/html/'
const USER_AGENT = 'Mozilla/5.0 (compatible; LokiDoki/1.0)'
const VIDEO_ID_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,15})/

interface VideoResult {
  title: string
  url: string
  videoId: string
  snippet: string
  embedUrl: string
  // Enriched from the results page (keyless path only); optional for API/Invidious/DDG.
  author?: string
  channelId?: string
  channelThumb?: string | null
  durationSec?: number | null
  publishedText?: string | null
  views?: string | null
}

interface ChannelResult {
  channelId: string
  title: string
  handle: string | null
  thumbnailUrl: string | null
  subscribers: string | null
  url: string
}

interface PlaylistResult {
  playlistId: string
  title: string
  videoCount: number | null
  thumbnailUrl: string | null
  author: string | null
  channelId: string | null
  url: string
}

// Combined regex pairs result__a (title+url) with the following result__snippet.
// Filters for YouTube video IDs — non-YT results are skipped by the videoId check.
function parseVideos(html: string): VideoResult[] {
  const results: VideoResult[] = []
  const rowRe =
    /<a\b(?=[^>]*\bclass="[^"]*result__a[^"]*")[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a\b(?=[^>]*\bclass="[^"]*result__snippet[^"]*")[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(html)) !== null) {
    const url = m[1] || ''
    const vidMatch = VIDEO_ID_RE.exec(url)
    if (!vidMatch) continue
    const videoId = vidMatch[1]
    const title = stripTags(m[2])
    const snippet = stripTags(m[3])
    if (!title) continue
    results.push({
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      snippet,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
    })
  }
  return results
}

async function ddgVideoSearch(query: string, timeout: number): Promise<VideoResult[]> {
  try {
    const res = await fetch(DDG_HTML, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: `site:youtube.com ${query}` }).toString(),
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) return []
    return parseVideos(await res.text())
  } catch {
    return []
  }
}

function deriveAnswerPayload(query: string, videos: VideoResult[], recent: VideoResult[]) {
  if (!videos.length) return { gist: '', highlights: [], sources: [], depth_available: false }
  const lead = videos[0].title
  const gist = lead
    ? `Top YouTube result for ${query}: ${lead}.`
    : `YouTube videos for ${query}.`
  const highlights = videos.slice(1, 5).map(v => v.title).filter(Boolean)
  const sources = videos.map(v => ({ url: v.url, title: v.title || v.url }))
  return { gist, highlights, sources, depth_available: recent.length > 0 }
}

async function ytApiSearch(query: string, apiKey: string, limit: number, timeout: number): Promise<VideoResult[]> {
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${limit}&key=${encodeURIComponent(apiKey)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return []
    const data = await res.json() as { items?: Array<{ id: { videoId: string }; snippet: { title: string; description: string } }> }
    return (data.items ?? []).map(item => ({
      title: item.snippet.title,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      videoId: item.id.videoId,
      snippet: item.snippet.description,
      embedUrl: `https://www.youtube.com/embed/${item.id.videoId}`,
    }))
  } catch {
    return []
  }
}

async function invidiousSearch(query: string, host: string, limit: number, timeout: number): Promise<VideoResult[]> {
  try {
    const base = host.replace(/\/$/, '')
    const url = `${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=videoId,title,description`
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return []
    const data = await res.json() as Array<{ videoId: string; title: string; description: string }>
    return (Array.isArray(data) ? data : []).slice(0, limit).map(v => ({
      title: v.title,
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
      videoId: v.videoId,
      snippet: v.description,
      embedUrl: `https://www.youtube.com/embed/${v.videoId}`,
    }))
  } catch {
    return []
  }
}

// A real browser UA — YouTube's results page returns a stripped/blocked payload to
// obviously-bot agents, so we present as Chrome.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Extract the first balanced {...} object that follows `marker` in `html`, respecting
// string literals/escapes. Used to pull `ytInitialData` out of the results page.
function sliceJsonObject(html: string, marker: string): string | null {
  const i = html.indexOf(marker)
  if (i < 0) return null
  const start = html.indexOf('{', i)
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let j = start; j < html.length; j++) {
    const ch = html[j]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return html.slice(start, j + 1)
  }
  return null
}

// Generic key-walk used for both videoRenderer and channelRenderer nodes.
// `depth` caps recursion so maliciously-nested scraped JSON can't blow the stack;
// realistic ytInitialData nests well under this limit.
const MAX_RENDERER_DEPTH = 50
function collectRenderers(node: unknown, key: string, out: Record<string, any>[], limit: number, depth = 0): void {
  if (out.length >= limit || depth > MAX_RENDERER_DEPTH || !node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) { collectRenderers(item, key, out, limit, depth + 1); if (out.length >= limit) return }
    return
  }
  const obj = node as Record<string, unknown>
  const r = obj[key] as Record<string, any> | undefined
  if (r && typeof r === 'object') out.push(r)
  for (const k in obj) {
    if (k === key) continue
    collectRenderers(obj[k], key, out, limit, depth + 1)
    if (out.length >= limit) return
  }
}

const runsToText = (runs?: Array<{ text?: string }>) => (runs ?? []).map(r => r.text ?? '').join('')

// "12:34" / "1:02:03" → seconds. Returns null for live/unknown lengths.
function parseDuration(text?: string): number | null {
  if (!text) return null
  const parts = text.split(':').map(p => parseInt(p, 10))
  if (parts.some(n => Number.isNaN(n))) return null
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

function rendererToChannel(r: Record<string, any>): ChannelResult | null {
  const channelId = String(r.channelId ?? '')
  if (!channelId) return null
  const title = r.title?.simpleText ?? runsToText(r.title?.runs)
  if (!title) return null
  // Largest avatar thumbnail; YouTube returns protocol-relative URLs.
  const thumbs: Array<{ url?: string }> = r.thumbnail?.thumbnails ?? []
  let thumb = thumbs.length ? thumbs[thumbs.length - 1]?.url ?? null : null
  if (thumb?.startsWith('//')) thumb = `https:${thumb}`
  // YouTube confusingly labels these: subscriberCountText holds the @handle,
  // videoCountText holds the subscriber count.
  const handle = r.subscriberCountText?.simpleText ?? null
  return {
    channelId,
    title: stripTags(title),
    handle: handle?.startsWith('@') ? handle : null,
    thumbnailUrl: thumb,
    subscribers: r.videoCountText?.simpleText ?? null,
    url: `https://www.youtube.com/channel/${channelId}`,
  }
}

interface KeylessResults { videos: VideoResult[]; channels: ChannelResult[]; playlists?: PlaylistResult[]; continuation?: string | null }

// Keyless scrape of youtube.com/results — parses ytInitialData for both video and
// channel results. Replaces the old DuckDuckGo HTML scrape (now an anti-bot page).
async function youtubeResultsSearch(query: string, limit: number, timeout: number, channelLimit = 0): Promise<KeylessResults> {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) return { videos: [], channels: [] }
    const html = await res.text()
    const json = sliceJsonObject(html, 'ytInitialData')
    if (!json) return { videos: [], channels: [] }
    const data = JSON.parse(json)

    const vrs: Record<string, any>[] = []
    collectRenderers(data, 'videoRenderer', vrs, limit)
    const videos: VideoResult[] = []
    for (const r of vrs) {
      const videoId = String(r.videoId ?? '')
      if (!videoId) continue
      const title = r.title?.runs?.[0]?.text ?? r.title?.simpleText ?? ''
      if (!title) continue
      const owner = r.ownerText?.runs?.[0] ?? r.longBylineText?.runs?.[0]
      const snippet =
        runsToText(r.detailedMetadataSnippets?.[0]?.snippetText?.runs) ||
        runsToText(r.descriptionSnippet?.runs) ||
        (owner?.text ?? '')
      const avatars = r.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails
      let channelThumb: string | null = Array.isArray(avatars) && avatars.length ? avatars[avatars.length - 1]?.url ?? null : null
      if (channelThumb?.startsWith('//')) channelThumb = `https:${channelThumb}`
      videos.push({
        title: stripTags(title),
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        snippet: stripTags(snippet),
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
        author: owner?.text ?? undefined,
        channelId: owner?.navigationEndpoint?.browseEndpoint?.browseId ?? undefined,
        channelThumb,
        durationSec: parseDuration(r.lengthText?.simpleText),
        publishedText: r.publishedTimeText?.simpleText ?? null,
        views: r.viewCountText?.simpleText ?? null,
      })
    }

    const channels: ChannelResult[] = []
    if (channelLimit > 0) {
      const crs: Record<string, any>[] = []
      collectRenderers(data, 'channelRenderer', crs, channelLimit)
      for (const r of crs) { const ch = rendererToChannel(r); if (ch) channels.push(ch) }
    }
    return { videos, channels }
  } catch {
    return { videos: [], channels: [] }
  }
}

// Map InnerTube shapes onto this tool's VideoResult/ChannelResult.
function itVideoToResult(v: import('@/lib/youtube/innertube').ItVideo): VideoResult {
  return {
    title: v.title,
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
    videoId: v.videoId,
    snippet: v.author ?? '',
    embedUrl: `https://www.youtube.com/embed/${v.videoId}`,
    author: v.author ?? undefined,
    channelId: v.channelId ?? undefined,
    channelThumb: v.channelThumb,
    durationSec: v.durationSec,
    publishedText: v.publishedText,
    views: v.views,
  }
}
function itChannelToResult(c: import('@/lib/youtube/innertube').ItChannel): ChannelResult {
  return {
    channelId: c.channelId,
    title: c.title,
    handle: c.handle,
    thumbnailUrl: c.thumbnailUrl,
    subscribers: c.subscribers,
    url: `https://www.youtube.com/channel/${c.channelId}`,
  }
}
function itPlaylistToResult(p: import('@/lib/youtube/innertube').ItPlaylist): PlaylistResult {
  return {
    playlistId: p.playlistId,
    title: p.title,
    videoCount: p.videoCount,
    thumbnailUrl: p.thumbnailUrl,
    author: p.author,
    channelId: p.channelId,
    url: `https://www.youtube.com/playlist?list=${p.playlistId}`,
  }
}

// Keyless search: InnerTube's youtubei/v1/search (structured, stable) first, then the
// ytInitialData results-page scrape, then the (often rate-limited) DuckDuckGo scrape.
async function keylessResults(query: string, limit: number, timeout: number, channelLimit = 0): Promise<KeylessResults> {
  const playlistLimit = channelLimit > 0 ? 6 : 0
  try {
    const { videos, channels, playlists, continuation } = await innertubeSearch(query, limit, channelLimit, timeout, playlistLimit)
    if (videos.length) return { videos: videos.map(itVideoToResult), channels: channels.map(itChannelToResult), playlists: playlists.map(itPlaylistToResult), continuation }
  } catch { /* fall through to scrape */ }
  const page = await youtubeResultsSearch(query, limit, timeout, channelLimit)
  if (page.videos.length) return page   // scrape has no continuation token / playlists
  return { videos: await ddgVideoSearch(query, timeout), channels: [] }
}

async function keylessSearch(query: string, limit: number, timeout: number): Promise<VideoResult[]> {
  return (await keylessResults(query, limit, timeout)).videos
}

export const youtubeTool: Tool = {
  id: 'youtube',
  name: 'Videos',
  description: 'Search YouTube for videos by topic or keyword, or resolve a pasted video link (YouTube, Reddit, TikTok, Vimeo)',
  offline: false,
  passMessage: 'query',
  dataSources: [
    { name: 'YouTube (InnerTube)', domain: 'youtube.com', purpose: 'Video & channel search via YouTube\'s internal API (default, no API key required)', type: 'web' },
    { name: 'YouTube API', domain: 'googleapis.com', purpose: 'Official video search (used when API key is configured)', type: 'api' },
  ],
  configSchema: [
    {
      key: 'api_key',
      label: 'YouTube API Key',
      description: 'Free key from Google Cloud Console → YouTube Data API v3. If set, uses the official API instead of an unofficial fallback.',
      type: 'secret' as const,
      scope: 'global' as const,
      placeholder: 'AIza...',
    },
    {
      key: 'invidious_url',
      label: 'Invidious Instance',
      description: 'Your self-hosted Invidious URL (e.g. https://invidious.example.com). Used instead of a Google API key.',
      type: 'string' as const,
      scope: 'global' as const,
      placeholder: 'https://inv.example.com',
    },
  ],
  examples: [
    'find a video to watch on YouTube about any topic',
    'search YouTube for tutorials, entertainment, or how-to videos',
    'watch a video from a specific YouTube channel or creator',
    'show me how to do something via a video',
    'find a YouTube video or clip about a subject',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'youtube',
      description: 'Search YouTube for videos matching a query',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'What to search for on YouTube' },
          max_results: { type: 'number', description: 'Max videos to return (1–8, default 5)' },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { query, max_results = 5 } = args as { query: string; max_results?: number }
    if (!query?.trim()) return { success: false, error: 'Query is required' }

    // Pasted video link (YouTube/Reddit/TikTok/Vimeo): resolve through the hub's provider
    // registry instead of searching, and hand back the in-app watch route.
    const urlMatch = query.match(/https?:\/\/\S+/)
    if (urlMatch) {
      try {
        const { matchUrlToProvider } = await import('@/lib/videos/registry')
        const hit = matchUrlToProvider(urlMatch[0])
        if (hit && hit.match.kind === 'video') {
          const item = await hit.provider.getItem(hit.match.id)
          if (item) {
            return {
              success: true,
              data: {
                resolved: {
                  source: hit.provider.source,
                  videoId: item.id,
                  title: item.title,
                  creator: item.creator?.name ?? null,
                  durationSec: item.durationSec ?? null,
                  url: item.url,
                  route: hit.provider.source === 'youtube'
                    ? `/videos/youtube/watch/${item.id}`
                    : `/videos/${hit.provider.source}/watch/${encodeURIComponent(item.id)}`,
                },
                summary: `Resolved ${hit.provider.label} video: "${item.title}"${item.creator?.name ? ` by ${item.creator.name}` : ''}. The user can watch or save it at the route.`,
              },
            }
          }
        }
      } catch { /* fall through to plain search */ }
    }

    // Default 5 (the chat assistant wants a short list); the browse UI passes a larger
    // count for a full results grid. Capped at 40 so one InnerTube page covers it.
    const limit = Math.min(Math.max(1, max_results), 40)
    const q = query.trim()
    const apiKey = String(config?.['api_key'] ?? '').trim()
    const invidiousUrl = String(config?.['invidious_url'] ?? '').trim()
    const userId = String(config?.['_userId'] ?? '').trim()

    try {
      let primary: VideoResult[] = []
      let recent: VideoResult[] = []
      let channels: ChannelResult[] = []
      let playlists: PlaylistResult[] = []
      let continuation: string | null = null   // for the browse UI's "load more"

      if (apiKey) {
        // Official YouTube Data API v3 — no consent check needed
        ;[primary, recent] = await Promise.all([
          ytApiSearch(q, apiKey, limit, 8000),
          ytApiSearch(`${q} latest`, apiKey, 3, 5000),
        ])
      } else if (invidiousUrl) {
        // Self-hosted Invidious — no consent check needed
        ;[primary, recent] = await Promise.all([
          invidiousSearch(q, invidiousUrl, limit, 8000),
          invidiousSearch(`${q} latest`, invidiousUrl, 3, 5000),
        ])
      } else {
        // No official path — InnerTube first (videos + channels), with scrape/DDG fallbacks.
        const [page, recentVids] = await Promise.all([
          keylessResults(q, limit, 8000, 4),
          keylessSearch(`${q} latest`, 3, 5000),
        ])
        primary = page.videos
        recent = recentVids
        channels = page.channels
        playlists = page.playlists ?? []
        continuation = page.continuation ?? null
      }

      const videos = primary.slice(0, limit)
      if (!videos.length) {
        return { success: true, data: { videos: [], channels, playlists, recent_videos: [], continuation: null, answer_payload: { gist: `No YouTube videos found for "${q}".` } } }
      }

      // Deduplicate recent vs primary by video ID
      const seenIds = new Set(videos.map(v => v.videoId))
      const freshVideos: VideoResult[] = []
      for (const v of recent) {
        if (!seenIds.has(v.videoId)) {
          freshVideos.push(v)
          seenIds.add(v.videoId)
          if (freshVideos.length >= 3) break
        }
      }

      return {
        success: true,
        data: {
          videos,
          channels,
          playlists,
          recent_videos: freshVideos,
          continuation,
          answer_payload: deriveAnswerPayload(q, videos, freshVideos),
        },
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Network unavailable' }
      }
      return { success: false, error: String(err) }
    }
  },
}
