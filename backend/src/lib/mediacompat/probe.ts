// Codec/container probe + browser-compat policy for stored media files.
//
// Most media the app serves is already normalized at acquisition time (yt-dlp forces
// h264/aac, voice memos are re-encoded to WAV). But some surfaces hold whatever the
// user gave us — studio uploads (mkv/mov/webm), scanned local music (flac/alac/opus/ape),
// downloaded podcast enclosures (ogg/opus) — and those can't be assumed playable in every
// browser (iOS Safari especially). This module answers "can a browser play this file
// as-is, and if not, what should we transcode it to?" One ffprobe call per file; results
// are cached by the compat store keyed on (path, mtime, size).

import { spawn } from 'node:child_process'
import { ensureFfmpeg, ffprobeBin } from '@/lib/ffmpeg'

export interface CompatProbe {
  /** ffprobe format_name — a comma list like "mov,mp4,m4a,3gp,3g2,mj2" or "matroska,webm". */
  containerFormat: string | null
  videoCodec: string | null
  audioCodec: string | null
  durationSec: number | null
  width: number | null
  height: number | null
  hasVideo: boolean
  hasAudio: boolean
}

export type MediaKind = 'video' | 'audio'

export interface CompatVerdict {
  kind: MediaKind
  compatible: boolean
  reasons: string[]
}

// Embedded cover art in audio files shows up as a "video" stream of a still-image codec.
const ART_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'tiff', 'webp'])

export async function probeCompat(absPath: string): Promise<CompatProbe> {
  await ensureFfmpeg()   // ffprobe ships alongside the managed ffmpeg
  const json = await new Promise<string>((resolve, reject) => {
    const proc = spawn(ffprobeBin(), [
      '-v', 'error', '-print_format', 'json',
      '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,disposition',
      absPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-1024) })
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `ffprobe exited ${code}`))))
    proc.on('error', reject)
  })

  const data = JSON.parse(json) as {
    format?: { duration?: string; format_name?: string }
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>
  }
  // First video stream that isn't attached cover art; first audio stream.
  const video = data.streams?.find((s) => s.codec_type === 'video' && !ART_CODECS.has(s.codec_name ?? ''))
  const audio = data.streams?.find((s) => s.codec_type === 'audio')
  const dur = parseFloat(data.format?.duration ?? '')
  return {
    containerFormat: data.format?.format_name ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    durationSec: Number.isFinite(dur) && dur > 0 ? dur : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasVideo: !!video,
    hasAudio: !!audio,
  }
}

const containerHas = (probe: CompatProbe, ...names: string[]): boolean => {
  const parts = (probe.containerFormat ?? '').split(',').map((s) => s.trim())
  return names.some((n) => parts.includes(n))
}

// Codecs every target browser (Chrome, Safari incl. iOS, Firefox) decodes. HEVC/VP9/AV1
// are deliberately absent — each is missing on at least one target, and the whole point
// here is "plays everywhere", so anything outside the intersection gets transcoded.
const OK_AUDIO_IN_VIDEO = new Set(['aac', 'mp3'])

export function decideCompat(probe: CompatProbe): CompatVerdict {
  if (probe.hasVideo) {
    const reasons: string[] = []
    if (!containerHas(probe, 'mp4', 'mov', 'm4a')) reasons.push(`container ${probe.containerFormat ?? 'unknown'}`)
    if (probe.videoCodec !== 'h264') reasons.push(`video codec ${probe.videoCodec ?? 'unknown'}`)
    if (probe.audioCodec && !OK_AUDIO_IN_VIDEO.has(probe.audioCodec)) reasons.push(`audio codec ${probe.audioCodec}`)
    return { kind: 'video', compatible: reasons.length === 0, reasons }
  }

  // Audio-only file. mp3/aac-in-m4a/flac/wav decode everywhere; opus/vorbis (Safari),
  // alac (Chrome/Firefox), ape/wma (everyone) don't.
  const a = probe.audioCodec
  const ok =
    (a === 'mp3' && containerHas(probe, 'mp3')) ||
    (a === 'aac' && containerHas(probe, 'mp4', 'm4a', 'mov', 'aac')) ||
    (a === 'flac' && containerHas(probe, 'flac')) ||
    (a?.startsWith('pcm_') === true && containerHas(probe, 'wav')) === true
  return { kind: 'audio', compatible: ok, reasons: ok ? [] : [`audio ${a ?? 'unknown'} in ${probe.containerFormat ?? 'unknown'}`] }
}
