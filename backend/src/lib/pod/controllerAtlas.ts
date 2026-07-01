// Thumbnail ATLAS for the native LVGL stream-deck controller.
//
// The device can't fetch 10 separate button thumbnails reliably (the C6/SDIO bridge hates
// many concurrent inbound TCP streams), so the server composites every button's artwork
// into ONE image laid out as the device's grid. The device fetches it once via
// online_image and shows each cell the corresponding TILE (LVGL image offset + clip).
//
// Layout MUST match the device: COLS×ROWS tiles of TILE_W×TILE_H, row-major, matching the
// default 5×3 grid's top two rows (the bottom row is the mic/sound/player band).

import sharp from 'sharp'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { musicStations, podcastShows } from '@/db/schema'
import { resolveUserPath } from '@/lib/storage/paths'
import { resolveControllerDescriptor } from '@/lib/pod/controllerStudio'
import { STATION_ICON_SVG } from '@/lib/pod/stationIcons.generated'
import { stationGlyphKey } from '@/lib/pod/stationGlyph.generated'
import { podcastFallback } from '@/lib/pod/podcastCover.generated'
import { logger } from '@/lib/logger'

// Bundled OpenMoji glyphs used by the podcast-cover fallback (mirrors ShowCover).
const OPENMOJI_DIR = path.resolve(import.meta.dir, '../../../../frontend/public/openmoji')

/** The app's ShowCover fallback: a 135° palette gradient + the show's OpenMoji glyph,
 *  keyed deterministically off the show (matches what the app draws when a show has no
 *  uploaded cover PNG). */
async function podcastCoverTile(seedId: string, title: string): Promise<Buffer> {
  const { palette, emojiHex } = podcastFallback(seedId || title, title)
  const W = ATLAS.TILE_W, H = ATLAS.TILE_H
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette.c1}"/><stop offset="1" stop-color="${palette.c2}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`)
  const layers: sharp.OverlayOptions[] = []
  const emoji = await readFile(path.join(OPENMOJI_DIR, `${emojiHex}.svg`)).catch(() => null)
  if (emoji) {
    try {
      const sz = Math.round(H * 0.56)
      layers.push({ input: await sharp(emoji).resize(sz, sz, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(), gravity: 'center' })
    } catch { /* glyph unrenderable → gradient only */ }
  }
  return sharp(bg).composite(layers).png().toBuffer()
}

// The app's station gradients, by accent slug (mirrors frontend stationColors.ts).
const STATION_GRADIENT: Record<string, [string, string, string]> = {
  violet: ['#3b0764', '#7c3aed', '#a78bfa'], blue: ['#172554', '#2563eb', '#7dd3fc'],
  cyan: ['#083344', '#0891b2', '#67e8f9'], emerald: ['#052e16', '#059669', '#6ee7b7'],
  amber: ['#451a03', '#d97706', '#fde68a'], rose: ['#4c0519', '#e11d48', '#fda4af'],
  fuchsia: ['#4a044e', '#c026d3', '#f0abfc'], slate: ['#020617', '#334155', '#94a3b8'],
}

/** The current StationArt look: a 3-stop accent gradient + soft highlight + a large, faint
 *  watermark glyph (chosen by name/category) bleeding off the bottom-right — rendered as one
 *  SVG. This REPLACES the deprecated iconPath SVG placeholders. */
async function gradientGlyphTile(colors: [string, string, string], glyphKey: string): Promise<Buffer> {
  const [c0, c1, c2] = colors
  const glyph = STATION_ICON_SVG[glyphKey] ?? ''
  const W = ATLAS.TILE_W, H = ATLAS.TILE_H
  const sz = Math.round(H * 1.3)
  const ix = Math.round(W + W * 0.08 - sz), iy = Math.round(H + H * 0.14 - sz)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    + `<defs><linearGradient id="lg" x1="0" y1="0" x2="0.7" y2="1">`
    + `<stop offset="0" stop-color="${c0}"/><stop offset="0.5" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`
    + `<radialGradient id="hl" cx="0.28" cy="0.22" r="0.6"><stop offset="0" stop-color="#fff" stop-opacity="0.18"/><stop offset="0.52" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>`
    + `<rect width="100%" height="100%" fill="url(#lg)"/><rect width="100%" height="100%" fill="url(#hl)"/>`
    + `<svg x="${ix}" y="${iy}" width="${sz}" height="${sz}" viewBox="0 0 24 24"><g fill="#ffffff" opacity="0.14">${glyph}</g></svg>`
    + `</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** A square podcast cover for a show: its uploaded art if present, else the app's ShowCover
 *  fallback (palette gradient + OpenMoji glyph). Used by the device's /cover route so a
 *  now-playing podcast shows real art on the player bar. */
