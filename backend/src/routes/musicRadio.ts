// Music radio — proxies radio-browser.info station search and generates AI DJ segments.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { synthesizeWithPauses } from '@/lib/voice/synthSpeech'
import { applyPronunciations } from '@/lib/voice/pronunciation'
import { appDefaultVoice } from '@/lib/voice/config'
import { wikipediaSearch } from '@/lib/wikipediaSearch'
import { innertubeSearch, SEARCH_FILTERS } from '@/lib/youtube/innertube'
import { ytmusicRadio } from '@/lib/youtube/ytmusic'
import type { AppEnv } from '@/types'

export const musicRadio = new Hono<AppEnv>()
musicRadio.use('*', requireAuth)

// Pull a clean encyclopedic snippet about the artist (and song, when distinctive)
// so the DJ can drop a real, grounded aside instead of inventing one. Best-effort:
// returns '' on any miss so the segment still generates without facts.
export async function lookupFacts(artist?: string, track?: string): Promise<string> {
  if (!artist) return ''
  try {
    const q = track ? `${artist} ${track}` : artist
    const hits = await wikipediaSearch(q, 1, 4000)
    const lead = hits[0]?.snippet?.trim() ?? ''
    return lead.slice(0, 700)
  } catch { return '' }
}

// Rotate across radio-browser.info mirrors (they use DNS round-robin).
const RB_BASE = 'https://de1.api.radio-browser.info/json'
const RB_UA = 'LokiDoki/3.0 music-radio-browser'

// GET /api/music/radio/stations?genre=rock&name=KEXP&limit=20&country=US
musicRadio.get('/stations', async (c) => {
  const genre = c.req.query('genre')?.trim()
  const name = c.req.query('name')?.trim()
  const country = c.req.query('country')?.trim()
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 50)

  const params = new URLSearchParams({
    limit: String(limit),
    hidebroken: 'true',
    order: 'votes',
    reverse: 'true',
  })
  if (genre) params.set('tag', genre.toLowerCase())
  if (name) params.set('name', name)
  if (country) params.set('country', country)

  try {
    const res = await fetch(`${RB_BASE}/stations/search?${params}`, {
      headers: { 'User-Agent': RB_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return c.json({ stations: [] })
    const data = await res.json() as Array<{
      stationuuid: string
      name: string
      url_resolved: string
      url: string
      favicon: string
      tags: string
      country: string
      language: string
      codec: string
      bitrate: number
      votes: number
    }>
    const stations = (Array.isArray(data) ? data : [])
      .filter(s => s.url_resolved)
      .map(s => ({
        id: s.stationuuid,
        name: s.name,
        url: s.url_resolved || s.url,
        favicon: s.favicon || null,
        tags: s.tags,
        country: s.country,
        language: s.language,
        codec: s.codec,
        bitrate: s.bitrate,
        votes: s.votes,
      }))
    return c.json({ stations })
  } catch {
    return c.json({ stations: [] })
  }
})

// GET /api/music/radio/queue?q=<search> — build an AI-Radio station queue.
// Strategy: search YouTube for the genre query, pick a random seed from the top hits, then
// pull YouTube Music's auto-curated RADIO MIX off that seed (long, varied, genre-appropriate).
// Falls back to the plain search results if the music radio comes up empty.
musicRadio.get('/queue', async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ tracks: [] })

  try {
    const search = await innertubeSearch(q, 15, 0, 8000, 0, SEARCH_FILTERS.videos)
    const vids = (search.videos ?? []).filter(v => v.videoId)
    if (!vids.length) return c.json({ tracks: [] })

    // Random seed → different mix each tune-in (the radio itself then adds the real variety).
    const seed = vids[Math.floor(Math.random() * Math.min(vids.length, 6))]!
    const radio = await ytmusicRadio(seed.videoId)

    // Merge: music-radio mix first, then any search hits not already present, deduped.
    const seen = new Set<string>()
    const tracks: Array<{ videoId: string; title: string; author: string | null }> = []
    for (const t of radio) {
      if (seen.has(t.videoId)) continue
      seen.add(t.videoId); tracks.push(t)
    }
    for (const v of vids) {
      if (seen.has(v.videoId)) continue
      seen.add(v.videoId); tracks.push({ videoId: v.videoId, title: v.title, author: v.author })
    }
    return c.json({ tracks: tracks.slice(0, 40), source: radio.length ? 'ytmusic' : 'search' })
  } catch (err) {
    return c.json({ tracks: [], error: String(err) })
  }
})

