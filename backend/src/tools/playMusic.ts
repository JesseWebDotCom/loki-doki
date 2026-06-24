import type { Tool, ToolResult } from './index'
import { innertubeSearch } from '@/lib/youtube/innertube'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Scope a music search query: add "music" for genre/mood requests, "official music video"
// for specific song/artist requests so YouTube surfaces the right content.
function scopeQuery(query: string, type: string): string {
  const q = query.trim()
  if (type === 'genre' || type === 'mood') return `${q} music radio`
  if (type === 'artist') return `${q} music`
  // For specific song requests, prefer official videos.
  return `${q} official music video`
}

export const playMusicTool: Tool = {
  id: 'play_music',
  name: 'Play Music',
  description: 'Search for and play a song, artist, genre, or mood in the Music app',
  offline: false,
  passMessage: 'query',
  dataSources: [
    { name: 'YouTube (InnerTube)', domain: 'youtube.com', purpose: 'Music video and song search', type: 'web' },
  ],
  examples: [
    'play a song for me',
    'play some heavy metal music',
    'play something relaxing',
    'play Taylor Swift',
    'play Bohemian Rhapsody',
    'find music to listen to',
    'play jazz in the music app',
    'I want to listen to hip hop',
    'put on some background music',
    'play something upbeat',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'play_music',
      description: 'Search for music by song, artist, genre, or mood and open it in the Music app',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'The song title, artist, genre, or mood to search for' },
          type: {
            type: 'string',
            enum: ['song', 'artist', 'genre', 'mood'],
            description: 'What kind of music request this is',
          },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { query, type = 'song' } = args as { query: string; type?: string }
    if (!query?.trim()) return { success: false, error: 'Query is required' }

    const scopedQuery = scopeQuery(query.trim(), type)

    try {
      // Try InnerTube first, fall back to scrape.
      let videos: Array<{ videoId: string; title: string; author?: string | null; channelThumb?: string | null; durationSec?: number | null }> = []
      try {
        const { videos: itVideos } = await innertubeSearch(scopedQuery, 5, 0, 8000, 0)
        videos = itVideos
      } catch {
        // Fall back to simple search
        const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(scopedQuery)}`, {
          headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
          signal: AbortSignal.timeout(8000),
        })
        if (res.ok) {
          const html = await res.text()
          const m = html.match(/"videoId":"([A-Za-z0-9_-]{11})"[^}]*"title":\{"runs":\[\{"text":"([^"]+)"/)
          if (m?.[1] && m?.[2]) videos = [{ videoId: m[1], title: m[2] }]
        }
      }

      if (!videos.length) {
        return { success: false, error: `No music found for "${query}"` }
      }

      const top = videos[0]!
      const results = videos.slice(0, 5).map(v => ({
        videoId: v.videoId,
        title: v.title,
        artist: v.author ?? null,
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
        durationSec: v.durationSec ?? null,
      }))

      const label = type === 'genre' || type === 'mood' ? query : `"${top.title}"`
      const directReply = `Playing ${label}${top.author && type !== 'genre' ? ` by ${top.author}` : ''} — opening Music Videos for you.`

      return {
        success: true,
        data: {
          query,
          type,
          videos: results,
          topVideoId: top.videoId,
          topTitle: top.title,
          topArtist: top.author ?? null,
          action: 'play_music',
          deeplink: `/music?tab=videos&q=${encodeURIComponent(query)}&videoId=${top.videoId}`,
        },
        directReply,
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Network unavailable' }
      }
      return { success: false, error: String(err) }
    }
  },
}
