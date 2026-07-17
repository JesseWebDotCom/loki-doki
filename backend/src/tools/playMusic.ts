import type { Tool, ToolResult, PlayMediaDirective } from './index'
import { innertubeSearch } from '@/lib/youtube/innertube'
import { getTitleMedia } from '@/lib/titles/media'
import { findPresenceByName, type PresenceEntry } from '@/lib/together/presence'
import { sendTogetherCommand } from '@/lib/together/commands'
import { db } from '@/db'
import { playerDevices, users } from '@/db/schema'
import { eq } from 'drizzle-orm'

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

// ── Room / device targeting (Listening Together groundwork) ─────────────────
// "play jazz on the living room TV" resolves the spoken target against the
// household presence registry (registered player sessions + their user-set
// names). Only a REAL match reroutes playback; otherwise behavior is unchanged.

// Trailing "on/in the <something>" phrase - the candidate device name. Only
// honored when it matches a live session, so "play riders on the storm" stays a
// song request unless someone actually named a device "Storm".
const SPOKEN_TARGET_RE = /^(.*?)\s+(?:on|in)\s+(?:the\s+)?([a-z0-9' ._-]{2,40}?)\s*$/i

interface ResolvedTarget { entry: PresenceEntry; name: string; restQuery: string }

/** Match an explicit `target` arg (or a trailing "on the X" phrase) against live
 *  player sessions. Returns null when nothing matches - callers keep the local path. */
async function resolveSpokenTarget(query: string, explicitTarget: string | null): Promise<ResolvedTarget | null> {
  const candidates: Array<{ target: string; rest: string }> = []
  const m = SPOKEN_TARGET_RE.exec(query.trim())
  if (explicitTarget?.trim()) {
    // If the query still embeds the same target phrase ("... on the living room tv"),
    // strip it so the phrase never pollutes the station seed / video search.
    const t = explicitTarget.trim().toLowerCase()
    const tail = m?.[2]?.toLowerCase() ?? ''
    const overlaps = !!tail && (t.includes(tail) || tail.includes(t))
    candidates.push({ target: explicitTarget.trim(), rest: overlaps && m?.[1] ? m[1] : query })
  }
  if (m?.[1] && m?.[2]) candidates.push({ target: m[2], rest: m[1] })
  if (!candidates.length) return null
  let names: Map<string, string>
  try {
    const rows = await db.select().from(playerDevices)
    names = new Map(rows.map((r) => [r.id, r.name]))
  } catch { names = new Map() }
  for (const cand of candidates) {
    const entry = findPresenceByName(cand.target, names)
    // Each candidate carries the query with ITS target phrase removed (the explicit-arg
    // candidate keeps the full query; the LLM already put only the media in `query`).
    if (entry) return { entry, name: names.get(entry.deviceId) ?? entry.label, restQuery: cand.rest }
  }
  return null
}

async function requesterName(userId: string | undefined): Promise<string | undefined> {
  if (!userId) return undefined
  try {
    const [u] = await db.select({ nickname: users.nickname, firstName: users.firstName }).from(users).where(eq(users.id, userId))
    return u ? (u.nickname?.trim() || u.firstName || undefined) : undefined
  } catch { return undefined }
}

// Detect requests that are specifically for a trailer or teaser (not a music video/clip).
const TRAILER_KIND_RE = /\b(trailer|teaser)\b/i

// Extract the movie/show title from a trailer request, e.g.:
//   "the Dune trailer" → "Dune"
//   "trailer for Spider-Man" → "Spider-Man"
//   "official trailer for The Dark Knight" → "The Dark Knight"
// Returns null when no specific title is identifiable.
function extractTrailerTitle(searchQuery: string): string | null {
  const q = searchQuery.trim()

  // "trailer for X" / "teaser for X" / "official trailer for X"
  const forMatch = q.match(/\b(?:official\s+)?(?:trailer|teaser)\s+for\s+(.+)/i)
  if (forMatch?.[1]) {
    const t = forMatch[1].trim().replace(/\?$/, '').replace(/\s+(?:official\s+)?(?:trailer|teaser).*$/i, '').trim()
    if (t.length > 1) return t
  }

  // "X official trailer" / "X trailer" / "X teaser" (title comes first)
  const titleFirst = q.match(/^(.+?)\s+(?:official\s+)?(?:trailer|teaser)(?:\s+\d+)?(?:\s+\d{4})?$/i)
  if (titleFirst?.[1]) {
    const t = titleFirst[1].trim()
    // Filter out non-specific phrases
    if (t.length > 1 && !/^(the|a|an|latest|new|upcoming|first|second|next|official|movie|film|show|series|hd|4k)$/i.test(t)) return t
  }

  return null
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
          target: {
            type: 'string',
            description:
              'Room or device name to play on, ONLY when the user names one ("play jazz on the living room TV" - target: "living room TV"). Omit otherwise.',
          },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { query, type, target } = args as { query: string; type?: string; target?: string }
    if (!query?.trim()) return { success: false, error: 'Query is required' }

    // Room targeting: when the spoken target matches a registered player session,
    // route the play through the Listening Together remote channel instead of the
    // local mini-player. No match -> the pre-existing local behavior, untouched.
    const resolved = await resolveSpokenTarget(query, target ?? null).catch(() => null)
    if (resolved) {
      const remotePlan = classify(resolved.restQuery, type)
      const fromName = await requesterName(config?.['_userId'] as string | undefined)
      if (remotePlan.media === 'station') {
        const ok = await sendTogetherCommand(resolved.entry.deviceId, {
          kind: 'play_station', seedType: remotePlan.seedType, seed: remotePlan.seed, fromName,
        })
        if (!ok) return { success: false, error: `Couldn't reach ${resolved.name} - is the app still open there?` }
        const label = titleCase(remotePlan.seed)
        return {
          success: true,
          data: { query, action: 'play_station_remote', seed: remotePlan.seed, seedType: remotePlan.seedType, device: resolved.name },
          synthesisHint:
            `[Now playing]: You just started a ${label} station on "${resolved.name}" (another device in the house) - it's playing THERE, not here. ` +
            `Confirm in one short, warm, in-character line that the music is going on ${resolved.name}. Do NOT list songs.`,
        }
      }
      // A specific video/song for another room: resolve the top result, then hand it over.
      const scopedRemote = scopeVideoQuery(remotePlan.searchQuery)
      try {
        const { videos } = await innertubeSearch(scopedRemote, 3, 0, 8000, 0)
        const top = videos[0]
        if (!top) return { success: false, error: `Couldn't find anything to play for "${resolved.restQuery}"` }
        const ok = await sendTogetherCommand(resolved.entry.deviceId, {
          kind: 'play_video', videoId: top.videoId, title: top.title, artist: top.author ?? null,
          thumbnail: `https://i.ytimg.com/vi/${top.videoId}/mqdefault.jpg`, fromName,
        })
        if (!ok) return { success: false, error: `Couldn't reach ${resolved.name} - is the app still open there?` }
        return {
          success: true,
          data: { query, action: 'play_video_remote', topVideoId: top.videoId, topTitle: top.title, device: resolved.name },
          directReply: `Now playing on ${resolved.name}.`,
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') return { success: false, offline: true, error: 'Network unavailable' }
        return { success: false, error: String(err) }
      }
    }

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
    const VIDEO_ACKS = ['On it.', 'Here you go.', 'Got it.', 'Coming right up.']
    try {
      // For trailer/teaser requests, try the precise official-trailer finder first so the
      // companion plays the real trailer (same source as the Movie/Show detail pages) rather
      // than a top-result guess from a generic search.
      if (TRAILER_KIND_RE.test(plan.searchQuery)) {
        const titleGuess = extractTrailerTitle(plan.searchQuery)
        if (titleGuess) {
          try {
            const media = await getTitleMedia(titleGuess, null, 'movie')
            if (media.trailer) {
              const t = media.trailer
              const trailerDirective: PlayMediaDirective = {
                action: 'play_media', media: 'video',
                videoId: t.videoId, title: t.title,
                artist: t.author, channelThumb: t.channelThumb,
                thumbnail: `https://i.ytimg.com/vi/${t.videoId}/hqdefault.jpg`,
                durationSec: t.durationSec,
              }
              const directReply = VIDEO_ACKS[Math.floor(Math.random() * VIDEO_ACKS.length)]!
              return {
                success: true,
                data: { query, type: 'video', action: 'play_video', topVideoId: t.videoId, topTitle: t.title, topArtist: t.author ?? null, videos: [] },
                directive: trailerDirective,
                directReply,
              }
            }
          } catch { /* fall through to generic search */ }
        }
      }

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
        channelThumb: null,
        thumbnail: `https://i.ytimg.com/vi/${top.videoId}/hqdefault.jpg`,
        durationSec: top.durationSec ?? null,
      }

      // Use directReply (bypasses the LLM entirely) so the ack appears before the
      // video audio kicks in — no 1-3s synthesis delay talking over the trailer.
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
