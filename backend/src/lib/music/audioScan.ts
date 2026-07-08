// Per-track audio facts scanner: one ffprobe (codec/bitrate/sampleRate/channels/duration)
// plus one ffmpeg decode pass that yields BOTH the EBU R128 integrated loudness and a
// ~640-bucket waveform envelope. Runs in-process with concurrency 1 and per-ref dedupe —
// deliberately NOT a download_jobs row: prefetch fires on nearly every radio play, and
// job-table churn would drown the admin queue for work that takes ~2s.

import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { musicTrackAudio } from '@/db/schema'
import { resolveAudioFile } from '@/lib/music/trackRef'
import { ensureFfmpeg, ffprobeBin } from '@/lib/ffmpeg'
import { logger } from '@/lib/logger'

const PEAK_BUCKETS = 640
const MAX_SCAN_DURATION_SEC = 15 * 60   // skip LUFS/peaks for hour-long mixes; keep the probe facts
const DECODE_RATE = 4000                // mono 4 kHz s16le — plenty for an envelope, decodes fast

const queue: string[] = []
const queued = new Set<string>()
let running = false

/** Fire-and-forget: scan `ref` if its audio is on disk and no row exists yet. */
export function queueAudioScan(ref: string): void {
  if (queued.has(ref)) return
  queued.add(ref)
  queue.push(ref)
  if (!running) void drain()
}

async function drain(): Promise<void> {
  running = true
  while (queue.length) {
    const ref = queue.shift()!
    try {
      await scanRef(ref)
    } catch (err) {
      logger.debug(`[audio-scan] ${ref} failed: ${String(err)}`)
    } finally {
      queued.delete(ref)
    }
  }
  running = false
}

async function scanRef(ref: string): Promise<void> {
  const [existing] = await db.select({ ref: musicTrackAudio.ref }).from(musicTrackAudio)
    .where(eq(musicTrackAudio.ref, ref)).limit(1)
  if (existing) return
  const absPath = await resolveAudioFile(ref)
  if (!absPath) return   // not on disk (never downloaded / evicted / plex-remote) — retry on a later trigger
  await scanAudioFile(ref, absPath)
}

interface ProbeFacts {
  codec: string | null; bitrateKbps: number | null; sampleRate: number | null
  channels: number | null; durationSec: number | null
}

async function probe(absPath: string): Promise<ProbeFacts> {
  await ensureFfmpeg()   // the managed bundle ships ffprobe alongside ffmpeg
  const bin = ffprobeBin()
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', absPath], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let buf = ''
    child.stdout.on('data', (d: Buffer) => { buf += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(buf) : reject(new Error(`ffprobe exited ${code}`)))
  })
  const data = JSON.parse(out) as {
    format?: { duration?: string; bit_rate?: string }
    streams?: Array<{ codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number; bit_rate?: string }>
  }
  const audio = data.streams?.find((s) => s.codec_type === 'audio')
  const bitrate = Number(audio?.bit_rate ?? data.format?.bit_rate ?? 0)
  return {
    codec: audio?.codec_name?.toUpperCase() ?? null,
    bitrateKbps: bitrate > 0 ? Math.round(bitrate / 1000) : null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    channels: audio?.channels ?? null,
    durationSec: data.format?.duration ? Number(data.format.duration) : null,
  }
}

interface DecodeResult { lufs: number | null; truePeakDb: number | null; peaks: Buffer }

/** One decode pass: pcm to stdout (bucketed into the envelope) + ebur128 stats on stderr. */
async function decodePass(ff: string, absPath: string, durationSec: number): Promise<DecodeResult> {
  return new Promise<DecodeResult>((resolve, reject) => {
    const child = spawn(ff, [
      '-hide_banner', '-nostats', '-i', absPath,
      '-map', 'a:0', '-ac', '1', '-ar', String(DECODE_RATE),
      '-af', 'ebur128=peak=true', '-f', 's16le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

    const totalSamples = Math.max(1, Math.round(durationSec * DECODE_RATE))
    const samplesPerBucket = Math.max(1, Math.ceil(totalSamples / PEAK_BUCKETS))
    const buckets = new Uint8Array(PEAK_BUCKETS)
    let sampleIdx = 0
    let carry: Buffer | null = null

    child.stdout.on('data', (chunk: Buffer) => {
      let data = carry ? Buffer.concat([carry, chunk]) : chunk
      const usable = data.length - (data.length % 2)
      carry = usable < data.length ? data.subarray(usable) : null
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(data.readInt16LE(i))
        const b = Math.min(PEAK_BUCKETS - 1, Math.floor(sampleIdx / samplesPerBucket))
        const scaled = v >> 7   // 0..32767 → 0..255
        if (scaled > buckets[b]!) buckets[b] = scaled
        sampleIdx++
      }
    })

    let err = ''
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 64_000) err = err.slice(-32_000) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg decode exited ${code}`))
      // ebur128 summary lands at the end of stderr:  "I: -14.2 LUFS" / "Peak: -0.4 dBFS"
      const lufsMatch = err.match(/I:\s*(-?[\d.]+)\s*LUFS/g)?.pop()?.match(/(-?[\d.]+)/)
      const peakMatch = err.match(/Peak:\s*(-?[\d.]+)\s*dBFS/g)?.pop()?.match(/(-?[\d.]+)/)
      resolve({
        lufs: lufsMatch ? Number(lufsMatch[1]) : null,
        truePeakDb: peakMatch ? Number(peakMatch[1]) : null,
        peaks: Buffer.from(buckets),
      })
    })
  })
}

/** Scan one on-disk file into music_track_audio (upsert). Exposed for lazy/manual triggers. */
export async function scanAudioFile(ref: string, absPath: string): Promise<void> {
  const facts = await probe(absPath)
  let lufs: number | null = null
  let truePeakDb: number | null = null
  let peaks: Buffer | null = null
  if (facts.durationSec && facts.durationSec <= MAX_SCAN_DURATION_SEC) {
    const ff = await ensureFfmpeg()
    const dec = await decodePass(ff, absPath, facts.durationSec)
    lufs = dec.lufs
    truePeakDb = dec.truePeakDb
    peaks = dec.peaks
  }
  const row = { ref, ...facts, lufs, truePeakDb, peaks, scannedAt: new Date() }
  await db.insert(musicTrackAudio).values(row)
    .onConflictDoUpdate({ target: musicTrackAudio.ref, set: { ...row } })
}
