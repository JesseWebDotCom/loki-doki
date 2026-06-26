import type { Tool, ToolResult, PlayMediaDirective } from './index'
import { innertubeSearch } from '@/lib/youtube/innertube'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ── Request classification ──────────────────────────────────────────────────
// The router passes the user's whole message as `query` on the Tier-1 fast path
// (no `type` arg), so the tool itself decides whether "play X" means: start an AI
// radio station (genre/mood/artist vibe) or play one specific video (a song,
// music video, trailer, or theme). The optional `type` (set by the Tier-2 LLM)
// overrides the heuristic when present.

// "play this one clip" markers — a request that names a concrete video. A bare
// "video"/"videos" counts too: "play a video on …" means resolve one clip, not
// seed a station. Instructional phrasing ("how to", "tutorial", "documentary")
// is likewise a one-clip request, not a music vibe.
const VIDEO_MARKER_RE = /\b(videos?(?!\s+games?)|trailer|teaser|music video|official video|lyric videos?|lyrics? video|theme song|theme (?:from|to|for|song)|opening|full episode|clip|scene|interview|highlights?|the video for|music video for|how-?to|tutorials?|documentary|documentaries)\b/i
// "keep it going" markers — the user wants a station/stream, not a single track.
const STATION_MARKER_RE = /\b(station|radio|playlist|a mix|mix of|nonstop|non-?stop|channel|stream of)\b/i
// "by <artist>" / quoted titles → a specific song the user wants to hear now.
const SONG_HINT_RE = /\bby\s+[a-z]/i
// "some / a bunch of / a little" → the user wants a body of work, not one track →
// a station ("play some elvis" = Elvis radio, "play some jazz" = a jazz station).
const SOME_MARKER_RE = /\b(?:some|a bunch of|a buncha|a little|a few|a couple(?: of)?|lots of|a lot of)\b/i

// Genres / moods / eras: when the request is essentially one of these (and names no
// concrete video), the user wants a vibe → start a station. Kept broad on purpose.
const STATION_VIBE = [
  // genres
  'rock', 'classic rock', 'hard rock', 'soft rock', 'metal', 'heavy metal', 'death metal', 'black metal',
  'thrash', 'metalcore', 'punk', 'pop punk', 'jazz', 'smooth jazz', 'blues', 'classical', 'orchestral',
  'piano', 'country', 'folk', 'bluegrass', 'hip hop', 'hip-hop', 'hiphop', 'rap', 'trap', 'r&b', 'rnb',
  'soul', 'funk', 'motown', 'reggae', 'reggaeton', 'ska', 'dancehall', 'electronic', 'edm', 'house',
  'deep house', 'techno', 'trance', 'dubstep', 'drum and bass', 'dnb', 'ambient', 'lofi', 'lo-fi',
  'synthwave', 'vaporwave', 'disco', 'pop', 'k-pop', 'kpop', 'j-pop', 'indie', 'indie rock', 'alternative',
  'grunge', 'emo', 'gospel', 'christian', 'latin', 'salsa', 'bachata', 'merengue', 'mariachi', 'flamenco',
  'afrobeats', 'afrobeat', 'opera', 'instrumental', 'acoustic', 'oldies',
  // moods / contexts
  'relaxing', 'relaxation', 'chill', 'chillout', 'chill out', 'upbeat', 'energetic', 'happy', 'sad',
  'calm', 'calming', 'peaceful', 'soothing', 'mellow', 'workout', 'gym', 'running', 'study', 'studying',
  'focus', 'concentration', 'sleep', 'sleepy', 'bedtime', 'party', 'dance', 'dancing', 'romantic',
  'dinner', 'background', 'morning', 'coffeehouse', 'road trip', 'summer', 'rainy day', 'feel good',
  'feel-good', 'motivational', 'meditation', 'yoga', 'holiday', 'christmas', 'spooky', 'halloween music',
  // eras
  '80s', '90s', '70s', '60s', '50s', '2000s', '2010s', 'eighties', 'nineties', 'seventies', 'sixties', 'oldies',
]

