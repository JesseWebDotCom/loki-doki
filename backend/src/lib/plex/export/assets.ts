// Poster/banner/background/thumb writer for the Plex export tree — reuses already-cached
// bytes from the YouTube image cache (ytImageCache, populated by the app's own /img proxy)
// rather than re-fetching artwork from YouTube a second time.

import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import sharp from 'sharp'
import { getOrFetchImage } from '@/lib/youtube/imageCache'
import { podcastFallback } from '@/lib/pod/podcastCover.generated'

async function writeImage(url: string | null, destAbsPath: string): Promise<boolean> {
  if (!url) return false
  const img = await getOrFetchImage(url)
  if (!img) return false
  await mkdir(dirname(destAbsPath), { recursive: true })
  await writeFile(destAbsPath, img.data)
  return true
}

// Same bundled OpenMoji set the podcast-cover fallback uses (controllerAtlas.ts) — one
// level deeper in the tree (plex/export/ vs pod/), hence the extra '../'.
const OPENMOJI_DIR = resolve(import.meta.dir, '../../../../../frontend/public/openmoji')

/** Reuses the app's existing generated-cover engine (the same palette/theme/hash logic
 *  behind Podcasts' and Music's "no real art yet" fallback covers — podcastFallback() +
 *  the gradient-plus-glyph technique from pod/controllerAtlas.ts) to make a real Plex
 *  poster for a season, rather than a plain color or the channel avatar again. Deterministic
 *  per-channel via `seed` (so the same channel's Videos/Shorts posters share a look), with
 *  `label` ("Videos"/"Shorts") both feeding the theme match and rendered as the poster text.
 *  Portrait 1000x1500 (Plex's standard poster aspect), unlike controllerAtlas's small square
 *  device tiles — same technique, different canvas. */
