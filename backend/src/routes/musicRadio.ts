// Music radio — proxies radio-browser.info station search and generates AI DJ segments.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { voiceServerLocalUrl } from '@/lib/voiceServer'
import { appDefaultVoice } from '@/lib/voice/config'
import type { AppEnv } from '@/types'

export const musicRadio = new Hono<AppEnv>()
musicRadio.use('*', requireAuth)

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
  if (weather) contextParts.push(`Current weather: ${weather}.`)
  if (newsHeadline) contextParts.push(`Top news: ${newsHeadline}.`)

  let djPrompt: string
  switch (position) {
    case 'intro':
      djPrompt = `You are a charismatic radio DJ hosting a ${genre} station. Open the show with energy and warmth. Briefly welcome listeners, mention the genre/vibe, and tease the first song${trackName ? ` ("${trackName}"${artistName ? ` by ${artistName}` : ''})` : ''}. ${contextParts.join(' ')} Keep it under 60 words, natural, no markdown.`
      break
    case 'outro':
      djPrompt = `You are a radio DJ wrapping up a ${genre} station session. Sign off warmly. Thanks for listening, mention that was ${trackName ? `"${trackName}"${artistName ? ` by ${artistName}` : ''}` : 'that last track'}. Keep it under 40 words, natural, no markdown.`
      break
    default: // transition
      djPrompt = `You are a radio DJ on a ${genre} station. Briefly transition between songs. ${trackName ? `That was "${trackName}"${artistName ? ` by ${artistName}` : ''}.` : ''} ${nextTrackName ? `Coming up: "${nextTrackName}"${nextArtistName ? ` by ${nextArtistName}` : ''}.` : ''} ${contextParts.join(' ')} Keep it natural, under 50 words, no markdown.`
  }

  try {
    const model = await getModel()
    const chat = await ollamaChat(model, [
      { role: 'system', content: 'You write short, natural radio DJ segments. Output ONLY the spoken text — no stage directions, no asterisks, no labels.' },
      { role: 'user', content: djPrompt },
    ], [], { temperature: 0.9, num_predict: 120 })

    const text = chat.message?.content?.trim()
    if (!text) return c.json({ error: 'LLM produced no content' }, 503)

    // Synthesize via Kokoro voice server.
    const [engine, voiceId] = voice.includes(':') ? voice.split(':', 2) as [string, string] : ['kokoro', voice]
    if (engine !== 'kokoro') {
      // Return text-only if non-Kokoro voice — frontend can use Web Speech API.
      return c.json({ text, audio: null })
    }

    const ttsRes = await fetch(`${voiceServerLocalUrl()}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: voiceId, speed: 1.05 }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!ttsRes.ok) {
      return c.json({ text, audio: null })
    }

    const wavBuf = Buffer.from(await ttsRes.arrayBuffer())
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
