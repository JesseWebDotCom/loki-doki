// whisper.cpp STT sidecar client. The user installs `whisper-server` separately
// (matching the XTTS/sd.cpp/kiwix "separate local service" pattern). We POST a
// finalized WAV utterance to its /inference endpoint and read back the text.
//
// whisper-server contract:
//   POST {WHISPER_URL}/inference   multipart: file=<wav>, response_format=json,
//        temperature=0, [prompt=<hotwords>]  →  { text: "..." }

import { whisperUrl } from '@/lib/voice/config'
import { logger } from '@/lib/logger'

export async function whisperHealth(): Promise<boolean> {
  try {
    const base = await whisperUrl()
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })
    return res.ok || res.status === 400 // server up but root not a valid route
  } catch {
    return false
  }
}

/**
 * Transcribe a finalized WAV utterance. Returns trimmed text, an empty string
 * means genuine silence/no-speech.
 *
 * THROWS on transport/HTTP failure so callers can distinguish "whisper is down"
 * from "no speech detected"; returning '' for both would make a dead sidecar
 * look like silence and silently swallow every utterance.
 *
 * NOTE: `_hotwords` is accepted for call-site compatibility but intentionally
 * not sent. The current request posts a raw audio/wav body; whisper-server's
 * `prompt`/hotwords biasing requires the multipart `file=` form, so wiring it up
 * would mean restructuring the request. Left as dead plumbing for now rather
 * than risk that change here.
 */
export async function transcribeWav(wav: Uint8Array, _hotwords?: string): Promise<string> {
  let res: Response
  try {
    const base = await whisperUrl()
    res = await fetch(`${base}/inference`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav as unknown as BodyInit,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    logger.warn(`[whisper] transcribe transport error: ${(e as Error).message}`)
    throw new Error(`whisper_unreachable: ${(e as Error).message}`)
  }
  if (!res.ok) {
    logger.warn(`[whisper] transcribe HTTP ${res.status}`)
    throw new Error(`whisper_http_${res.status}`)
  }
  const data = (await res.json()) as { text?: string }
  return (data.text ?? '').trim()
}
