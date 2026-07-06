// Frame-accurate SponsorBlock segment removal via ffmpeg trim+concat. Plex has no runtime
// segment-skip capability for personal libraries, so segments the user wants gone must be
// physically cut before the file is ever placed in the Plex tree (see project plan).
//
// Stream-copy cutting (`-ss`/`-to -c copy`) only cuts at keyframes — up to a whole GOP off
// the real boundary, unacceptable for ad edges. This re-encodes instead, via a
// trim+concat filter_complex graph: build a "keep" segment per gap between cut ranges,
// concat them back together.
//
// NOT yet tuned against real footage — libx264 veryfast/crf 20 is a reasonable default,
// not a measured one. Revisit once this has run against actual saved videos.

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { ensureFfmpeg, ffprobeBin } from '@/lib/ffmpeg'
import { logger } from '@/lib/logger'

export interface Range { start: number; end: number }

/** Merge overlapping/adjacent cut ranges, then invert against [0, durationSec] to get the
 *  ranges to KEEP. Pure function — no IO, easy to unit test independent of ffmpeg. */
export function computeKeepRanges(cutRanges: Range[], durationSec: number): Range[] {
  if (!cutRanges.length || durationSec <= 0) return [{ start: 0, end: durationSec }]
  const sorted = [...cutRanges].sort((a, b) => a.start - b.start)
  const merged: Range[] = []
  for (const r of sorted) {
    const clamped = { start: Math.max(0, r.start), end: Math.min(durationSec, r.end) }
    if (clamped.end <= clamped.start) continue
    const last = merged[merged.length - 1]
    if (last && clamped.start <= last.end) last.end = Math.max(last.end, clamped.end)
    else merged.push(clamped)
  }
  const keep: Range[] = []
  let cursor = 0
  for (const m of merged) {
    if (m.start > cursor) keep.push({ start: cursor, end: m.start })
    cursor = Math.max(cursor, m.end)
  }
  if (cursor < durationSec) keep.push({ start: cursor, end: durationSec })
  // Drop near-zero slivers (sub-50ms gaps between adjacent cuts aren't worth a concat edge).
  return keep.filter(r => r.end - r.start > 0.05)
}

export async function probeDurationSec(absPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', absPath], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', () => { const n = parseFloat(out.trim()); resolve(Number.isFinite(n) && n > 0 ? n : null) })
    proc.on('error', () => resolve(null))
  })
}

function tailStderr(buf: string, lines = 8): string {
  return buf.trim().split('\n').slice(-lines).join(' | ')
}

/**
 * Re-encode `inputPath` → `outputPath`, keeping only `keepRanges`. Caller (plex/cut runner)
 * is responsible for deciding whether cutting is needed at all — this always re-encodes,
 * even when keepRanges is a single full-length range, since callers should short-circuit
 * a no-op cut themselves (e.g. by placing the original directly) rather than pay for one.
 */
export async function cutVideo(inputPath: string, outputPath: string, keepRanges: Range[], signal?: AbortSignal): Promise<void> {
  if (!keepRanges.length) throw new Error('cutVideo: no ranges to keep — would produce an empty file')
  const bin = await ensureFfmpeg()

  const filterParts: string[] = []
  keepRanges.forEach((r, i) => {
    filterParts.push(`[0:v]trim=start=${r.start}:end=${r.end},setpts=PTS-STARTPTS[v${i}]`)
    filterParts.push(`[0:a]atrim=start=${r.start}:end=${r.end},asetpts=PTS-STARTPTS[a${i}]`)
  })
  const concatInputs = keepRanges.map((_, i) => `[v${i}][a${i}]`).join('')
  filterParts.push(`${concatInputs}concat=n=${keepRanges.length}:v=1:a=1[outv][outa]`)

  const args = [
    '-y', '-i', inputPath,
    '-filter_complex', filterParts.join(';'),
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k',
    outputPath,
  ]

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 64_000) err = err.slice(-32_000) })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('cancelled'))
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg cut exited ${code}: ${tailStderr(err)}`))
    })
  })

  const s = await stat(outputPath).catch(() => null)
  if (!s || s.size === 0) throw new Error('ffmpeg cut produced no output')
  logger.info(`[plex-cut] wrote ${outputPath} (${keepRanges.length} kept range(s))`)
}
