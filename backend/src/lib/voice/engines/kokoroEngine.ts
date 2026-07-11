// Kokoro TTS engine — talks to the local Bun voice-server (`scripts/voice-server.ts`).
//
// Kokoro-82M (Apache-2.0) is fast, modern, and high quality for its size; ~50
// bundled voices (no cloning). Contract:
//   POST {url}/synthesize  { text, voice, speed } → audio/wav
//   GET  {url}/voices → { voices: [{ id, name, language, gender }] }
//   GET  {url}/health → 200

import { kokoroUrl } from '@/lib/voice/config'
import { wavToPcm } from '@/lib/voice/pcm'
import type { SentencePayload, SynthOptions, TtsEngine } from '@/lib/voice/types'

export const kokoroEngine: TtsEngine = {
  id: 'kokoro',
  defaultVoice: 'af_heart',

  async synthesize(sentence: string, opts: SynthOptions): Promise<SentencePayload> {
    const base = await kokoroUrl()
    const res = await fetch(`${base}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: sentence,
        voice: opts.voice || kokoroEngine.defaultVoice,
        speed: opts.speechRate ?? 1.0,
      }),
      // A wedged sidecar (accepts the socket, never responds) would otherwise hang
      // /api/tts/stream forever with the voice UI silent; 30s matches the podcast path.
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error('tts_engine_error')
    const { pcmB64, sampleRate } = wavToPcm(await res.arrayBuffer(), { gain: opts.gain })
    return { sentence, sample_rate: sampleRate, pcm_b64: pcmB64 }
  },

  async health(): Promise<boolean> {
    try {
      const base = await kokoroUrl()
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch {
      return false
    }
  },
}

export interface KokoroVoice {
  id: string
  name: string
  language?: string
  gender?: string
}

/** Fetch the bundled Kokoro voice list from the sidecar (for the admin picker). */
export async function listKokoroVoices(): Promise<KokoroVoice[]> {
  try {
    const base = await kokoroUrl()
    const res = await fetch(`${base}/voices`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const data = (await res.json()) as { voices?: KokoroVoice[] }
    return data.voices ?? []
  } catch {
    return []
  }
}
