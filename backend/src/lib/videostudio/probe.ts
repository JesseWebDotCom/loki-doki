// ffprobe wrapper for studio sources: one JSON call per file, cached by callers.
// Extends plex/cut's probeDurationSec with the fields the render planner and the
// bin UI need (dimensions, fps, codec, audio presence).

import { spawn } from 'node:child_process'
import { ensureFfmpeg, ffprobeBin } from '@/lib/ffmpeg'

export interface MediaProbe {
  durationSec: number | null
  width: number | null
  height: number | null
  fps: number | null
  videoCodec: string | null
  hasAudio: boolean
}

export async function probeMedia(absPath: string): Promise<MediaProbe> {
  await ensureFfmpeg()   // ffprobe ships alongside the managed ffmpeg
  const json = await new Promise<string>((resolve, reject) => {
    const proc = spawn(ffprobeBin(), [
      '-v', 'error', '-print_format', 'json',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate',
      absPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-1024) })
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `ffprobe exited ${code}`))))
    proc.on('error', reject)
  })

  const data = JSON.parse(json) as {
    format?: { duration?: string }
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }>
  }
  const video = data.streams?.find((s) => s.codec_type === 'video')
  const audio = data.streams?.find((s) => s.codec_type === 'audio')
  const dur = parseFloat(data.format?.duration ?? '')
  let fps: number | null = null
  const rate = video?.avg_frame_rate
  if (rate && rate.includes('/')) {
    const [n, d] = rate.split('/').map(Number)
    if (n && d) fps = n / d
  }
  return {
    durationSec: Number.isFinite(dur) && dur > 0 ? dur : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: fps && Number.isFinite(fps) ? Math.round(fps * 100) / 100 : null,
    videoCodec: video?.codec_name ?? null,
    hasAudio: !!audio,
  }
}
