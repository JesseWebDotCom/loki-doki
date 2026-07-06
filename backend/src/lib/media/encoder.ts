// Hardware-aware H.264 encoder selection for video enhancement re-encodes.
//
// hwfit detects the GPU, but it's ComfyUI-only and knows nothing about ffmpeg encoders — and
// ensureFfmpeg() may resolve a PATH build that lacks a given hardware encoder. So we detect the
// GPU here, then *verify* the ffmpeg we'll actually run advertises the encoder before committing
// to it (ensureNvencFfmpeg() will pull an NVENC-capable managed build when an NVIDIA GPU is
// present but the current binary lacks it). Hardware encode is preferred for speed; libx264 is
// the quality fallback. The filters themselves always run on CPU (cheap) — only the encode is
// hardware-accelerated, which keeps the filter graph identical across encoders.

import { detectHardware } from '@/lib/hwfit'
import { ensureFfmpeg, ensureNvencFfmpeg, ffmpegHasEncoder } from '@/lib/ffmpeg'

export interface VideoEncoder {
  codec: string
  args: string[]
  hw: boolean
}

/** CPU fallback — best quality-per-bitrate, slowest. Also the runtime fallback when a hardware
 *  encode fails to initialize (see enhance.ts). */
export const CPU_ENCODER: VideoEncoder = { codec: 'libx264', args: ['-preset', 'fast', '-crf', '18'], hw: false }

let cached: Promise<VideoEncoder> | null = null

/** Pick the best available H.264 encoder and make sure the ffmpeg we'll run actually has it.
 *  Cached — hardware doesn't change at runtime. */
export function resolveVideoEncoder(): Promise<VideoEncoder> {
  if (cached) return cached
  cached = (async () => {
    const hw = await detectHardware()

    // NVIDIA → NVENC (guaranteeing an NVENC-capable ffmpeg first).
    if (hw.cudaDevices.length > 0) {
      const bin = await ensureNvencFfmpeg()
      if (await ffmpegHasEncoder(bin, 'h264_nvenc')) {
        return { codec: 'h264_nvenc', args: ['-preset', 'p4', '-cq', '19', '-b:v', '0'], hw: true }
      }
    }

    // Apple Silicon / macOS → VideoToolbox.
    if (hw.platform === 'darwin') {
      const bin = await ensureFfmpeg()
      if (await ffmpegHasEncoder(bin, 'h264_videotoolbox')) {
        return { codec: 'h264_videotoolbox', args: ['-q:v', '60'], hw: true }
      }
    }

    return CPU_ENCODER
  })()
  cached.catch(() => { cached = null })  // allow a retry if detection/resolution failed
  return cached
}
