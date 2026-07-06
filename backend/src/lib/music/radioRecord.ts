// Timed live-radio capture worker (download-jobs type 'radio-record').
//
// Records N seconds of a live stream to a per-user mp3 via ffmpeg. Live audio is
// non-resumable — a capture that dies mid-way can't refetch the past — so the rules
// differ from byte downloads: the job never retries at the queue level (maxAttempts 1),
// dead-stream start failures retry inside the runner within the first seconds, and a
// mid-capture death KEEPS the partial file as 'ready' when at least MIN_KEEP_SEC landed.

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, unlink } from 'node:fs/promises'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/db'
import { musicRadioRecordings, users } from '@/db/schema'
import { ensureFfmpeg, ffprobeBin } from '@/lib/ffmpeg'
import { userPath, toRelativePath, resolveUserPath } from '@/lib/storage/paths'
import { assertPublicUrl } from '@/lib/ssrfGuard'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'

// Keep a partial capture when at least this much audio landed; below it the file is junk.
const MIN_KEEP_SEC = 30
// A spawn that produces no output within this window is a dead stream → internal retry.
const START_WINDOW_MS = 8_000
const START_RETRIES = 3

const execFileAsync = promisify(execFile)

// Active ffmpeg processes by recording id — lets the stop route finalize gracefully
// ("stop and keep") instead of cancelling the job (which discards).
const active = new Map<string, { proc: ChildProcess; requestedStop: boolean }>()

/** True while this recording's ffmpeg is running in this process. */
export function isRecordingActive(recordingId: string): boolean {
  return active.has(recordingId)
}

/** Graceful stop-and-keep: ask ffmpeg to finalize the file now. The runner then goes
 *  through its normal finish path (probe → ready), so the job completes rather than
 *  cancels. Returns false when the recording isn't running in this process. */
export function stopRecording(recordingId: string): boolean {
  const entry = active.get(recordingId)
  if (!entry) return false
  entry.requestedStop = true
  // 'q' on stdin is ffmpeg's clean-shutdown command (flushes + writes trailer);
  // fall back to SIGINT (also a clean stop) if stdin is gone or ignored.
  try {
    if (entry.proc.stdin?.writable) entry.proc.stdin.write('q')
    else entry.proc.kill('SIGINT')
  } catch {
    try { entry.proc.kill('SIGINT') } catch { /* already dead */ }
  }
  setTimeout(() => {
    if (active.has(recordingId)) { try { entry.proc.kill('SIGINT') } catch { /* gone */ } }
  }, 5_000)
  return true
}

/** Terminal-failure/cancel hook for the job queue: mark the row failed unless the runner
 *  already finalized it as ready (partial-keep). */
export async function failRecordingUnlessReady(recordingId: string, error: string): Promise<void> {
  await db.update(musicRadioRecordings)
    .set({ status: 'failed', error: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(musicRadioRecordings.id, recordingId), ne(musicRadioRecordings.status, 'ready')))
}

async function probeDurationSec(absPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(ffprobeBin(), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', absPath,
    ], { timeout: 20_000, windowsHide: true })
    const dur = Number.parseFloat(stdout.trim())
    return Number.isFinite(dur) && dur > 0 ? dur : null
  } catch {
    return null
  }
}

async function fileSize(absPath: string): Promise<number> {
  try { return (await stat(absPath)).size } catch { return 0 }
}

/** Probe the (possibly partial) output and settle the row: ready when ≥MIN_KEEP_SEC of
 *  audio landed, failed (file removed) otherwise. Returns true when kept. */