// GET /api/music/radio/genres — popular genre tags from radio-browser.info
musicRadio.get('/genres', async (c) => {
  // Return curated list; we don't need the full 1000+ tag list from the API.
  const genres = [
    { id: 'pop', label: 'Pop' },
    { id: 'rock', label: 'Rock' },
    { id: 'hip-hop', label: 'Hip-Hop' },
    { id: 'jazz', label: 'Jazz' },
    { id: 'classical', label: 'Classical' },
    { id: 'electronic', label: 'Electronic' },
    { id: 'country', label: 'Country' },
    { id: 'r&b', label: 'R&B' },
    { id: 'metal', label: 'Metal' },
    { id: 'reggae', label: 'Reggae' },
    { id: 'blues', label: 'Blues' },
    { id: 'indie', label: 'Indie' },
    { id: 'latin', label: 'Latin' },
    { id: 'ambient', label: 'Ambient' },
    { id: 'news', label: 'News / Talk' },
    { id: 'sports', label: 'Sports' },
  ]
  return c.json({ genres })
})

export interface DjSegmentOpts {
  genre?: string
  stationName?: string
  sayStation?: boolean
  trackName?: string
  artistName?: string
  nextTrackName?: string
  nextArtistName?: string
  weather?: string
  newsHeadline?: string
  position?: 'intro' | 'transition' | 'outro'
  voice?: string
  style?: 'full' | 'minimal'
  /** Pre-fetched Wikipedia facts — skips the network lookup when provided. */
  facts?: string
}

/** Write the DJ script (LLM) and synthesize it to a WAV buffer (Kokoro). Shared by the live
 *  `/dj-segment` route and the offline station pre-render so both behave identically. `wav` is
 *  null when the chosen voice isn't Kokoro or synthesis fails (caller falls back to text only).
 *  Throws when the LLM produces no usable text. */
