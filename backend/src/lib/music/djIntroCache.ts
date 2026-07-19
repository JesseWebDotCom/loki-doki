// DJ intro pre-generation: the station head cache knows which song a station will open
// with, so the intro the DJ speaks over it (LLM script + Kokoro TTS, a few seconds of
// GPU/CPU work) can be generated ahead of time too. /dj-segment serves intros from here
// when a match exists and generates live otherwise, so this is purely a fast path.
//
// Variety is deliberate, in two layers: every cached track holds multiple variants (each
// generated with a different prompt angle - see INTRO_ANGLES in routes/musicRadio.ts),
// and serving CONSUMES the variant, with a background replenish topping the pool back up.
// The same tune-in never opens with the same line twice in a row.
//
// Only 'full'-style intros are warmed: minimal-mode intros are a one-line announcement
// and cheap enough to generate live, and warming both styles would double the TTS bill.

import { logger } from '@/lib/logger'

interface IntroVariant { text: string; wavB64: string | null }
interface IntroParams {
  stationName: string
  videoId: string          // cache identity - exact, unlike titles, which each side cleans differently
  trackName: string
  artistName?: string
  style: 'full' | 'minimal'
  voice: string
}
interface IntroEntry { params: IntroParams; variants: IntroVariant[]; at: number; building: boolean }

const TTL_MS = 4 * 60 * 60_000     // matches the station head pool TTL
const VARIANTS_PER_TRACK = 2
const MAX_ENTRIES = 24             // ~memory cap; each variant holds a short base64 WAV

const cache = new Map<string, IntroEntry>()

const keyFor = (p: { stationName: string; videoId: string; style: string; voice: string }): string =>
  [p.stationName, p.videoId, p.style, p.voice].join('\u0000').toLowerCase()

// One generation at a time, app-wide: intro warms ride behind whatever the LLM/TTS are
// already doing instead of bursting 10 concurrent jobs at the GPU on a Music-page open.
let genChain: Promise<void> = Promise.resolve()
const enqueueGen = (job: () => Promise<void>): Promise<void> => {
  genChain = genChain.then(job, job)
  return genChain
}

function evictIfFull(): void {
  if (cache.size < MAX_ENTRIES) return
  let oldestKey: string | null = null
  let oldestAt = Infinity
  for (const [k, e] of cache) if (e.at < oldestAt) { oldestAt = e.at; oldestKey = k }
  if (oldestKey) cache.delete(oldestKey)
}

async function generateVariant(params: IntroParams): Promise<IntroVariant | null> {
  try {
    // Lazy: routes/musicRadio imports lib modules; a static import back would be a cycle.
    const { generateDjSegment, pickIntroAngle } = await import('@/routes/musicRadio')
    const { text, wav } = await generateDjSegment({
      stationName: params.stationName,
      sayStation: true,
      trackName: params.trackName,
      artistName: params.artistName,
      position: 'intro',
      style: params.style,
      voice: params.voice,
      angleHint: pickIntroAngle(),
    })
    return { text, wavB64: wav ? wav.toString('base64') : null }
  } catch (err) {
    logger.debug(`[djIntro] generate failed for "${params.stationName}" / "${params.trackName}": ${err}`)
    return null
  }
}

/** Top an entry's variant pool back up to VARIANTS_PER_TRACK, one generation at a time. */
function replenish(key: string): void {
  const entry = cache.get(key)
  if (!entry || entry.building || entry.variants.length >= VARIANTS_PER_TRACK) return
  entry.building = true
  void enqueueGen(async () => {
    try {
      const live = cache.get(key)
      if (!live) return
      while (live.variants.length < VARIANTS_PER_TRACK) {
        const v = await generateVariant(live.params)
        if (!v) break
        live.variants.push(v)
        live.at = Date.now()
      }
    } finally {
      const live = cache.get(key)
      if (live) live.building = false
    }
  })
}

/** Serve (and consume) a cached intro matching the request, or null for a live generate.
 *  Consuming keeps repeat tune-ins fresh; the pool refills in the background. */
export function takeCachedIntro(req: {
  stationName?: string; trackVideoId?: string
  style?: 'full' | 'minimal'; voice: string
}): IntroVariant | null {
  if (!req.stationName || !req.trackVideoId) return null
  const key = keyFor({
    stationName: req.stationName, videoId: req.trackVideoId,
    style: req.style === 'minimal' ? 'minimal' : 'full', voice: req.voice,
  })
  const entry = cache.get(key)
  if (!entry || Date.now() - entry.at > TTL_MS || !entry.variants.length) return null
  const [variant] = entry.variants.splice(Math.floor(Math.random() * entry.variants.length), 1)
  replenish(key)
  return variant ?? null
}

/** Pre-generate intro variants for a station's likely opener(s). Fire-and-forget from the
 *  head cache; bounded by the global one-at-a-time generation queue. */
export async function warmIntros(
  stationName: string,
  tracks: Array<{ videoId: string; title: string; artist?: string | null }>,
): Promise<void> {
  if (!stationName) return
  let voice: string
  try {
    const { appDefaultVoice } = await import('@/lib/voice/config')
    voice = await appDefaultVoice()
  } catch { return }
  for (const t of tracks) {
    if (!t.title || !t.videoId) continue
    const params: IntroParams = {
      stationName, videoId: t.videoId, trackName: t.title, artistName: t.artist ?? undefined, style: 'full', voice,
    }
    const key = keyFor(params)
    const existing = cache.get(key)
    if (existing && Date.now() - existing.at < TTL_MS && (existing.variants.length >= VARIANTS_PER_TRACK || existing.building)) continue
    if (!existing || Date.now() - existing.at >= TTL_MS) {
      evictIfFull()
      cache.set(key, { params, variants: [], at: Date.now(), building: false })
    }
    replenish(key)
  }
}
