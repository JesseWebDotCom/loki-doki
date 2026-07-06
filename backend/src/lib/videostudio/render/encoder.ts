// Export encoder selection for studio renders. Unlike lib/media/encoder.ts (HEVC for
// library storage), exports default to H.264 + AAC: the output is meant to be shared,
// and H.264 plays literally everywhere. Hardware first (VideoToolbox/NVENC), libx264
// fallback — same detect-then-verify approach as the HEVC selector.

import { detectHardware } from '@/lib/hwfit'
import { ensureFfmpeg, ffmpegHasEncoder } from '@/lib/ffmpeg'

export interface StudioEncoder {
  codec: string
  args: string[]
  hw: boolean
}

const CPU: StudioEncoder = { codec: 'libx264', args: ['-preset', 'veryfast', '-crf', '20'], hw: false }

let cached: Promise<StudioEncoder> | null = null

export function resolveStudioEncoder(): Promise<StudioEncoder> {
  cached ??= (async () => {
    const bin = await ensureFfmpeg()
    const hw = await detectHardware().catch(() => null)
    if (hw?.gpuVendor === 'apple' && await ffmpegHasEncoder(bin, 'h264_videotoolbox')) {
      return { codec: 'h264_videotoolbox', args: ['-b:v', '8M'], hw: true }
    }
    if (hw?.gpuVendor === 'nvidia' && await ffmpegHasEncoder(bin, 'h264_nvenc')) {
      return { codec: 'h264_nvenc', args: ['-preset', 'p5', '-cq', '23'], hw: true }
    }
    return CPU
  })()
  return cached
}

export const STUDIO_CPU_ENCODER = CPU