export async function renderPodcastCoverForShow(showId: string): Promise<Buffer | null> {
  const [sh] = await db.select({ cover: podcastShows.coverRelPath, name: podcastShows.name })
    .from(podcastShows).where(eq(podcastShows.id, showId))
  if (!sh) return null
  if (sh.cover) {
    const raw = await readFile(await resolveUserPath(sh.cover)).catch(() => null)
    if (raw) { try { return await sharp(raw).resize(240, 240, { fit: 'cover' }).png().toBuffer() } catch { /* fall through */ } }
  }
  return podcastCoverTile(showId, sh.name ?? '')
}

/** Station tile: the app's accent-gradient + name/category watermark look. */
function stationArtTile(accent: string | null, name: string, category: string | null): Promise<Buffer> {
  return gradientGlyphTile(STATION_GRADIENT[accent ?? 'violet'] ?? STATION_GRADIENT.violet!, stationGlyphKey(name, category))
}

// Station icons + podcast covers are served by AUTH-GATED routes, so a cookieless
// server-side fetch 401s. Resolve them to the on-disk file and read it directly.
export async function resolveLocalArt(url: string): Promise<Buffer | null> {
  let m = url.match(/\/api\/music\/stations\/([^/?]+)\/art\/icon/)
  if (m) {
    const [row] = await db.select({ p: musicStations.iconPath }).from(musicStations).where(eq(musicStations.id, m[1]))
    if (!row?.p || row.p.endsWith('.svg')) return null
    return readFile(await resolveUserPath(row.p)).catch(() => null)
  }
  m = url.match(/\/api\/podcasts\/shows\/([^/?]+)\/cover/)
  if (m) {
    const [row] = await db.select({ p: podcastShows.coverRelPath }).from(podcastShows).where(eq(podcastShows.id, m[1]))
    if (!row?.p) return null
    return readFile(await resolveUserPath(row.p)).catch(() => null)
  }
  return null
}

// Keep in lock-step with the firmware (rebuild_stream_deck_ui_): default 5×3 grid →
// cell_w = (1280 - 10*6)/5 = 244, cell_h = (720 - 10*4)/3 = 226; only rows 0–1 are drawn.
// TILE_H is the POSTER area only — the device leaves a strip below each cell for the label
// (so the caption sits below the artwork, not on top of it). cell_h(226) - label strip(46).
export const ATLAS = { TILE_W: 244, TILE_H: 180, COLS: 5, ROWS: 2 } as const

/** Resolve a button image URL to bytes: unwrap our auth-gated image proxies
 *  (/api/youtube/img?u=…, /api/img?url=…) to the real target, absolutize relatives. */
