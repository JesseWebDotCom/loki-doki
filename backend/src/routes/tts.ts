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
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// Streaming sentence-chunked TTS. Emits one NDJSON SentencePayload per sentence
// as it is synthesized, then `{ done: true }`. Ported from v2 voice_tts.py.
tts.post('/stream', requireAuth, async (c) => {
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
  // Per-character expressiveness (0–1) scales how far prosody swings from neutral.
  const expr = character?.expressiveness != null ? clamp(character.expressiveness, 0, 1) : 0.9
  const rateScale = 1 + (rateScaleReq - 1) * expr
  const gain = 1 + (gainReq - 1) * expr

  // Base rate (character override → request → 1.0), then the emote rateScale
  // modulates it; the product is clamped to Kokoro's usable range.
  const baseRate = character?.speechRate ?? body.speechRate ?? 1.0
  const speechRate = clamp(baseRate * rateScale, 0.8, 1.3)

  // Resolve the voice: explicit request → character → user → app default.
  const appDefault = await voiceConfig.appDefaultVoice()
  const resolved = body.voice || resolveVoice({
    characterVoice: character?.ttsVoice,
    userVoice: null, // per-user voice prefs land later; app default for now
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
