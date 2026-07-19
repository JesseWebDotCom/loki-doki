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
import { filterTracksForUser } from '@/lib/music/advisory'
import { ensureLyricAdvisories } from '@/lib/music/lyricsAdvisory'
import {
  audioGateFor, familyEntrySetsFor, artistAllowed, filterTracksBySets, logFamilyAudioEvent,
} from '@/lib/family/audioPolicy'
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

// radio-browser.info mirror pool. Etiquette per their docs: don't pin one mirror —
// try each in order and remember the first that answers for the rest of the process.
const RB_MIRRORS = [
  'https://de1.api.radio-browser.info/json',
  'https://nl1.api.radio-browser.info/json',
  'https://at1.api.radio-browser.info/json',
]
const RB_UA = 'LokiDoki/3.0 music-radio-browser'
let rbPreferred = 0

/** GET a radio-browser API path (e.g. 'stations/search?…') with mirror failover. */
export async function rbFetch(path: string, timeoutMs = 8000): Promise<Response> {
  let lastErr: unknown = null
  for (let i = 0; i < RB_MIRRORS.length; i++) {
    const idx = (rbPreferred + i) % RB_MIRRORS.length
    try {
      const res = await fetch(`${RB_MIRRORS[idx]}/${path}`, {
        headers: { 'User-Agent': RB_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) { rbPreferred = idx; return res }
      lastErr = new Error(`mirror ${idx} responded ${res.status}`)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

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
    const res = await rbFetch(`stations/search?${params}`)
    const data = await res.json() as Array<{
      stationuuid: string
      name: string
      url_resolved: string
      url: string
      homepage: string
      favicon: string
      tags: string
      country: string
      language: string
      codec: string
      bitrate: number
      votes: number
      hls: number
    }>
    const stations = (Array.isArray(data) ? data : [])
      .filter(s => s.url_resolved)
      .map(s => ({
        id: s.stationuuid,
        name: s.name,
        url: s.url_resolved || s.url,
        homepage: s.homepage || null,
        favicon: s.favicon || null,
        tags: s.tags,
        country: s.country,
        language: s.language,
        codec: s.codec,
        bitrate: s.bitrate,
        votes: s.votes,
        // HLS stations can't play through <audio> + the byte proxy — the UI badges them.
        hls: s.hls === 1,
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

  // Family audio gates: time budget/quiet hours stop the mix from starting at all;
  // allowlist-only profiles may only seed a mix with an approved artist's name.
  {
    const listener = c.get('user')
    const gate = await audioGateFor(listener.id)
    if (!gate.allowed) {
      logFamilyAudioEvent(listener.id, gate.reason === 'quiet_hours' ? 'quiet_hours_block' : 'budget_exhausted', { label: q, medium: 'music' })
      return c.json({ error: gate.reason === 'quiet_hours' ? 'Audio is paused during quiet hours' : 'Audio time is done for today', code: 'family_time' }, 403)
    }
    const sets = await familyEntrySetsFor(listener.id)
    if (sets.allowlistOnly && !artistAllowed(sets, q)) {
      logFamilyAudioEvent(listener.id, 'blocked_play', { label: q, medium: 'music', reason: 'mix' })
      return c.json({ error: 'This mix is not available on this profile', code: 'family_blocked' }, 403)
    }
  }

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
    let out = tracks.slice(0, 40)

    // Content protections: this AI-Radio path pulls raw YT-Music mixes that carry no advisory
    // data, so it was the one music surface bypassing the per-profile filter. Route it through
    // the same gate (mapping author→artist, which filterTracksForUser keys on); explicit tracks
    // drop for blocking profiles, unknowns drop only in strict mode and get background-checked.
    const listener = c.get('user')
    if (listener) {
      let keyed = out.map(t => ({ ...t, artist: t.author ?? '' }))
      // Family audio: drop blocklisted artists from the mix (the seed artist itself was
      // already vetted above; the mix drifts, so re-check every track).
      const sets = await familyEntrySetsFor(listener.id)
      if (sets.hasAny) keyed = filterTracksBySets(sets, keyed, sets.allowlistOnly)
      const kept = await filterTracksForUser(listener.id, keyed)
      const keepIds = new Set(kept.map(t => t.videoId))
      out = out.filter(t => keepIds.has(t.videoId))
      // Warm lyric-derived advisories for the still-unknown tracks so a later tune-in filters
      // them correctly even when iTunes/Deezer never knew them (background, fire-and-forget).
      ensureLyricAdvisories(keyed)
    }
    return c.json({ tracks: out, source: radio.length ? 'ytmusic' : 'search' })
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
  /** The current track's ref, only used as the intro-cache identity (titles are cleaned
   *  differently on each side, so they can't key a cache). */
  trackVideoId?: string
  nextTrackName?: string
  nextArtistName?: string
  weather?: string
  newsHeadline?: string
  position?: 'intro' | 'transition' | 'outro'
  voice?: string
  style?: 'full' | 'minimal'
  /** Pre-fetched Wikipedia facts — skips the network lookup when provided. */
  facts?: string
  /** Extra flavor instruction for intro scripts (see INTRO_ANGLES). Callers that omit it
   *  get a random angle per generation, so live intros vary too. */
  angleHint?: string
}

// Intro flavor angles: one is worked into every full-style intro prompt so repeat tune-ins
// of the same station don't all produce the same "You're on X, up now Y" line. The empty
// string is the classic station-ID shape (it keeps the example in the prompt).
const INTRO_ANGLES = [
  '',
  'Lead with the vibe of the set in two or three words before naming the track.',
  'Lead with the artist, like you are proud to have them on the show.',
  'Make it feel like a warm welcome back to a favorite hangout.',
  'Big-energy cold open: hit the track name fast.',
]
export const pickIntroAngle = (): string => INTRO_ANGLES[Math.floor(Math.random() * INTRO_ANGLES.length)]!

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
    case 'intro': {
      // Talks OVER the first song, so keep it tight: one short line. The angle varies the
      // shape between generations; the classic example is only anchored when no angle asks
      // for a different lead (it pulls the model back to the same line every time otherwise).
      const angle = opts.angleHint ?? pickIntroAngle()
      const example = angle ? '' : ` Example shape: "You're on ${stationName ?? 'the station'} — up now, ${trackName ?? 'a track'}${artistName ? ` by ${artistName}` : ''}."`
      djPrompt = `Open a ${genre} set in ONE short line. ${stationLine}Then name what's up now: "${trackName}"${artistName ? ` by ${artistName}` : ''}. ${ctx} ${angle ? `${angle} ` : ''}Max 14 words.${example}`
      break
    }
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
    // Intros: serve a pre-generated variant when the head cache warmed one for this
    // station+track (djIntroCache.ts), so tune-in DJ speech starts near-instantly. Consumed
    // on serve, so the next tune-in gets a different line. Misses fall through to live.
    if (body.position === 'intro') {
      const { takeCachedIntro } = await import('@/lib/music/djIntroCache')
      const cached = await takeCachedIntro({
        stationName: body.stationName, trackVideoId: body.trackVideoId,
        style: body.style, voice: body.voice ?? await appDefaultVoice(),
      })
      if (cached) {
        return c.json(cached.wavB64
          ? { text: cached.text, audio: cached.wavB64, audioMime: 'audio/wav' }
          : { text: cached.text, audio: null })
      }
    }
    const { text, wav } = await generateDjSegment(body)
    return c.json(wav
      ? { text, audio: wav.toString('base64'), audioMime: 'audio/wav' }
      : { text, audio: null })
  } catch (err) {
    const msg = String(err)
    return c.json({ error: msg }, msg.includes('no content') ? 503 : 500)
  }
})
