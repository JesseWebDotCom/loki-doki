// The 'media-compat' job runner: one ffmpeg pass turning an incompatible stored file
// into an H.264/AAC MP4 (or audio-only M4A), written atomically (.tmp → rename) so a
// half-written rendition is never served. Compute-lane job — the 'transcode' domain
// serializes to one encode at a time, and the encode is thread-capped + deprioritized
// (see lib/ffmpeg.ts ENCODE_THREADS notes) so it never takes the box down.

import { spawn } from 'node:child_process'
import { rename, rm, stat, mkdir } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { mediaCompatCache } from '@/db/schema'
import { ensureFfmpeg, ENCODE_THREADS, deprioritizeEncode } from '@/lib/ffmpeg'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'
import { type CompatProbe, probeCompat } from './probe'
import { entryOutPath, getEntry, getTranscodeCrf, TRANSCODE_CACHE_DIR } from './store'

export interface MediaCompatJobPayload { cacheId: string }

let tmpSeq = 0

/** Args for the conversion, shared by the cached-file job and the live pipe.
 *  Copy streams that are already target-codec (h264/aac) — a remux is 10-100× faster
 *  than a re-encode and bit-identical in quality (the common mkv h264+dts case only
 *  re-encodes its audio). */
export function buildConvertArgs(probe: CompatProbe, variant: 'video' | 'audio', crf: number): string[] {
  const args: string[] = []
  if (variant === 'audio' || !probe.hasVideo) {
    args.push('-vn', '-sn')
    if (probe.audioCodec === 'aac') args.push('-c:a', 'copy')
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2')
  } else {
    args.push('-map', '0:v:0')
    if (probe.hasAudio) args.push('-map', '0:a:0')
    args.push('-sn', '-dn', '-map_chapters', '-1')
    if (probe.videoCodec === 'h264') args.push('-c:v', 'copy')
    else {
      args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
        '-pix_fmt', 'yuv420p',
        // libx264 requires even dimensions with yuv420p; odd-sized sources otherwise fail.
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-threads', ENCODE_THREADS,
      )
    }
    if (probe.hasAudio) {
      if (probe.audioCodec === 'aac' || probe.audioCodec === 'mp3') args.push('-c:a', 'copy')
      else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2')
    }
  }
  return args
}

export async function runMediaCompatJob(
  payload: MediaCompatJobPayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const row = await getEntry(payload.cacheId)
  if (!row) return   // entry evicted between enqueue and run — nothing to do
  if (row.status === 'ready') return
  await db.update(mediaCompatCache).set({ status: 'running', updatedAt: new Date() }).where(eq(mediaCompatCache.id, row.id))

  await stat(row.srcPath)   // missing source → throw → job fail → row failed via hook
  await mkdir(TRANSCODE_CACHE_DIR, { recursive: true })
  const bin = await ensureFfmpeg()

  let probe: CompatProbe | null = null
  try { probe = row.probeJson ? (JSON.parse(row.probeJson) as CompatProbe) : null } catch { /* re-probe */ }
  if (!probe) probe = await probeCompat(row.srcPath)

  const outPath = entryOutPath(row)
  // Unique per attempt so two writers (e.g. a retry racing a straggler) can never
  // corrupt each other's partial output; the sweep reclaims stale *.tmp files.
  // pid + a monotonic counter — two attempts in the same process can start within
  // one millisecond, so a timestamp alone is NOT unique.
  const tmpPath = `${outPath}.${process.pid}-${++tmpSeq}.tmp`
  const durationSec = probe.durationSec ?? 0
  const crf = await getTranscodeCrf()
  const args = [
    '-y', '-nostdin', '-v', 'error',
    '-i', row.srcPath,
    ...buildConvertArgs(probe, row.variant as 'video' | 'audio', crf),
    '-movflags', '+faststart',
    '-f', row.variant === 'audio' || !probe.hasVideo ? 'ipod' : 'mp4',
    '-progress', 'pipe:1',
    tmpPath,
  ]

  logger.info(`[media-compat] transcoding ${row.srcPath} → ${row.id}.${row.outExt}`)
  let lastPctWrite = 0
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    deprioritizeEncode(proc.pid)
    let err = ''
    proc.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2048) })
    proc.stdout?.on('data', (d: Buffer) => {
      // -progress pipe:1 emits key=value lines; out_time_us tracks the encode clock.
      const m = /out_time_us=(\d+)/.exec(d.toString())
      if (!m || durationSec <= 0) return
      const pct = Math.min(99, Math.round((Number(m[1]) / 1e6 / durationSec) * 100))
      onProgress({ completed: pct, total: 100, speedBps: 0, etaSeconds: 0, status: `${pct}%` })
      const now = Date.now()
      if (now - lastPctWrite > 2000) {
        lastPctWrite = now
        db.update(mediaCompatCache).set({ progressPct: pct, updatedAt: new Date() }).where(eq(mediaCompatCache.id, row.id)).catch(() => {})
      }
    })
    const onAbort = () => { try { proc.kill('SIGKILL') } catch { /* already gone */ } }
    signal.addEventListener('abort', onAbort, { once: true })
    proc.on('error', (e) => { signal.removeEventListener('abort', onAbort); reject(e) })
    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'))
      else if (code === 0) resolve()
      else reject(new Error(err.trim() || `ffmpeg exited ${code}`))
    })
  }).catch(async (e) => {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw e
  })

  const outStat = await stat(tmpPath)
  if (outStat.size === 0) { await rm(tmpPath, { force: true }).catch(() => {}); throw new Error('transcode produced an empty file') }
  await rename(tmpPath, outPath)
  await db.update(mediaCompatCache)
    .set({ status: 'ready', progressPct: 100, sizeBytes: outStat.size, error: null, updatedAt: new Date() })
    .where(eq(mediaCompatCache.id, row.id))
  logger.info(`[media-compat] ✓ ${row.id} (${Math.round(outStat.size / 1024 / 1024)} MB)`)
}

/** Terminal-failure hook (called from downloadJobs when attempts are exhausted) so a
 *  player polling /api/compat/status sees 'failed' + the reason instead of waiting forever. */
export async function failMediaCompatByJobRefId(refId: string, error: string): Promise<void> {
  try {
    const { cacheId } = JSON.parse(refId) as MediaCompatJobPayload
    await db.update(mediaCompatCache)
      .set({ status: 'failed', error: error.slice(0, 500), updatedAt: new Date() })
      .where(eq(mediaCompatCache.id, cacheId))
  } catch { /* best-effort */ }
}
