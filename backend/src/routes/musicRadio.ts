// Music radio — proxies radio-browser.info station search and generates AI DJ segments.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { synthesizeWithPauses } from '@/lib/voice/synthSpeech'
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
async function lookupFacts(artist?: string, track?: string): Promise<string> {
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

// POST /api/music/radio/dj-segment
// Generates a short AI DJ script and synthesizes it to WAV via Kokoro.
// Body: { genre, trackName?, artistName?, nextTrackName?, nextArtistName?,
//         weather?, newsHeadline?, position: 'intro'|'transition'|'outro', voice? }
musicRadio.post('/dj-segment', async (c) => {
  type DjBody = {
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
  }
  const body: DjBody = await c.req.json<DjBody>().catch(() => ({} as DjBody))

  const genre = body.genre ?? 'music'
  const stationName = body.stationName
  const sayStation = body.sayStation && !!stationName
  const trackName = body.trackName
  const artistName = body.artistName
  const nextTrackName = body.nextTrackName
  const nextArtistName = body.nextArtistName
  const weather = body.weather
  const newsHeadline = body.newsHeadline
  const position = body.position ?? 'transition'
  const voice = body.voice ?? await appDefaultVoice()

  // Build a context-rich DJ prompt.
  const contextParts: string[] = []
  if (weather) contextParts.push(`Weather: ${weather}.`)
  if (newsHeadline) contextParts.push(`News: ${newsHeadline}.`)
  const ctx = contextParts.join(' ')

  // Grounded facts for a quick aside — only on transitions, where the lookup latency is
  // hidden behind the currently-playing song. Intro/outro stay fast (no Wikipedia call).
  const facts = position === 'transition' ? await lookupFacts(artistName, trackName) : ''
  const aside = facts
    ? `Work in exactly ONE quick, TRUE aside about the artist or song, drawn only from these facts (do not invent): ${facts}`
    : ''

  // When asked, the DJ must name the station, like: "You're listening to Heavy Metal Thunder."
  const stationLine = sayStation ? `Start by saying the listener is tuned to "${stationName}". ` : ''

  let djPrompt: string
  switch (position) {
    case 'intro':
      // Talks OVER the first song, so keep it tight — one or two short sentences.
      djPrompt = `Open a ${genre} set. ${stationLine}Then name what's up now: "${trackName}"${artistName ? ` by ${artistName}` : ''}. ${ctx} Max 22 words. Example shape: "You're listening to ${stationName ?? 'the station'} — up now, ${trackName ?? 'a track'}${artistName ? ` by ${artistName}` : ''}."`
      break
    case 'outro':
      djPrompt = `Sign off the ${genre} set in one short line. ${stationLine}Mention that was ${trackName ? `"${trackName}"${artistName ? ` by ${artistName}` : ''}` : 'that last track'}. Max 18 words.`
      break
    default: // transition
      djPrompt = `Between songs on a ${genre} station. ${stationLine}In one tight line, name that ${trackName ? `was "${trackName}"${artistName ? ` by ${artistName}` : ''}` : 'track'}${nextTrackName ? ` and tease what's up next: "${nextTrackName}"${nextArtistName ? ` by ${nextArtistName}` : ''}` : ''}. ${aside} Max 24 words.`
  }

  try {
    const model = await getModel()
    const chat = await ollamaChat(model, [
      { role: 'system', content: 'You are a fast-talking, charismatic radio DJ. Output ONLY the words you speak aloud — no stage directions, asterisks, or labels. Be brief: one or two short sentences, never more. Tight, energetic, conversational.' },
      { role: 'user', content: djPrompt },
    ], [], { temperature: 0.9, num_predict: 70 })

    // Clean up: strip stray markdown asterisks and any quotes the model wrapped the whole
    // line in, so the caption and the TTS read naturally.
    const text = chat.message?.content
      ?.replace(/\*/g, '')
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim()
    if (!text) return c.json({ error: 'LLM produced no content' }, 503)

    // Synthesize via Kokoro voice server.
    const [engine, voiceId] = voice.includes(':') ? voice.split(':', 2) as [string, string] : ['kokoro', voice]
    if (engine !== 'kokoro') {
      // Return text-only if non-Kokoro voice — frontend can use Web Speech API.
      return c.json({ text, audio: null })
    }

    // Synthesize chunk-by-chunk with silence spliced between sentences and dashes, so the DJ
    // phrases the line instead of rattling it off in one breath.
    const wavBuf = await synthesizeWithPauses(text, {
      voice: voiceId,
      speed: 1.3,
      signal: AbortSignal.timeout(30_000),
    })
    if (!wavBuf) {
      return c.json({ text, audio: null })
    }

    // Return multipart: JSON header + WAV audio encoded as base64 for simplicity.
    return c.json({
      text,
      audio: wavBuf.toString('base64'),
      audioMime: 'audio/wav',
    })
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})
