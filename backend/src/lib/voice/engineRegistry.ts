// TTS engine registry + qualified-voice-id parsing.
//
// A voice id is either bare (`af_heart`) or qualified (`engine:voice_id`, e.g.
// `kokoro:af_heart`). Bare ids resolve to DEFAULT_ENGINE. Kokoro is the only
// engine for now (no cloning); the registry stays pluggable so a cloning engine
// can slot in later behind a new id.

export const KNOWN_ENGINES = ['kokoro'] as const
export type EngineId = (typeof KNOWN_ENGINES)[number]

export const DEFAULT_ENGINE: EngineId = 'kokoro'

const QUALIFIED_RE = /^([a-z]+):([A-Za-z0-9_-]+)$/
const BARE_RE = /^[A-Za-z0-9_-]+$/

export function isKnownEngine(engine: string): engine is EngineId {
  return (KNOWN_ENGINES as readonly string[]).includes(engine)
}

/** Parse a bare or qualified voice id into `{ engine, voiceId }`. Throws on invalid input. */
export function parseVoiceId(value: string): { engine: EngineId; voiceId: string } {
  if (typeof value !== 'string' || !value) throw new Error('voice id must be a non-empty string')
  const m = QUALIFIED_RE.exec(value)
  if (m) {
    const engine = m[1]!
    if (!isKnownEngine(engine)) throw new Error(`unknown_engine:${engine}`)
    return { engine, voiceId: m[2]! }
  }
  if (BARE_RE.test(value)) return { engine: DEFAULT_ENGINE, voiceId: value }
  throw new Error(`invalid_voice_id:${value}`)
}
