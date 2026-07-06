// Hardware-aware HEVC (H.265) encoder selection for video enhancement re-encodes.
//
// HEVC is the default because it's ~half the size of H.264 at matched quality while still
// hardware-encoding fast on the platforms we run (Apple VideoToolbox, NVIDIA NVENC) and
// direct-playing in Safari + Plex. hwfit detects the GPU, but it's ComfyUI-only and knows
// nothing about ffmpeg encoders — and ensureFfmpeg() may resolve a PATH build that lacks a
// given hardware encoder. So we detect the GPU here, then *verify* the ffmpeg we'll actually
// run advertises the encoder before committing to it (ensureNvencFfmpeg() pulls an NVENC-capable
// managed build when an NVIDIA GPU is present but the current binary lacks it). Hardware encode
// is preferred for speed; libx265 is the quality fallback. The filters run on CPU (cheap) — only
// the encode is hardware-accelerated, so the filter graph is identical across encoders.
//
// HEVC in MP4 needs the `hvc1` tag (not the default `hev1`) or Safari/QuickTime/Plex refuse it.

import { detectHardware } from '@/lib/hwfit'
import { ensureFfmpeg, ensureNvencFfmpeg, ffmpegHasEncoder } from '@/lib/ffmpeg'

export interface VideoEncoder {
  codec: string
  args: string[]
  hw: boolean
}

/** CPU fallback — best quality-per-bitrate, slowest. Also the runtime fallback when a hardware
 *  encode fails to initialize (see enhance.ts). libx265 rather than libx264 to keep the whole
 *  pipeline HEVC (half-size output) regardless of which encoder actually ran. */
export const CPU_ENCODER: VideoEncoder = { codec: 'libx265', args: ['-preset', 'fast', '-crf', '20', '-tag:v', 'hvc1'], hw: false }

let cached: Promise<VideoEncoder> | null = null

/** Pick the best available HEVC encoder and make sure the ffmpeg we'll run actually has it.
 *  Cached — hardware doesn't change at runtime. */
export function resolveVideoEncoder(): Promise<VideoEncoder> {
  if (cached) return cached
  cached = (async () => {
    const hw = await detectHardware()

    // NVIDIA → NVENC HEVC (guaranteeing an NVENC-capable ffmpeg first).
    if (hw.cudaDevices.length > 0) {
      const bin = await ensureNvencFfmpeg()
      if (await ffmpegHasEncoder(bin, 'hevc_nvenc')) {
        return { codec: 'hevc_nvenc', args: ['-preset', 'p4', '-cq', '23', '-b:v', '0', '-tag:v', 'hvc1'], hw: true }
      }
    }

    // Apple Silicon / macOS → VideoToolbox HEVC.
    if (hw.platform === 'darwin') {
      const bin = await ensureFfmpeg()
      if (await ffmpegHasEncoder(bin, 'hevc_videotoolbox')) {
        return { codec: 'hevc_videotoolbox', args: ['-q:v', '60', '-tag:v', 'hvc1'], hw: true }
      }
    }

    return CPU_ENCODER
  })()
  cached.catch(() => { cached = null })  // allow a retry if detection/resolution failed
  return cached
}
