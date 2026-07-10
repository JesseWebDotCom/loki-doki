// Engine registry + capability resolution. Engines are tried in priority order; the first
// that's available AND supports the (in → out) pair wins. vips outranks ffmpeg for images
// (faster, better quality, more codecs) but is optional — ffmpeg is the guaranteed floor.

import type { Engine, Capabilities, MediaFamily } from './types'
import { vipsEngine } from './engines/vips'
import { ffmpegEngine } from './engines/ffmpeg'
import { animEngine } from './engines/anim'
import { IMAGE, AUDIO, VIDEO, VIPS_IN, VIPS_OUT, ANIM_IMAGE, familyOf, animatedTargetsFor } from './formats'

// Priority order. anim is first so it claims the animation-preserving conversions (gif/webp ⇄
// video, gif ⇄ webp) before the still-image engines flatten them to one frame. vips outranks
// ffmpeg for the remaining still-image work.
const ENGINES: Engine[] = [animEngine, vipsEngine, ffmpegEngine]

/** Pick the highest-priority available engine that can do inExt → outExt, or null. */
export async function pickEngine(inExt: string, outExt: string): Promise<Engine | null> {
  const i = inExt.toLowerCase(), o = outExt.toLowerCase()
  // Both sides must be known media; each engine's supports() encodes the valid pairs (incl.
  // the few cross-family animation bridges), so no blanket same-family gate here.
  if (!familyOf(i) || !familyOf(o)) return null
  for (const e of ENGINES) {
    if (e.supports(i, o) && (await e.available())) return e
  }
  return null
}

/**
 * Build the per-family capability lists the frontend uses to populate its format picker.
 * Image coverage widens when vips is available (AVIF/HEIC/SVG-in); audio/video come from
 * ffmpeg, which is always present.
 */
export async function capabilities(): Promise<Capabilities> {
  const vipsOk = await vipsEngine.available()

  const imageInputs = vipsOk ? Array.from(new Set([...IMAGE, ...VIPS_IN])) : IMAGE
  const imageOutputs = vipsOk
    // ffmpeg can't write svg; union of what either available engine can output.
    ? Array.from(new Set([...IMAGE.filter((f) => f !== 'svg'), ...VIPS_OUT]))
    : IMAGE.filter((f) => f !== 'svg')

  const families: Record<MediaFamily, { inputs: string[]; outputs: string[] }> = {
    image: { inputs: imageInputs.sort(), outputs: imageOutputs.sort() },
    audio: { inputs: [...AUDIO].sort(), outputs: [...AUDIO].sort() },
    video: { inputs: [...VIDEO].sort(), outputs: [...VIDEO].sort() },
  }

  // Cross-family targets the anim engine adds: animated gif/webp → any video container, and
  // any video → animated gif/webp. Advertised unconditionally — the webp-decode dependency
  // (libwebp) auto-installs on first use, matching how ffmpeg/vips are handled.
  const animatedTargets: Record<string, string[]> = {}
  for (const e of [...ANIM_IMAGE, ...VIDEO]) animatedTargets[e] = animatedTargetsFor(e).sort()

  return { vipsAvailable: vipsOk, families, animatedTargets }
}