export async function generateDjSegment(opts: DjSegmentOpts): Promise<{ text: string; wav: Buffer | null }> {
  const genre = opts.genre ?? 'music'
  const style = opts.style === 'minimal' ? 'minimal' : 'full'
  const stationName = opts.stationName
  const sayStation = opts.sayStation && !!stationName
  const { trackName, artistName, nextTrackName, nextArtistName, weather, newsHeadline } = opts
  const position = opts.position ?? 'transition'
  const voice = opts.voice ?? await appDefaultVoice()

  // Build a context-rich DJ prompt.
  const contextParts: string[] = []
  if (weather) contextParts.push(`Weather: ${weather}.`)
  if (newsHeadline) contextParts.push(`News: ${newsHeadline}.`)
  const ctx = contextParts.join(' ')

  // Grounded facts for a quick aside — only on transitions, where the lookup latency is
  // hidden behind the currently-playing song, and never in minimal mode (which just IDs songs).
  // Accept pre-fetched facts (offline snapshot path) to avoid a network call at playback.
  const facts = opts.facts !== undefined
    ? opts.facts
    : (position === 'transition' && style !== 'minimal' ? await lookupFacts(artistName, trackName) : '')
  const aside = facts
    ? `Work in exactly ONE quick, TRUE aside about the artist or song, drawn only from these facts (do not invent): ${facts}`
    : ''

  // When asked, the DJ must name the station, like: "You're listening to Heavy Metal Thunder."
  const stationLine = sayStation ? `Start by saying the listener is tuned to "${stationName}". ` : ''

  let djPrompt: string
  // Minimal DJ: no banter, no facts — just cleanly announce the song (and station only on intro).
  if (style === 'minimal') {
    const cur = trackName ? `"${trackName}"${artistName ? ` by ${artistName}` : ''}` : 'that track'
    const nxt = nextTrackName ? `"${nextTrackName}"${nextArtistName ? ` by ${nextArtistName}` : ''}` : ''
    if (position === 'intro') {
      djPrompt = `${stationLine}Announce only what's playing now: ${cur}. No banter, no extra words. Max 12 words.`
    } else if (position === 'outro') {
      djPrompt = `Announce only that that was ${cur}. No banter. Max 10 words.`
    } else {
      djPrompt = `Announce only that that was ${cur}${nxt ? `, and that ${nxt} is next` : ''}. No banter, no opinions. Max 16 words.`
    }
  } else
  switch (position) {
    case 'intro':
      // Talks OVER the first song, so keep it tight — one short line.
      djPrompt = `Open a ${genre} set in ONE short line. ${stationLine}Then name what's up now: "${trackName}"${artistName ? ` by ${artistName}` : ''}. ${ctx} Max 14 words. Example shape: "You're on ${stationName ?? 'the station'} — up now, ${trackName ?? 'a track'}${artistName ? ` by ${artistName}` : ''}."`
      break
    case 'outro':
      djPrompt = `Sign off the ${genre} set in one short line. ${stationLine}Mention that was ${trackName ? `"${trackName}"${artistName ? ` by ${artistName}` : ''}` : 'that last track'}. Max 18 words.`
      break
    default: { // transition — order: name previous → aside → tease next
      const prevLabel = trackName ? `"${trackName}"${artistName ? ` by ${artistName}` : ''}` : 'that track'
      const nextLabel = nextTrackName ? `"${nextTrackName}"${nextArtistName ? ` by ${nextArtistName}` : ''}` : null
      const nextLine = nextLabel ? ` Then tease what's coming up next: ${nextLabel}.` : ''
      djPrompt = `Between songs on a ${genre} station. ${stationLine}Name that ${prevLabel} just played. ${aside}${nextLine} One or two punchy sentences, in that order. Max 28 words.`
    }
  }

  const model = await getModel()
  const chat = await ollamaChat(model, [
    { role: 'system', content: 'You are a fast-talking, charismatic radio DJ. Output ONLY the words you speak aloud — no stage directions, asterisks, or labels. Be brief: one or two short sentences, never more. Tight, energetic, conversational.' },
    { role: 'user', content: djPrompt },
  ], [], { temperature: 0.9, num_predict: 120 })

  // Clean up: strip stray markdown asterisks and any quotes the model wrapped the whole
  // line in, so the caption and the TTS read naturally.
  const text = chat.message?.content
    ?.replace(/\*/g, '')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim()
  if (!text) throw new Error('LLM produced no content')

  // Synthesize via Kokoro voice server.
  const [engine, voiceId] = voice.includes(':') ? voice.split(':', 2) as [string, string] : ['kokoro', voice]
  if (engine !== 'kokoro') return { text, wav: null } // non-Kokoro: caller uses Web Speech API

  // Apply pronunciation pack substitutions (e.g. AC/DC → A C D C) before synthesis so
  // the caption keeps the correct spelling while Kokoro gets the phonetic version.
  const spokenText = await applyPronunciations(text)

  // Synthesize chunk-by-chunk with silence spliced between sentences and dashes, so the DJ
  // phrases the line instead of rattling it off in one breath.
  // No dash splitting — let Kokoro handle intra-sentence prosody naturally.
  // Short sentence gap (0.12 s) so multi-sentence DJ lines flow instead of stutter.
  const wav = await synthesizeWithPauses(spokenText, {
    voice: voiceId,
    speed: 1.2,
    signal: AbortSignal.timeout(30_000),
    sentenceGapSec: 0.12,
    splitDashes: false,
  })
  return { text, wav: wav ?? null }
}

// POST /api/music/radio/dj-segment
// Generates a short AI DJ script and synthesizes it to WAV via Kokoro.
// Body: { genre, trackName?, artistName?, nextTrackName?, nextArtistName?,
//         weather?, newsHeadline?, position: 'intro'|'transition'|'outro', voice? }
musicRadio.post('/dj-segment', async (c) => {
  const body = await c.req.json<DjSegmentOpts>().catch(() => ({} as DjSegmentOpts))
  try {
    const { text, wav } = await generateDjSegment(body)
    return c.json(wav
      ? { text, audio: wav.toString('base64'), audioMime: 'audio/wav' }
      : { text, audio: null })
  } catch (err) {
    const msg = String(err)
    return c.json({ error: msg }, msg.includes('no content') ? 503 : 500)
  }
})
