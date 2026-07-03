// Curated Kokoro voice roster for narration speakers, ordered for maximal
// alternating gender/accent distinctiveness so back-to-back speakers sound
// different even before the user overrides anything. Mirrors the roster
// described in frontend/src/lib/companions/voiceCatalog.ts.

export const NARRATOR_VOICE = 'kokoro:af_heart'

export const NARRATION_VOICE_POOL: string[] = [
  'kokoro:am_michael',
  'kokoro:bf_emma',
  'kokoro:am_puck',
  'kokoro:af_bella',
  'kokoro:bm_george',
  'kokoro:af_sarah',
  'kokoro:am_echo',
  'kokoro:af_nicole',
  'kokoro:bm_lewis',
  'kokoro:af_sky',
  'kokoro:am_onyx',
]

/**
 * Assign each non-narrator speaker a distinct voice, round-robin by first-appearance
 * order, skipping voices already claimed this session. The narrator always gets the
 * fixed app-default voice so plain single-voice text sounds identical to today.
 */
export function assignVoices(speakers: { normalizedKey: string; isNarrator: boolean }[]): Map<string, string> {
  const voiceByKey = new Map<string, string>()
  let poolIdx = 0
  for (const s of speakers) {
    if (s.isNarrator) {
      voiceByKey.set(s.normalizedKey, NARRATOR_VOICE)
      continue
    }
    const voice = NARRATION_VOICE_POOL[poolIdx % NARRATION_VOICE_POOL.length]!
    voiceByKey.set(s.normalizedKey, voice)
    poolIdx++
  }
  return voiceByKey
}