async function generateSeasonPosterBuffer(seed: string, label: string): Promise<Buffer> {
  const { palette, emojiHex } = podcastFallback(seed, label)
  const W = 1000, H = 1500
  const emojiSvg = await readFile(`${OPENMOJI_DIR}/${emojiHex}.svg`).catch(() => null)
  const layers: sharp.OverlayOptions[] = []
  if (emojiSvg) {
    const sz = Math.round(W * 0.34)
    try {
      layers.push({
        input: await sharp(emojiSvg).resize(sz, sz, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
        top: Math.round(H * 0.16), left: Math.round((W - sz) / 2),
      })
    } catch { /* glyph unrenderable — gradient + text only */ }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="${palette.c1}"/><stop offset="1" stop-color="${palette.c2}"/></linearGradient></defs>`
    + `<rect width="100%" height="100%" fill="url(#g)"/>`
    + `<text x="50%" y="${Math.round(H * 0.82)}" text-anchor="middle" font-family="sans-serif" font-weight="700"`
    + ` font-size="${Math.round(W * 0.13)}" fill="${palette.fg}">${label.toUpperCase()}</text>`
    + `</svg>`
  return sharp(Buffer.from(svg)).composite(layers).jpeg({ quality: 88 }).toBuffer()
}

/** poster.jpg / banner.jpg / background.jpg at the show root (Plex Local Media Assets —
 *  TV shows convention). Banner doubles as background when no separate art exists, which
 *  is the common case for a YouTube channel (avatar + banner is all InnerTube exposes). */
export async function writeShowAssets(showDirAbs: string, opts: { avatarUrl: string | null; bannerUrl: string | null }): Promise<void> {
  await writeImage(opts.avatarUrl, `${showDirAbs}/poster.jpg`)
  await writeImage(opts.bannerUrl, `${showDirAbs}/banner.jpg`)
  await writeImage(opts.bannerUrl, `${showDirAbs}/background.jpg`)
}

/** Per-season art lives at the SHOW ROOT (not inside the season folder), named
 *  `season{N}-poster`/`season{N}-fanart` (Kodi/Plex convention) — `season-specials-poster`
 *  for season 0. The poster is generated (see generateSeasonPosterBuffer) rather than reusing
 *  the channel avatar again — YouTube has no per-season-specific art, and a plain repeat of
 *  the show's own poster gave every season an identical, indistinguishable thumbnail; a
 *  "Videos"/"Shorts" labeled poster is actually informative in the season picker. Background
 *  (fanart) still reuses the channel banner — that one already looks intentional as a season
 *  backdrop, unlike the poster. `seed` should be the channel id/title (same value used for
 *  the show's own poster) so a channel's seasons share one consistent color family. */
export async function writeSeasonAssets(showDirAbs: string, seasonYear: number, label: string, seed: string, opts: { bannerUrl: string | null }): Promise<void> {
  const key = seasonYear === 0 ? 'specials' : String(seasonYear)
  const poster = await generateSeasonPosterBuffer(seed, label).catch(() => null)
  if (poster) {
    await mkdir(showDirAbs, { recursive: true })
    await writeFile(`${showDirAbs}/season${key}-poster.jpg`, poster)
  }
  await writeImage(opts.bannerUrl, `${showDirAbs}/season${key}-fanart.jpg`)
}

/** "4:53" / "1:05:15" — YouTube's own thumbnail-badge duration format (no leading zero on
 *  minutes unless an hour is present). */
function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = Math.floor(totalSec % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** Bottom-right duration pill, matching YouTube's own thumbnail badge (requested directly —
 *  see [Image #1] in the conversation). Reads the real image dimensions first since YouTube
 *  thumbnails aren't a fixed size (maxres 1280x720 vs a hqdefault fallback 480x360), so the
 *  badge is positioned/sized proportionally rather than at a fixed pixel offset that would
 *  look wrong on a smaller fallback thumbnail.
 *
 *  A bottom-left channel-logo badge was tried and removed per direct feedback — kept out
 *  rather than re-added behind a flag, since there's no indication it'll come back. */
async function overlayThumbBadges(imgBuffer: Buffer, durationSec: number | null): Promise<Buffer> {
  if (!durationSec || durationSec <= 0) return imgBuffer
  const meta = await sharp(imgBuffer).metadata()
  const W = meta.width ?? 1280, H = meta.height ?? 720
  const text = formatDuration(durationSec)
  const fontSize = Math.round(H * 0.09)
  const padX = Math.round(fontSize * 0.45), padY = Math.round(fontSize * 0.22)
  // Rough monospace-digit width estimate — good enough for a badge, not typeset text.
  const boxW = Math.round(text.length * fontSize * 0.58 + padX * 2)
  const boxH = Math.round(fontSize + padY * 2)
  const marginX = Math.round(W * 0.02), marginY = Math.round(H * 0.03)
  const x = W - boxW - marginX, y = H - boxH - marginY
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    + `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="3" fill="black" fill-opacity="0.8"/>`
    + `<text x="${x + boxW / 2}" y="${y + boxH / 2}" text-anchor="middle" dominant-baseline="central"`
    + ` font-family="sans-serif" font-weight="700" font-size="${fontSize}" fill="white">${text}</text>`
    + `</svg>`
  return sharp(imgBuffer).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 90 }).toBuffer()
}

/** Center-crop to 16:9 before badging. YouTube's hqdefault.jpg is 480x360 (4:3) with the
 *  16:9 content letterboxed between baked-in black bars — a badge positioned relative to
 *  the full frame lands INSIDE the bottom bar, and Plex's 16:9 episode tiles then crop the
 *  bar (and the badge) away, leaving a half-visible box. Confirmed live on all three Plex
 *  clients. Cropping first puts the badge inside the content that actually renders. */
async function cropTo16x9(buf: Buffer): Promise<Buffer> {
  const meta = await sharp(buf).metadata()
  const W = meta.width ?? 0, H = meta.height ?? 0
  const targetH = Math.round(W * 9 / 16)
  if (!W || !H || H <= targetH + 2) return buf   // unknown size, already 16:9, or wider
  const top = Math.round((H - targetH) / 2)
  return sharp(buf).extract({ left: 0, top, width: W, height: targetH }).jpeg({ quality: 92 }).toBuffer()
}

export async function writeEpisodeThumb(thumbAbsPath: string, url: string | null, durationSec: number | null): Promise<boolean> {
  if (!url) return false
  // A thumbnail without its duration badge must never reach the Plex tree — the badge is
  // the whole point of writing our own thumb (Plex would generate a frame grab otherwise,
  // which at least LOOKS intentionally different from a half-done YouTube-style thumb).
  // Callers resolve duration (DB, else ffprobe of the placed file) before calling.
  if (!durationSec || durationSec <= 0) return false
  const img = await getOrFetchImage(url)
  if (!img) return false
  let bytes: Buffer
  try { bytes = await overlayThumbBadges(await cropTo16x9(img.data), durationSec) } catch { return false }
  await mkdir(dirname(thumbAbsPath), { recursive: true })
  await writeFile(thumbAbsPath, bytes)
  return true
}
