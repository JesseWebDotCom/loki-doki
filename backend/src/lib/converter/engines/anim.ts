// Animation-aware engine — the only one that crosses media families, and only for the
// conversions where that makes sense: animated images (gif/webp) ⇄ video, and gif ⇄ webp.
// It always keeps motion (every frame), which is exactly what the still-image engines throw
// away (they force `-frames:v 1`).
//
// The hard part is animated WebP as *input*: ffmpeg cannot decode it, so we composite it to
// full-canvas PNG frames with libwebp's anim_dump (durations from webpmux) and feed ffmpeg a
// concat demuxer. gif and video inputs ffmpeg decodes natively. Output encoders are chosen
// automatically — no user-facing "method" knob: gif → high-quality palettegen/paletteuse,
// webp → ffmpeg's libwebp_anim, video → H.264/yuv420p.

import { spawn } from 'node:child_process'
import { stat, mkdir, mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { dataDir } from '@/lib/download'
import { ensureFfmpeg, ensureWebpFfmpeg } from '@/lib/ffmpeg'
import { ensureLibwebp, animDumpBin, webpmuxBin } from '@/lib/libwebp'
import { familyOf } from '../formats'
import type { Engine, EngineRunArgs } from '../types'

function ext(s: string): string { return s.replace(/^\./, '').toLowerCase() }
function tailStderr(buf: string, lines = 6): string { return buf.trim().split('\n').slice(-lines).join('\n') }

// Image formats that can carry animation (so are worth transcoding frame-by-frame).
const ANIM_IMG = new Set(['gif', 'webp'])

const FRAMES_ROOT = join(dataDir, 'tmp', 'converter-frames')

/** Spawn a process, reject on non-zero/abort, tag errors with a stderr tail. */
function run(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 64_000) err = err.slice(-32_000) })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('cancelled'))
      if (code === 0) resolve()
      else reject(new Error(`${bin.split('/').pop()} exited ${code}: ${tailStderr(err)}`))
    })
  })
}

/** Spawn a process and capture stdout (for webpmux -info). */
function capture(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', () => { signal?.removeEventListener('abort', onAbort); resolve(out) })
  })
}

/** Detect an animated WebP without any external tool: a static WebP is a bare VP8/VP8L
 *  bitstream; an animated one is an extended (VP8X) file whose flags byte has the anim bit. */
async function isAnimatedWebp(path: string): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(21)
    const { bytesRead } = await fh.read(buf, 0, 21, 0)
    if (bytesRead < 21) return false
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return false
    if (buf.toString('ascii', 12, 16) !== 'VP8X') return false // simple (static) webp
    return ((buf[20] ?? 0) & 0x02) !== 0 // VP8X flags: bit 1 = animation
  } finally { await fh.close() }
}

/** Composite an animated WebP into PNG frames + per-frame durations (ms). */
async function dumpWebpFrames(inPath: string, outDir: string, signal?: AbortSignal): Promise<{ files: string[]; durationsMs: number[] }> {
  // webpmux -info lists a per-frame table; duration is the 7th column of each "N: ..." row.
  const info = await capture(webpmuxBin(), ['-info', inPath], signal)
  const durationsMs: number[] = []
  for (const line of info.split('\n')) {
    const m = line.match(/^\s*\d+:\s+\d+\s+\d+\s+\S+\s+\d+\s+\d+\s+(\d+)/)
    if (m?.[1]) durationsMs.push(parseInt(m[1], 10))
  }
  // anim_dump writes fully-composited frames as <prefix>0000.png, 0001.png, …
  await run(animDumpBin(), ['-folder', outDir, '-prefix', 'fr_', inPath], signal)
  const files = (await readdir(outDir)).filter((f) => f.startsWith('fr_') && f.endsWith('.png')).sort().map((f) => join(outDir, f))
  return { files, durationsMs }
}

/** Build an ffmpeg concat-demuxer script honouring per-frame durations. The last frame's
 *  duration is only respected if its file is repeated, so we append it once more. */
function buildConcat(files: string[], durationsMs: number[]): string {
  const esc = (p: string) => p.replace(/'/g, "'\\''")
  const lines: string[] = []
  files.forEach((f, i) => {
    lines.push(`file '${esc(f)}'`)
    lines.push(`duration ${((durationsMs[i] ?? durationsMs[durationsMs.length - 1] ?? 100) / 1000).toFixed(4)}`)
  })
  const last = files[files.length - 1]
  if (last) lines.push(`file '${esc(last)}'`)
  return lines.join('\n') + '\n'
}

export const animEngine: Engine = {
  name: 'anim',

  // ffmpeg is the floor and always resolves; libwebp is only needed for animated-webp input
  // and is ensured lazily inside run() so gif/video conversions never depend on it.
  async available(): Promise<boolean> { await ensureFfmpeg(); return true },

  supports(inExt: string, outExt: string): boolean {
    const i = ext(inExt), o = ext(outExt)
    if (i === o) return false
    const fi = familyOf(i), fo = familyOf(o)
    if (!fi || !fo) return false
    const iAnim = ANIM_IMG.has(i), oAnim = ANIM_IMG.has(o)
    if (iAnim && fo === 'video') return true // animated image → video
    if (fi === 'video' && oAnim) return true // video → animated image
    if (iAnim && oAnim) return true          // gif ⇄ webp
    return false
  },

  async run({ inPath, outPath, outExt, quality, signal }: EngineRunArgs): Promise<void> {
    const inExt = ext(extname(inPath))
    const o = ext(outExt)
    let framesDir: string | null = null

    try {
      // ── Input: give ffmpeg something it can read ──
      let inputArgs: string[]
      if (inExt === 'webp' && (await isAnimatedWebp(inPath))) {
        if (!(await ensureLibwebp())) {
          throw new Error('Converting animated WebP needs the libwebp tools, which could not be installed on this host')
        }
        await mkdir(FRAMES_ROOT, { recursive: true })
        framesDir = await mkdtemp(join(FRAMES_ROOT, 'webp-'))
        const { files, durationsMs } = await dumpWebpFrames(inPath, framesDir, signal)
        if (!files.length) throw new Error('could not extract any frames from the WebP')
        const listPath = join(framesDir, 'frames.txt')
        await writeFile(listPath, buildConcat(files, durationsMs))
        inputArgs = ['-f', 'concat', '-safe', '0', '-i', listPath]
      } else {
        // static webp, gif, or video — ffmpeg decodes these natively
        inputArgs = ['-i', inPath]
      }

      // ── Output: pick the encoder automatically per target format ──
      const bin = o === 'webp' ? await ensureWebpFfmpeg() : await ensureFfmpeg()
      const args = ['-y', ...inputArgs]
      if (o === 'gif') {
        // One-pass high-quality palette (equivalent to the common "fast, compatible" gif path).
        args.push('-vf', 'split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', '-loop', '0', '-an')
      } else if (o === 'webp') {
        args.push('-c:v', 'libwebp_anim', '-loop', '0', '-an')
        if (quality) args.push('-quality', String(quality))
      } else {
        // video container: even dimensions + yuv420p for broad player compatibility.
        args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart')
      }
      args.push(outPath)

      await run(bin, args, signal)

      const s = await stat(outPath).catch(() => null)
      if (!s || s.size === 0) throw new Error('conversion produced no output')
    } finally {
      if (framesDir) await rm(framesDir, { recursive: true, force: true }).catch(() => {})
    }
  },
}