async function fetchButtonImage(url: string, origin: string): Promise<Buffer | null> {
  let u = url.trim()
  if (!u) return null
  const local = await resolveLocalArt(u)   // auth-gated station/podcast art → read the file
  if (local) return local
  try {
    const inner = new URL(u, 'http://x').searchParams.get('u') || new URL(u, 'http://x').searchParams.get('url')
    if (inner && /^https?:\/\//i.test(inner)) u = inner
  } catch { /* not a parseable url */ }
  if (u.startsWith('/')) u = origin + u
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return null
    return Buffer.from(await r.arrayBuffer())
  } catch { return null }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = (hex || '').replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  if (h.length < 6 || Number.isNaN(n)) return { r: 26, g: 26, b: 42 }
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

function normAccent(a: string | null | undefined, fallback: string): string {
  if (!a) return fallback
  return a.startsWith('#') ? a : `#${a.replace(/^#/, '')}`
}

/** A thumbnail resized to exactly fill a tile (crop to cover). */
async function coverFit(raw: Buffer): Promise<Buffer> {
  return sharp(raw).resize(ATLAS.TILE_W, ATLAS.TILE_H, { fit: 'cover' }).png().toBuffer()
}

/** The app's "StationArt" look: a vertical accent gradient + an optional faint, centred
 *  watermark icon. Used for built-in stations (SVG icon, no photo) and art-less fallbacks. */
async function gradientTile(accent: string, iconSvg: Buffer | null): Promise<Buffer> {
  const { r, g, b } = hexToRgb(accent)
  const cl = (v: number, f: number) => Math.max(0, Math.min(255, Math.round(v * f)))
  const top = `rgb(${cl(r, 1.45)},${cl(g, 1.45)},${cl(b, 1.45)})`
  const bot = `rgb(${cl(r, 0.42)},${cl(g, 0.42)},${cl(b, 0.42)})`
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ATLAS.TILE_W}" height="${ATLAS.TILE_H}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bot}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`)
  const layers: sharp.OverlayOptions[] = []
  if (iconSvg) {
    try {
      const sz = Math.round(ATLAS.TILE_H * 0.6)
      // Render the icon, then knock its alpha down to ~32% (dest-in with a uniform alpha)
      // so it reads as a faint watermark rather than a hard graphic.
      const icon = await sharp(iconSvg).resize(sz, sz, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha()
        .composite([{ input: Buffer.from([255, 255, 255, 82]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
        .png().toBuffer()
      layers.push({ input: icon, gravity: 'center' })
    } catch { /* icon unrenderable → gradient only */ }
  }
  return sharp(bg).composite(layers).png().toBuffer()
}

/** Render one button's tile: stations get the gradient/watermark look, everything else with
 *  art is cover-fit, and art-less buttons fall back to an accent gradient. */
async function renderTile(b: { action?: Record<string, unknown>; image?: string; bgColor?: string }, origin: string): Promise<Buffer> {
  if (b.action?.type === 'play_station' && typeof b.action.stationId === 'string') {
    const [st] = await db.select({ iconPath: musicStations.iconPath, accent: musicStations.accent, category: musicStations.category, name: musicStations.name })
      .from(musicStations).where(eq(musicStations.id, b.action.stationId))
    // Real photo art (movie/show/YT poster) fills the tile; SVG placeholders are DEPRECATED
    // and never used — those stations get the live StationArt gradient + watermark look.
    if (st?.iconPath && !st.iconPath.endsWith('.svg')) {
      const raw = await readFile(await resolveUserPath(st.iconPath)).catch(() => null)
      if (raw) { try { return await coverFit(raw) } catch { /* fall through */ } }
    }
    return stationArtTile(st?.accent ?? null, st?.name ?? '', st?.category ?? null)
  }
  if (b.action?.type === 'app_action' && b.action.action === 'play_podcast') {
    const payload = b.action.payload as Record<string, unknown> | undefined
    const showId = typeof payload?.showId === 'string' ? payload.showId : ''
    if (showId) {
      const [sh] = await db.select({ cover: podcastShows.coverRelPath }).from(podcastShows).where(eq(podcastShows.id, showId))
      if (sh?.cover) {
        const raw = await readFile(await resolveUserPath(sh.cover)).catch(() => null)
        if (raw) { try { return await coverFit(raw) } catch { /* fall through */ } }
      }
    }
    // No uploaded cover → the app's generated ShowCover art (palette gradient + glyph).
    return podcastCoverTile(showId, typeof payload?.showName === 'string' ? payload.showName : '')
  }
  if (b.image) {
    const raw = await fetchButtonImage(b.image, origin)
    if (raw) { try { return await coverFit(raw) } catch { /* undecodable */ } }
  }
  return gradientTile(b.bgColor || '#1a1a2a', null)
}

// Small per-device cache — the device may re-fetch on reconnect; recompositing every time
// would hammer the image proxies. Short TTL so station/video changes still show up.
const cache = new Map<string, { at: number; buf: Buffer }>()
const TTL_MS = 60_000

/** Build (or serve cached) the controller thumbnail atlas JPEG for a device. */
export async function buildControllerAtlas(deviceId: string, userId: string, origin: string): Promise<Buffer> {
  const hit = cache.get(deviceId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.buf

  const { TILE_W, TILE_H, COLS, ROWS } = ATLAS
  const { pages } = await resolveControllerDescriptor(deviceId, userId)
  const buttons = pages[0]?.buttons ?? []

  const tiles = await Promise.all(buttons.map(async (b) => {
    if (b.row < 0 || b.row >= ROWS || b.col < 0 || b.col >= COLS) return null
    const tile = await renderTile(b, origin).catch(() => null)
    if (!tile) return null
    return { input: tile, left: b.col * TILE_W, top: b.row * TILE_H } as sharp.OverlayOptions
  }))

  const buf = await sharp({ create: { width: COLS * TILE_W, height: ROWS * TILE_H, channels: 3, background: { r: 7, g: 11, b: 20 } } })
    .composite(tiles.filter((t): t is sharp.OverlayOptions => !!t))
    // BASELINE JPEG only — the ESP32 online_image decoder can't read progressive JPEGs
    // (mozjpeg/progressive → "Error decoding image"). Keep it SMALL: the C6/SDIO bridge
    // stalls on large inbound downloads, so quality is tuned for reliable delivery.
    .jpeg({ quality: 48, progressive: false })
    .toBuffer()

  cache.set(deviceId, { at: Date.now(), buf })
  logger.info(`[pod] controller atlas built for device ${deviceId}: ${buf.length}B`)
  return buf
}
