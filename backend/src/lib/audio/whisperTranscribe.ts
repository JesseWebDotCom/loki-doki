// Source-agnostic local Whisper transcription: chunk an already-resolved audio file
// through the voice sidecar and return merged, timestamped segments. Extracted from
// the podcast transcribe job so podcasts and videos share the exact same chunking,
// retry, and old-sidecar-fallback logic instead of forking it. Callers own resolving
// (and cleaning up) their own audio source — this only knows ffmpeg + the sidecar.

import { ensureFfmpeg } from '@/lib/ffmpeg'
import { transcribeWav, transcribeWavTimed } from '@/lib/whisper'
import { whisperUrl } from '@/lib/voice/config'
import { maybeSpawnVoiceServer } from '@/lib/voiceServer'
import { mergeSegments, type TranscriptSegment } from '@/lib/podcast/transcripts'
import { logger } from '@/lib/logger'

// 5-minute decode chunks keep each sidecar request bounded (~9.6 MB of WAV) while the
// sidecar's own 30s/5s chunking supplies fine-grained timestamps inside each one.
const CHUNK_SEC = 300
// Fallback chunk length when the running sidecar predates the timestamped mode and can
// only transcribe Whisper's native 30s window per call.
const PLAIN_CHUNK_SEC = 30
// A decoded chunk at/below the bare WAV header size means we ran past the end.
const MIN_WAV_BYTES = 1024

/** The bundled voice sidecar answers /health; a plain whisper-server 404s it but answers
 *  its root. Either response proves something is listening and able to take /inference. */
export async function sttReachable(): Promise<boolean> {
  try {
    const base = await whisperUrl()
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) })
    if (res.ok) return true
  } catch { /* fall through to the root probe */ }
  try {
    const base = await whisperUrl()
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(2500) })
    return res.ok || res.status === 400 || res.status === 404
  } catch {
    return false
  }
}

/** Decode [offsetSec, offsetSec+chunkSec) of any audio file into 16 kHz mono WAV bytes. */
async function decodeChunkWav(ffmpeg: string, srcPath: string, offsetSec: number, chunkSec: number, signal: AbortSignal): Promise<Uint8Array> {
  const proc = Bun.spawn([
    ffmpeg, '-v', 'error',
    '-ss', String(offsetSec), '-t', String(chunkSec),
    '-i', srcPath,
    '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1',
  ], { stdout: 'pipe', stderr: 'pipe' })
  const onAbort = () => proc.kill()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const [bytes, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ])
    if (code !== 0) {
      const err = await new Response(proc.stderr).text().catch(() => '')
      throw new Error(`ffmpeg decode failed (code ${code}): ${err.slice(0, 200)}`)
    }
    return new Uint8Array(bytes)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Retry one chunk's transcription a couple times before giving up. The Whisper
 *  sidecar can 500 transiently on a single chunk (a decode hiccup, a momentary memory
 *  spike); without this, one blip aborts an entire multi-chunk transcription. Aborts and
 *  the "unreachable" transport error are not retried here (the reachability wait already
 *  handles a down sidecar; an aborted job should stop promptly). */
async function withChunkRetries<T>(fn: () => Promise<T>, signal: AbortSignal, attempts = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    if (signal.aborted) throw new Error('Aborted')
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = String(err)
      if (msg.includes('unreachable') || msg.includes('Aborted')) throw err
      if (i < attempts - 1) {
        logger.warn(`[whisper-transcribe] chunk failed (attempt ${i + 1}/${attempts}), retrying: ${msg.slice(0, 160)}`)
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
      }
    }
  }
  throw lastErr
}

export interface TranscribeAudioOptions {
  /** Hard stop so a runaway/misreported duration can't chunk forever. */
  maxSeconds: number
  /** Known total duration when available — improves the progress note and stop condition. */
  durationSec?: number
  onProgress?: (doneSec: number, totalSec: number, note: string) => void
  signal: AbortSignal
}

/** Chunks the audio, transcribes each chunk through the sidecar's timestamped mode
 *  (falling back to native-window chunks on old sidecars), offsets the timestamps, and
 *  returns the merged, deduped segments. Throws if the sidecar never comes up, or if no
 *  speech is found at all. */
export async function transcribeAudioFile(absPath: string, opts: TranscribeAudioOptions): Promise<TranscriptSegment[]> {
  const { signal, maxSeconds, durationSec = 0 } = opts
  const emit = opts.onProgress ?? (() => {})

  // The Whisper sidecar cold-starts in the background; give it a bounded window to
  // come up before the first chunk (model load can take a minute on first run).
  await maybeSpawnVoiceServer().catch(() => {})
  const deadline = Date.now() + 120_000
  while (!(await sttReachable())) {
    if (signal.aborted) throw new Error('Aborted')
    if (Date.now() > deadline) throw new Error('Voice server (Whisper) is not reachable')
    await new Promise((r) => setTimeout(r, 3000))
  }

  const ffmpeg = await ensureFfmpeg()
  const allSegments: TranscriptSegment[] = []
  let chunkSec = CHUNK_SEC
  let timedMode = true
  let offset = 0

  for (;;) {
    if (signal.aborted) throw new Error('Aborted')
    if (offset > maxSeconds) break
    emit(offset, durationSec || offset + chunkSec, durationSec
      ? `Transcribing ${Math.min(Math.round((offset / durationSec) * 100), 99)}%`
      : `Transcribing minute ${Math.round(offset / 60)}`)

    const wav = await decodeChunkWav(ffmpeg, absPath, offset, chunkSec, signal)
    if (wav.byteLength <= MIN_WAV_BYTES) break  // past the end of the audio

    if (timedMode) {
      const { text, segments } = await withChunkRetries(() => transcribeWavTimed(wav), signal)
      if (segments === null) {
        // Old sidecar: only the native 30s window per call is usable. Re-run this
        // span in 30s slices so nothing already decoded is wasted or skipped.
        logger.warn('[whisper-transcribe] sidecar has no timestamped mode; falling back to 30s chunks')
        timedMode = false
        chunkSec = PLAIN_CHUNK_SEC
        if (text.trim()) {
          allSegments.push({ startSec: offset, endSec: offset + PLAIN_CHUNK_SEC, text: text.trim() })
          offset += PLAIN_CHUNK_SEC
        }
        continue
      }
      for (const s of segments) {
        allSegments.push({ startSec: offset + s.start, endSec: offset + s.end, text: s.text })
      }
    } else {
      const text = await withChunkRetries(() => transcribeWav(wav), signal)
      if (text.trim()) {
        allSegments.push({ startSec: offset, endSec: offset + chunkSec, text: text.trim() })
      }
    }
    offset += chunkSec
  }

  if (!allSegments.length) throw new Error('No speech detected in the audio')
  return mergeSegments(allSegments)
}
