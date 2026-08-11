// Bucketed downscale variants for the image proxies (?w=). The proxies cache and serve
// ORIGINAL upstream bytes; a 300KB poster rendered into a 160px-wide card ships 300KB.
// This adds an opt-in width parameter: the route asks for a variant, we render it once
// with the vendored libvips (`vips thumbnail`, webp Q80) next to the original in the
// same cache dir, and every later request is a disk read. Widths snap to a small set of
// buckets so N slightly-different card sizes share one variant instead of exploding the
// cache; the sweep needs no changes (variants are ordinary files under the same ceiling).
//
// Strictly best-effort: no vips, an animated/vector source, or a resize failure all fall
// back to serving the original bytes - exactly what shipped before this existed.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { ensureVips, vipsAvailable, vipsBin } from '@/lib/vips'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

export const WIDTH_BUCKETS = [240, 480, 960, 1280] as const

/** Snap a requested width to the smallest bucket that covers it (crisp on 2x screens is
 *  the caller's job - pass the device-pixel width). Out-of-range → largest bucket. */
export function bucketFor(raw: string | undefined): number | null {
  const w = Number(raw)
  if (!Number.isFinite(w) || w <= 0) return null
  for (const b of WIDTH_BUCKETS) if (w <= b) return b
  return WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1]!
}

// Only still rasters resize safely: animated GIF/WebP would flatten to frame one, and
// SVG is already resolution-independent (and tiny).
const RESIZABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif', 'image/jpg'])

const inFlight = new Map<string, Promise<Buffer | null>>()

/** Path a bucket's variant lands at, beside its original. */
export const variantPath = (srcPath: string, bucket: number): string => `${srcPath}.w${bucket}.webp`

/**
 * Fast path for an ALREADY-rendered variant: returns its bytes without reading the
 * original at all. This is the common case on a warm cache (a 40-thumbnail grid is 40
 * of these), and reading a multi-MB original just to hand back a 15KB downscale was
 * doubling the disk I/O and peak memory of every card render.
 * Returns null when there is no usable variant - the caller must then go through
 * getResizedVariant (which needs the original anyway, to render one).
 */
export async function readCachedVariant(srcPath: string, bucket: number): Promise<{ data: Buffer; contentType: string } | null> {
  const outPath = variantPath(srcPath, bucket)
  if (!existsSync(outPath)) return null
  try {
    // Proxy-cache sources are immutable per hash, but direct-file sources (uploaded
    // podcast covers) can be replaced in place: a variant older than its source is stale.
    // A missing source also throws here, so an orphaned variant is never served.
    const [src, out] = await Promise.all([stat(srcPath), stat(outPath)])
    if (out.mtimeMs >= src.mtimeMs) return { data: await readFile(outPath), contentType: 'image/webp' }
    await unlink(outPath).catch(() => {})
  } catch { /* fall through - caller re-renders */ }
  return null
}

/**
 * Get (rendering on first demand) the webp downscale of an already-cached original.
 * `srcPath` is the original's cache file; the variant lands at `${srcPath}.w${bucket}.webp`.
 * Returns null whenever the original should be served instead.
 */
export async function getResizedVariant(srcPath: string, contentType: string, bucket: number): Promise<{ data: Buffer; contentType: string } | null> {
  if (!RESIZABLE_TYPES.has(contentType)) return null
  const cached = await readCachedVariant(srcPath, bucket)
  if (cached) return cached
  if (contentType === 'image/webp') {
    // Animated webp can't be sniffed from the content-type alone; VP8X animation flag
    // check is cheap enough to do on the first bytes.
    try {
      const head = await readFile(srcPath).then((b) => b.subarray(0, 32))
      if (head.includes(Buffer.from('ANIM'))) return null
    } catch { return null }
  }
  const outPath = variantPath(srcPath, bucket)

  const key = outPath
  const existing = inFlight.get(key)
  const p = existing ?? (async (): Promise<Buffer | null> => {
    try {
      await ensureVips()
      if (!vipsAvailable()) return null
      // `vips thumbnail` picks height from aspect; [Q=80] on the webp target.
      await execFileAsync(vipsBin(), ['thumbnail', srcPath, `${outPath}[Q=80]`, String(bucket)], { timeout: 15_000, windowsHide: true })
      return await readFile(outPath)
    } catch (err) {
      logger.warn(`[img] resize to w${bucket} failed for ${srcPath}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  })()
  if (!existing) { inFlight.set(key, p); void p.finally(() => inFlight.delete(key)) }
  const data = await p
  return data ? { data, contentType: 'image/webp' } : null
}