// Lead-in fillers stripped to recover the bare subject of a "play X" request.
const LEAD_FILLER_RE = /^(?:hey\s+)?(?:can you|could you|would you|will you|please|go ahead and|now|i(?:'?d| would)?\s*(?:want|wanna|like|love)?\s*(?:to\s+)?(?:hear|listen to|play)|lemme hear|let me hear|let'?s (?:hear|play)|let'?s|put on|throw on|start(?: playing)?|play me|play some|play a little|play|listen to|hear|queue up|spin up|fire up|gimme|give me)\s+/i
// Trailing words that don't belong in a station seed ("…music", "…songs", "station").
const TRAILING_NOISE_RE = /\b(?:some|something|anything|the|a|an|please|music|musics|songs?|tunes?|tracks?|stuff|vibes?|playlist|station|radio|mix|channel|stream|for me|right now|now)\b/gi

type PlayKind = { media: 'station'; seedType: 'artist' | 'genre'; seed: string }
  | { media: 'video'; searchQuery: string }

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

// Strip stacked lead-ins ("can you play some …" → "…") by applying the filler
// pattern until it stops matching. A single pass only removes one chunk.
function stripLead(s: string): string {
  let prev = s.trim()
  for (let i = 0; i < 4; i++) {
    const next = prev.replace(LEAD_FILLER_RE, '').trim()
    if (next === prev || !next) return next || prev
    prev = next
  }
  return prev
}

function cleanSeed(subject: string): string {
  const s = subject.replace(TRAILING_NOISE_RE, ' ').replace(/\s+/g, ' ').trim()
  return s || subject.trim()
}

function matchesVibe(subject: string): boolean {
  const s = ` ${subject.toLowerCase()} `
  return STATION_VIBE.some((v) => s.includes(` ${v} `) || subject.toLowerCase() === v)
}

/** Decide how to honor a "play …" request, honoring an explicit LLM-provided type. */
function classify(query: string, type?: string): PlayKind {
  const raw = query.trim()
  const subject = cleanSeed(stripLead(raw))
  // For a video search, drop only the lead verb(s) ("can you play the…") — KEEP
  // "trailer", "music video", "theme song" etc., which sharpen the YouTube query.
  const videoQuery = stripLead(raw) || raw

  // Explicit type from the Tier-2 LLM wins over the heuristic.
  if (type === 'station' || type === 'genre' || type === 'mood') {
    return { media: 'station', seedType: 'genre', seed: subject }
  }
  if (type === 'artist') {
    return { media: 'station', seedType: 'artist', seed: subject || raw }
  }
  if (type === 'video' || type === 'song') {
    return { media: 'video', searchQuery: videoQuery }
  }

  // Heuristic. A named video (trailer / music video / theme) → play that one clip.
  if (VIDEO_MARKER_RE.test(raw)) return { media: 'video', searchQuery: videoQuery }

  // An explicit station/radio/mix request → station, seed = subject minus the marker.
  if (STATION_MARKER_RE.test(raw)) {
    // "Taylor Swift radio" → artist station; "lo-fi station" → genre station.
    const seedType = matchesVibe(subject) ? 'genre' : 'artist'
    return { media: 'station', seedType, seed: subject || raw }
  }

  // A "by <artist>" phrasing names a specific song → play that video.
  if (SONG_HINT_RE.test(raw)) return { media: 'video', searchQuery: videoQuery }

  // A genre / mood / era ("heavy metal", "jazz", "90s") → genre station.
  if (matchesVibe(subject)) return { media: 'station', seedType: 'genre', seed: cleanSeed(subject) }

  // "play SOME elvis", "play a bunch of zeppelin" → the user wants a body of work,
  // not one clip → an artist radio station seeded by the name.
  if (SOME_MARKER_RE.test(raw)) return { media: 'station', seedType: 'artist', seed: subject || raw }

  // Default: start a station seeded by the artist/song/vibe. "play X" without an
  // explicit video/youtube/trailer keyword means the user wants music to keep
  // playing, not a single video. Users who want a specific video say "the music
  // video for X", "X trailer", "X by Y" (caught above), etc.
  return { media: 'station', seedType: 'artist', seed: subject || raw }
}

// Scope a YouTube query so the right content surfaces. Requests that already name
// the kind of video (trailer / music video / theme) search verbatim; bare song
// titles get "official music video" appended.
function scopeVideoQuery(searchQuery: string): string {
  const q = searchQuery.trim()
  if (VIDEO_MARKER_RE.test(q)) return q
  return `${q} official music video`
}

export const playMusicTool: Tool = {
  id: 'play_music',
  name: 'Play Music',
  description: 'Play a song, music video, trailer, theme song, artist, genre, or radio station in the mini-player',
  offline: false,
  passMessage: 'query',
  dataSources: [
    { name: 'YouTube (InnerTube)', domain: 'youtube.com', purpose: 'Music video and song search', type: 'web' },
  ],
  examples: [
    'play a song for me',
    'play some heavy metal',
    'put on some jazz',
    'play something relaxing',
    'play Taylor Swift',
    'play Bohemian Rhapsody',
    'play the Thriller music video',
    'play the theme song to Halloween',
    'play the latest trailer for the new Spider-Man movie',
    'play the official trailer for Dune',
    'play the music video for Bad Guy',
    'start a lo-fi station',
    'put on a 90s rock station',
    'play something upbeat',
    'I want to listen to hip hop',
    'put on some background music',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'play_music',
      description:
        'Play media in the mini-player when the user says to PLAY or PUT ON something: a specific song, music video, movie/show trailer, theme song, an artist, a genre/mood, or a radio station. Prefer this over the youtube tool whenever the user wants to start playing something now.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'What to play — a song, music video, trailer, theme, artist, genre, or mood' },
          type: {
            type: 'string',
            enum: ['song', 'artist', 'genre', 'mood', 'station', 'video'],
            description:
              'What kind of request this is. "video" for a trailer/music video/clip, "song" for a specific track, "artist" to start that artist\'s radio, "genre"/"mood"/"station" to start a station.',
          },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { query, type } = args as { query: string; type?: string }
    if (!query?.trim()) return { success: false, error: 'Query is required' }

    const plan = classify(query, type)

    // ── Station: no video resolution needed — the client seeds the AI radio engine. ──
    if (plan.media === 'station') {
      const directive: PlayMediaDirective = { action: 'play_media', media: 'station', seedType: plan.seedType, seed: plan.seed }
      const label = titleCase(plan.seed)
      const what = plan.seedType === 'artist' ? `a ${label} radio station` : `a ${label} station`
      return {
        success: true,
        data: { query, type: plan.seedType === 'artist' ? 'artist' : 'genre', action: 'play_station', seed: plan.seed, seedType: plan.seedType },
        directive,
        synthesisHint:
          `[Now playing]: You just put on ${what} for them — it's already playing in the mini-player. ` +
          `React the way a friend would when they drop the needle on something good: one short, warm, in-character line (and a quick aside about ${label} if you've got one). ` +
          `Do NOT ask which song they want or list tracks — it's already going.`,
      }
    }

    // ── Video: resolve the top YouTube result and hand it to the mini-player. ──
    const scoped = scopeVideoQuery(plan.searchQuery)
    try {
      let videos: Array<{ videoId: string; title: string; author?: string | null; durationSec?: number | null }> = []
      try {
        const { videos: itVideos } = await innertubeSearch(scoped, 5, 0, 8000, 0)
        videos = itVideos
      } catch {
        const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(scoped)}`, {
          headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
          signal: AbortSignal.timeout(8000),
        })
        if (res.ok) {
          const html = await res.text()
          const m = html.match(/"videoId":"([A-Za-z0-9_-]{11})"[^}]*"title":\{"runs":\[\{"text":"([^"]+)"/)
          if (m?.[1] && m?.[2]) videos = [{ videoId: m[1], title: m[2] }]
        }
      }

      if (!videos.length) return { success: false, error: `Couldn't find anything to play for "${query}"` }

      const top = videos[0]!
      const results = videos.slice(0, 5).map((v) => ({
        videoId: v.videoId,
        title: v.title,
        artist: v.author ?? null,
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
        durationSec: v.durationSec ?? null,
      }))

      const directive: PlayMediaDirective = {
        action: 'play_media',
        media: 'video',
        videoId: top.videoId,
        title: top.title,
        artist: top.author ?? null,
        channelThumb: top.channelThumb ?? null,
        thumbnail: `https://i.ytimg.com/vi/${top.videoId}/hqdefault.jpg`,
        durationSec: top.durationSec ?? null,
      }

      // Use directReply (bypasses the LLM entirely) so the ack appears before the
      // video audio kicks in — no 1-3s synthesis delay talking over the trailer.
      const VIDEO_ACKS = ['On it.', 'Here you go.', 'Got it.', 'Coming right up.']
      const directReply = VIDEO_ACKS[Math.floor(Math.random() * VIDEO_ACKS.length)]!
      return {
        success: true,
        data: {
          query,
          type: 'video',
          action: 'play_video',
          topVideoId: top.videoId,
          topTitle: top.title,
          topArtist: top.author ?? null,
          videos: results,
        },
        directive,
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