async function finalize(recordingId: string, absPath: string, relPath: string, failNote: string | null): Promise<boolean> {
  const duration = await probeDurationSec(absPath)
  if (duration && duration >= MIN_KEEP_SEC) {
    await db.update(musicRadioRecordings).set({
      status: 'ready', durationSec: duration, relPath,
      sizeBytes: await fileSize(absPath),
      error: failNote, updatedAt: new Date(),
    }).where(eq(musicRadioRecordings.id, recordingId))
    return true
  }
  try { await unlink(absPath) } catch { /* never written */ }
  await db.update(musicRadioRecordings).set({
    status: 'failed',
    error: (failNote ?? 'Stream produced no usable audio').slice(0, 500),
    updatedAt: new Date(),
  }).where(eq(musicRadioRecordings.id, recordingId))
  return false
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export async function runRadioRecordJob(
  recordingId: string,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const [row] = await db.select().from(musicRadioRecordings).where(eq(musicRadioRecordings.id, recordingId)).limit(1)
  if (!row) throw new Error(`Unknown recording ${recordingId}`)
  const [user] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, row.userId)).limit(1)
  if (!user) throw new Error(`Recording ${recordingId} has no user`)

  const absPath = await userPath(row.userId, user.firstName, 'radio-recordings', `${recordingId}.mp3`)
  const relPath = await toRelativePath(absPath)

  // Boot-resume guard: resumeDownloadJobs() flips running→pending on restart, but the live
  // window this capture was aimed at has passed — re-recording now would capture a different
  // hour than the user asked for. Settle whatever the previous process left on disk instead.
  if (row.status === 'recording') {
    const kept = await finalize(recordingId, absPath, relPath, 'Capture interrupted by a server restart')
    if (!kept) throw new Error('Recording interrupted by restart before enough audio was captured')
    return
  }
  if (row.status === 'ready' || row.status === 'failed') return  // stale duplicate job

  // Belt-and-suspenders: the URL was validated at add time, but ffmpeg fetches it directly
  // (outside safeFetch), so re-assert it hasn't started pointing somewhere private.
  await assertPublicUrl(row.streamUrl)
  const ffmpeg = await ensureFfmpeg()

  await db.update(musicRadioRecordings).set({ status: 'recording', updatedAt: new Date() })
    .where(eq(musicRadioRecordings.id, recordingId))

  // MP3 stations re-mux (-c copy); everything else (AAC/OGG/…) transcodes to mp3 so the
  // library serves exactly one content type and the podcasts Range route pattern applies.
  const copyCodec = row.codec?.toUpperCase() === 'MP3'
  let startAttempt = 0

  for (;;) {
    // stdin stays open (no -nostdin): 'q' on stdin is the graceful stop-and-keep channel.
    const args = [
      '-hide_banner', '-y',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
      '-user_agent', 'LokiDoki/3.0 radio-recorder',
      '-i', row.streamUrl,
      '-t', String(row.requestedSec),
      ...(copyCodec ? ['-c:a', 'copy'] : ['-c:a', 'libmp3lame', '-b:a', '160k']),
      '-f', 'mp3', absPath,
    ]
    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    const entry = { proc, requestedStop: false }
    active.set(recordingId, entry)

    let stderrTail = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-800)
    })

    const startedAt = Date.now()
    const progressTimer = setInterval(() => {
      const elapsed = Math.min((Date.now() - startedAt) / 1000, row.requestedSec)
      onProgress({
        completed: Math.round(elapsed), total: row.requestedSec, speedBps: 0, etaSeconds: Math.max(0, Math.round(row.requestedSec - elapsed)), status: 'downloading',
        note: `Recording — ${fmtClock(elapsed)} / ${fmtClock(row.requestedSec)}`,
      })
    }, 2_000)

    const onAbort = () => { try { proc.kill('SIGKILL') } catch { /* gone */ } }
    signal.addEventListener('abort', onAbort, { once: true })

    const exitCode = await new Promise<number | null>(resolve => {
      proc.on('close', code => resolve(code))
      proc.on('error', () => resolve(null))
    })

    clearInterval(progressTimer)
    signal.removeEventListener('abort', onAbort)
    active.delete(recordingId)

    const ranMs = Date.now() - startedAt
    const bytes = await fileSize(absPath)

    // Dead/404 stream: exited almost immediately with nothing written → internal retry.
    // These are the only retries a recording gets (job maxAttempts is 1 by design).
    if (!signal.aborted && !entry.requestedStop && ranMs < START_WINDOW_MS && bytes === 0) {
      if (++startAttempt < START_RETRIES) {
        logger.warn(`[radio] recording ${recordingId}: stream failed to start (attempt ${startAttempt}/${START_RETRIES}) — ${stderrTail.split('\n').at(-1) ?? ''}`)
        await new Promise(r => setTimeout(r, 2_000))
        continue
      }
      await finalize(recordingId, absPath, relPath, `Stream failed to start: ${stderrTail.split('\n').filter(Boolean).at(-1) ?? 'no data received'}`)
      throw new Error(`Stream failed to start after ${START_RETRIES} attempts`)
    }

    // Everything else settles on what's on disk: a clean finish (or user stop) probes and
    // goes ready; a mid-capture disconnect keeps ≥MIN_KEEP_SEC as a partial (you can't
    // re-record the past); an abort (user cancelled the job / shutdown) settles the same way.
    const failNote = entry.requestedStop || (exitCode === 0)
      ? null
      : `ffmpeg exited ${exitCode ?? 'with an error'} mid-capture: ${stderrTail.split('\n').filter(Boolean).at(-1) ?? ''}`
    const kept = await finalize(recordingId, absPath, relPath, failNote)
    if (!kept && !entry.requestedStop) {
      throw new Error(failNote ?? 'Recording produced no usable audio')
    }
    onProgress({ completed: row.requestedSec, total: row.requestedSec, speedBps: 0, etaSeconds: 0, status: 'completed', note: 'Recording saved' })
    return
  }
}

/** Delete a recording's audio file (best-effort; row deletion is the caller's job). */
export async function unlinkRecordingFile(relPath: string | null): Promise<void> {
  if (!relPath) return
  try { await unlink(await resolveUserPath(relPath)) } catch { /* already gone */ }
}
