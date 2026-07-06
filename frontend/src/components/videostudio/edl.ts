// Frontend mirror of backend/src/lib/videostudio/edl.ts (house style: both sides own a
// copy; the backend zod schema is the enforcement point). Version 1 = single main video
// track with trim/speed/mute per clip.

export interface StudioVideoClip {
  id: string
  assetId: string
  in: number
  out: number
  speed: number
  muted: boolean
}

export interface StudioEdl {
  version: 1
  canvas: { width: number; height: number; fps: number }
  video: StudioVideoClip[]
}

export const DEFAULT_STUDIO_EDL: StudioEdl = {
  version: 1,
  canvas: { width: 1920, height: 1080, fps: 30 },
  video: [],
}

export const clipDurationSec = (c: StudioVideoClip): number => (c.out - c.in) / c.speed

export const edlDurationSec = (edl: StudioEdl): number =>
  edl.video.reduce((sum, c) => sum + clipDurationSec(c), 0)

/** Timeline start offset of clip k (main-track time is derived, never stored). */
export function clipStartSec(edl: StudioEdl, index: number): number {
  let t = 0
  for (let i = 0; i < index; i++) t += clipDurationSec(edl.video[i]!)
  return t
}

/** Map a timeline position to (clip index, source-time seconds inside that clip). */
export function locate(edl: StudioEdl, timelineSec: number): { index: number; sourceSec: number } | null {
  let t = timelineSec
  for (let i = 0; i < edl.video.length; i++) {
    const c = edl.video[i]!
    const dur = clipDurationSec(c)
    if (t <= dur || i === edl.video.length - 1) {
      return { index: i, sourceSec: Math.min(c.out, c.in + Math.max(0, t) * c.speed) }
    }
    t -= dur
  }
  return null
}
