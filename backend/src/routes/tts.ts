import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { characters } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import {
  getTtsEngine,
  parseVoiceId,
  resolveVoice,
  segmentSentences,
  voiceConfig,
} from '@/lib/voice'
import { stripForSpeech } from '@/lib/voice/speechText'
import { refineSentence } from '@/lib/voice/prosodyText'
import { applyPronunciations } from '@/lib/voice/pronunciation'
import { kokoroEngine } from '@/lib/voice/engines/kokoroEngine'
import { getVoicePrefs } from '@/lib/voice/voicePrefs'
import { logger } from '@/lib/logger'

const tts = new Hono<AppEnv>()

interface TtsStreamBody {
  text: string
  voice?: string
  characterId?: string
  speechRate?: number
  sentencePause?: number
  /** Per-chunk emote multiplier on the resolved base rate (default 1). */
  rateScale?: number
  /** Per-chunk emote loudness gain applied to the PCM (default 1). */
  gain?: number
  /** Opt-in: apply the requesting user's personal voice/speed/hushed preference for
   *  this companion (design: keen-percolating-swan). Only the live companion-chat
   *  reply path sets this; preview buttons and diagnostics deliberately leave it
   *  unset so they always hear the character's raw configured voice/rate, never a
   *  personalization override. */
  applyUserVoicePrefs?: boolean
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// Streaming sentence-chunked TTS. Emits one NDJSON SentencePayload per sentence
// as it is synthesized, then `{ done: true }`. Ported from v2 voice_tts.py.
tts.post('/stream', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json()) as TtsStreamBody
  // Strip markdown + roleplay stage directions so the voice never reads "*sigh*".
  const text = stripForSpeech(body.text ?? '')
  if (!text) return c.json({ code: 'empty_text' }, 400)

  // Emote-driven prosody (frontend-derived, default 1 for non-companion callers).
  const rateScaleReq = clamp(body.rateScale ?? 1.0, 0.7, 1.3)
  const gainReq = clamp(body.gain ?? 1.0, 0.4, 1.2)

  let character: typeof characters.$inferSelect | undefined
  if (body.characterId) {
    ;[character] = await db.select().from(characters).where(eq(characters.id, body.characterId)).limit(1)
    if (!character) return c.json({ code: 'character_not_found' }, 404)
  }
  // Per-user override for this companion, ONLY consulted when the caller opts in
  // (see TtsStreamBody.applyUserVoicePrefs), so preview/diagnostic/narration/alarm
  // callers are never silently personalized.
  const userPrefs = (body.applyUserVoicePrefs && character?.id)
    ? await getVoicePrefs(user.id, character.id) : null

  // Per-character expressiveness (0–1) scales how far prosody swings from neutral.
  const expr = character?.expressiveness != null ? clamp(character.expressiveness, 0, 1) : 0.9
  const rateScale = 1 + (rateScaleReq - 1) * expr
  let gain = 1 + (gainReq - 1) * expr
  // Persistent manual "hushed" preference, matches the existing "whisper ≈ 0.55"
  // convention documented in lib/voice/pcm.ts. (The AUTO-detected per-turn whisper
  // match is applied client-side, before this request is even sent, see
  // useCompanionVoice.ts, so it needs no server-side counterpart here.)
  if (userPrefs?.hushed) gain *= 0.55

  // Base rate: the user's personal pace preference wins over the character's own
  // authored default (that's the point of personalization), which in turn wins
  // over a caller-supplied fallback; the emote rateScale then modulates the
  // result and the product is clamped to Kokoro's usable range.
  const baseRate = userPrefs?.speechRate ?? character?.speechRate ?? body.speechRate ?? 1.0
  const speechRate = clamp(baseRate * rateScale, 0.8, 1.3)

  // Resolve the voice: explicit request → user's personal override for this
  // companion → character → (unused generic user fallback) → app default. The
  // user's per-character override is intentionally NOT threaded through
  // resolveVoice()'s `userVoice` slot; that slot's precedence is BELOW character,
  // the opposite of what personalization needs (a user's choice must beat the
  // character's authored default, not lose to it).
  const appDefault = await voiceConfig.appDefaultVoice()
  const resolved = body.voice || userPrefs?.voiceId || resolveVoice({
    characterVoice: character?.ttsVoice,
    userVoice: null, // generic per-user fallback, still unimplemented, unrelated to the override above
    catalogDefault: appDefault,
  })

  let engineId: ReturnType<typeof parseVoiceId>['engine']
  let voiceId: string
  try {
    ;({ engine: engineId, voiceId } = parseVoiceId(resolved))
  } catch {
    return c.json({ code: 'invalid_voice' }, 400)
  }

  const engine = getTtsEngine(engineId)
  const sentences = segmentSentences(text)
  const signal = c.req.raw.signal
  const encoder = new TextEncoder()

  // Latency instrumentation — the synth of the FIRST sentence is the floor on
  // time-to-first-spoken-word once tokens start arriving, so log it explicitly.
  const _t0 = performance.now()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let i = 0; i < sentences.length; i++) {
          if (signal.aborted) break
          let payload
          const _s = performance.now()
          // Normalize punctuation (question intonation, ellipsis) + per-sentence pause.
          const refined = refineSentence(sentences[i]!)
          // Apply the pronunciation lexicon to the AUDIO text only (captions below use the original).
          const spoken = await applyPronunciations(refined.text)
          try {
            payload = await engine.synthesize(spoken, { voice: voiceId, speechRate, gain, signal })
          } catch (e) {
            if (signal.aborted) break
            controller.enqueue(encoder.encode(JSON.stringify({ error: (e as Error).message }) + '\n'))
            break
          }
          payload.display_text = sentences[i]! // captions show the original text
          payload.sentence_pause = i < sentences.length - 1 ? refined.pausePost : 0
          controller.enqueue(encoder.encode(JSON.stringify(payload) + '\n'))
          if (i === 0) {
            logger.info(`[TTS-TIMING] first-audio +${(performance.now() - _t0).toFixed(0)}ms synth=${(performance.now() - _s).toFixed(0)}ms voice=${engineId}:${voiceId} sentences=${sentences.length}`)
          }
        }
        if (!signal.aborted) controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'))
      } finally {
        controller.close()
      }
    },
  })

  c.header('Content-Type', 'application/x-ndjson')
  c.header('Cache-Control', 'no-cache')
  return c.body(stream)
})

// Health of the configured voice engine (Kokoro via the voice-server sidecar).
tts.get('/status', requireAuth, async (c) => {
  const online = await kokoroEngine.health()
  return c.json({ online, engines: { kokoro: online } })
})

export { tts }
