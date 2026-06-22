// Shared voice subsystem types.
//
// The TTS wire format mirrors v2's NDJSON sentence payload so the ported
// frontend playback scheduler consumes it unchanged. One payload is emitted
// per synthesized sentence; the stream ends with `{ done: true }`.

export interface SentencePayload {
  /** The (possibly normalized) text that was synthesized. */
  sentence: string
  /** Original pre-normalization text for subtitles (falls back to `sentence`). */
  display_text?: string
  /** PCM sample rate, e.g. 22050. */
  sample_rate: number
  /** Base64-encoded signed 16-bit little-endian mono PCM. */
  pcm_b64: string
  /** Optional phoneme timing frames (unused in v1 — amplitude fallback drives visemes). */
  phonemes?: { viseme: string; t: number; d: number }[]
  /** Optional word timing frames for karaoke (unused in v1). */
  words?: { word: string; t: number; d: number }[]
  /** Trailing silence after this sentence, in seconds. */
  sentence_pause?: number
}

export interface SynthOptions {
  /** Resolved bare voice id (engine prefix already stripped). */
  voice: string
  /** 0.8–1.3 speech rate multiplier. */
  speechRate?: number
  /** For the cloning engine: absolute path to the reference WAV. */
  speakerWavPath?: string
  /** Abort the upstream sidecar fetch when the client disconnects. */
  signal?: AbortSignal
}

export interface TtsEngine {
  /** Engine slug, e.g. 'piper' | 'clone'. */
  readonly id: string
  /** Default bare voice id used when no character/user/app voice resolves. */
  readonly defaultVoice: string
  /** Synthesize a single sentence into a `SentencePayload`. */
  synthesize(sentence: string, opts: SynthOptions): Promise<SentencePayload>
  /** Is the backing sidecar reachable? */
  health(): Promise<boolean>
}
