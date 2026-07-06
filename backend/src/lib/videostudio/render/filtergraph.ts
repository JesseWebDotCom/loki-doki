// EDL → ffmpeg filter_complex compiler. PURE — no IO, no DB — so it unit-tests without
// ffmpeg (see filtergraph.test.ts). Generalizes plex/cut/videoCut.ts's trim+concat graph:
// every clip gets a normalization chain (trim, speed, fps, scale-with-pad, SAR, pixel
// format; audio: atrim, atempo chain, resample, or silence when muted/absent) so concat
// is always legal across heterogeneous sources.

export interface RenderInput {
  /** Absolute path of the source file (one -i per unique path). */
  path: string
  hasAudio: boolean
}

export interface RenderClip {
  /** Index into the inputs array. */
  inputIndex: number
  in: number
  out: number
  speed: number
  muted: boolean
}

export interface RenderPlan {
  canvas: { width: number; height: number; fps: number }
  inputs: RenderInput[]
  clips: RenderClip[]
}

export interface CompiledGraph {
  /** Pre-input args, one entry per input: ['-i', path]. */
  inputArgs: string[]
  filterComplex: string
  /** Output mapping args: -map [outv] -map [outa]. */
  mapArgs: string[]
}

/** atempo only accepts 0.5–2.0 per instance; chain instances to reach 0.25–4. */
export function atempoChain(speed: number): string[] {
  if (speed === 1) return []
  const parts: number[] = []
  let remaining = speed
  while (remaining > 2) { parts.push(2); remaining /= 2 }
  while (remaining < 0.5) { parts.push(0.5); remaining /= 0.5 }
  parts.push(remaining)
  return parts.filter((p) => p !== 1).map((p) => `atempo=${round(p)}`)
}

const round = (n: number) => Math.round(n * 10000) / 10000

export function compileFilterGraph(plan: RenderPlan): CompiledGraph {
  if (plan.clips.length === 0) throw new Error('empty timeline: nothing to render')
  const { width, height, fps } = plan.canvas

  const inputArgs = plan.inputs.flatMap((i) => ['-i', i.path])
  const parts: string[] = []

  plan.clips.forEach((c, k) => {
    const src = plan.inputs[c.inputIndex]
    if (!src) throw new Error(`clip ${k} references missing input ${c.inputIndex}`)

    // Video: trim → reset PTS (divided by speed) → constant fps → fit inside the canvas
    // (contain: scale down to fit, pad to exact size) → square pixels → yuv420p.
    parts.push(
      `[${c.inputIndex}:v]trim=start=${round(c.in)}:end=${round(c.out)},` +
      `setpts=(PTS-STARTPTS)/${round(c.speed)},fps=${fps},` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${k}]`,
    )

    // Audio: real track (trimmed, retimed, resampled) or generated silence of the exact
    // post-speed duration, so concat always receives paired v+a streams.
    if (src.hasAudio && !c.muted) {
      const tempo = atempoChain(c.speed)
      parts.push(
        `[${c.inputIndex}:a]atrim=start=${round(c.in)}:end=${round(c.out)},asetpts=PTS-STARTPTS` +
        (tempo.length ? `,${tempo.join(',')}` : '') +
        `,aresample=48000[a${k}]`,
      )
    } else {
      const dur = round((c.out - c.in) / c.speed)
      parts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${dur}[a${k}]`)
    }
  })

  const concatIn = plan.clips.map((_, k) => `[v${k}][a${k}]`).join('')
  parts.push(`${concatIn}concat=n=${plan.clips.length}:v=1:a=1[outv][outa]`)

  return {
    inputArgs,
    filterComplex: parts.join(';'),
    mapArgs: ['-map', '[outv]', '-map', '[outa]'],
  }
}
