// Edit-decision-list (EDL) document for the Create studio. Version 1 covers the v1a
// feature set: a single main video track (ordered clips, ripple model, no gaps) with
// per-clip trim/speed/mute and project-level canvas settings. Tracks for overlays,
// music/voice, text, and captions arrive in later versions — the version field gates
// migration. The zod schema is the single validation point (routes + render both use
// it); frontend mirrors the TypeScript types in components/videostudio/edl.ts.

import { z } from 'zod'

// DoS guards: a filter_complex with hundreds of nodes will grind ffmpeg; these caps are
// far above any realistic home edit (mirrors image.ts's dimension clamps in spirit).
export const MAX_CLIPS = 60
export const MAX_OUTPUT_SEC = 30 * 60

export const videoClipSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  /** Source in/out points, seconds. */
  in: z.number().min(0),
  out: z.number().gt(0),
  speed: z.number().min(0.25).max(4).default(1),
  muted: z.boolean().default(false),
}).refine((c) => c.out > c.in, { message: 'clip out must be after in' })

export const canvasSchema = z.object({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(3840),
  fps: z.number().int().min(15).max(60),
})

export const edlSchema = z.object({
  version: z.literal(1),
  canvas: canvasSchema,
  video: z.array(videoClipSchema).max(MAX_CLIPS),
})

export type Edl = z.infer<typeof edlSchema>
export type VideoClip = z.infer<typeof videoClipSchema>

export const DEFAULT_EDL: Edl = {
  version: 1,
  canvas: { width: 1920, height: 1080, fps: 30 },
  video: [],
}

/** Post-speed duration of one clip. */
export function clipDurationSec(c: VideoClip): number {
  return (c.out - c.in) / c.speed
}

/** Timeline duration: main-track time is derived (cumulative clip durations), never stored. */
export function edlDurationSec(edl: Edl): number {
  return edl.video.reduce((sum, c) => sum + clipDurationSec(c), 0)
}

/** Every media_assets id the document references (drives studio_project_assets pinning). */
export function edlAssetIds(edl: Edl): string[] {
  return [...new Set(edl.video.map((c) => c.assetId))]
}

/** Parse + validate an EDL JSON string. Throws with a readable message on bad input. */
export function parseEdl(json: string): Edl {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('EDL is not valid JSON')
  }
  const result = edlSchema.safeParse(raw)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(`EDL invalid: ${first?.path.join('.')} ${first?.message}`)
  }
  const edl = result.data
  if (edlDurationSec(edl) > MAX_OUTPUT_SEC) {
    throw new Error(`Project is longer than the ${MAX_OUTPUT_SEC / 60}-minute export limit`)
  }
  return edl
}
