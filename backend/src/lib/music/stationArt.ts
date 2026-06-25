// Station artwork. Generated INSTANTLY and deterministically as SVG (no LLM, no network) so every
// station — built-in or user-made — always has cover art the moment it exists, and at ANY size.
// We render two compositions from the same theme: a square ICON (cards) and a wide BANNER (the
// station hero). Each is a rich gradient + a themed glyph + the station name as a wordmark, in the
// style of Apple Music's genre/mood tiles. SVG is resolution-independent, so both stay crisp.

import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { getDataRoot } from '@/lib/storage/paths'
import { resolveProjectAccent } from '@/lib/music/accents'
import { logger } from '@/lib/logger'

export interface StationArt { iconPath: string | null; bannerPath: string | null }

const REL_BASE = '_shared/music-stations'

// Deterministic PRNG (mulberry32) so a station's art is identical every render.
function rng(seedStr: string): () => number {
  let h = 1779033703 ^ seedStr.length
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19) }
  let a = h >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function lighten(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.min(255, ((n >> 16) & 255) + amt), g = Math.min(255, ((n >> 8) & 255) + amt), b = Math.min(255, (n & 255) + amt)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Pick a themed glyph from keywords in the station name. Order matters (specific first).
function glyphFor(name: string): string {
  const n = name.toLowerCase()
  const map: [RegExp, string][] = [
    [/8-?bit|chiptune|retro gaming|video game|gaming|vaporwave/, '🎮'],
    [/rage|metal|mayhem|headbang/, '🤘'],
    [/jazz|swing|big band|bebop/, '🎷'],
    [/hip-?hop|rap|boom|new jack/, '🎧'],
    [/country|outlaw|honky|bluegrass/, '🤠'],
    [/classical|orchestr|composer|score|symphony/, '🎻'],
    [/disco|euphoric|party|club|festival/, '🪩'],
    [/reggae|island|tropical|ska|afro/, '🌴'],
    [/movie|cinema|film|tarantino|bond|western|sci-?fi|superhero|montage|rom-?com|soundtrack/, '🎬'],
    [/horror|spooky|halloween|scary/, '🎃'],
    [/tv|nick|cartoon|disney|saturday|broadway|anime|theme/, '📺'],
    [/love|date|romance|sensual|heartbreak|feels|wedding/, '💗'],
    [/sleep|calm|dream|rain/, '😴'],
    [/workout|pump|training|gym|motivat|get it done|stadium|confidence|boss/, '💪'],
    [/holiday|christmas|festive/, '🎄'],
    [/summer|beach|surf|sun|good times/, '🏖️'],
    [/coffee|morning|cafe|café/, '☕'],
    [/focus|study|lo-?fi|chill|mellow|meditat|yoga|zen|smooth/, '🧘'],
    [/electronic|synth|house|techno|edm|pulse|nu-?metal/, '🎛️'],
    [/k-?pop|j-pop|bollywood|latin|reggaeton|global/, '🌍'],
    [/folk|acoustic|singer|campfire|coffeehouse/, '🪕'],
    [/blues|soul|gospel|funk|motown|r&b|rnb/, '🎤'],
    [/rock|grunge|punk|britpop|glam|garage|psychedelic|prog|surf|rockabilly|southern|hair/, '🎸'],
    [/happy|feel-?good|vibes|sunshine|pride/, '☀️'],
    [/decade|80s|90s|70s|60s|50s|2000s|2010s|2020s|nostalgia|throwback|oldies|era|invasion|jazz age|y2k|viral|hits|today|now/, '📼'],
  ]
  for (const [re, g] of map) if (re.test(n)) return g
  return '🎵'
}

// Greedy word-wrap the name into up to 3 lines for the wordmark.
function wrapName(name: string, maxLen: number): string[] {
  const words = name.split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > maxLen) { lines.push(cur); cur = w }
    else cur = cur ? `${cur} ${w}` : w
  }
  if (cur) lines.push(cur)
  return lines.slice(0, 3)
}

// Compose one tile at the given size. Wide tiles (W>H) put the glyph on the right; square tiles
// put it upper-center. The wordmark sits bottom-left over a legibility scrim.
function buildSvg(name: string, primary: string, accent: string, W: number, H: number): string {
  const r = rng(name || 'station')
  const wide = W > H * 1.4
  const glyph = glyphFor(name)

  // Background texture: a few large soft accent shapes.
  const palette = [accent, lighten(accent, 30), lighten(primary, 25), '#ffffff']
  const shapes: string[] = []
  const count = 3 + Math.floor(r() * 2)
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(r() * W), cy = Math.floor(r() * H), size = Math.floor((0.3 + r() * 0.5) * Math.min(W, H))
    shapes.push(`<circle cx="${cx}" cy="${cy}" r="${size}" fill="${palette[Math.floor(r() * palette.length)]}" opacity="${(0.1 + r() * 0.16).toFixed(2)}"/>`)
  }

  const ang = 90 + Math.floor(r() * 80)
  const glyphSize = wide ? H * 0.62 : W * 0.5
  const glyphX = wide ? W * 0.8 : W * 0.5
  const glyphY = wide ? H * 0.46 : H * 0.4

  const lines = wrapName(name, wide ? 22 : 13)
  const fontSize = Math.round((wide ? H * 0.16 : W * 0.11) * (lines.length > 2 ? 0.82 : 1))
  const lh = fontSize * 1.05
  const baseY = H - (wide ? H * 0.12 : W * 0.1)
  const x = wide ? W * 0.05 : W * 0.07
  const tspans = lines.map((ln, i) => {
    const y = baseY - (lines.length - 1 - i) * lh
    return `<text x="${x}" y="${y}" font-family="-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" font-weight="800" font-size="${fontSize}" fill="#ffffff" letter-spacing="-0.5">${esc(ln)}</text>`
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<defs>` +
    `<linearGradient id="g" gradientTransform="rotate(${ang} 0.5 0.5)"><stop offset="0" stop-color="${lighten(primary, 18)}"/><stop offset="1" stop-color="${primary}"/></linearGradient>` +
    `<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0.4" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.5"/></linearGradient>` +
    `<filter id="b"><feGaussianBlur stdDeviation="${Math.round(Math.min(W, H) * 0.04)}"/></filter>` +
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="url(#g)"/>` +
    `<g filter="url(#b)">${shapes.join('')}</g>` +
    `<text x="${glyphX}" y="${glyphY}" font-size="${glyphSize}" text-anchor="middle" dominant-baseline="central" opacity="0.92">${glyph}</text>` +
    `<rect width="${W}" height="${H}" fill="url(#s)"/>` +
    tspans +
    `</svg>`
}

/** Generate + persist station icon (square) and banner (wide) SVGs instantly. */
export async function generateStationArt(
  id: string,
  name: string,
  _description: string | null,
  accentSlug?: string | null,
): Promise<StationArt> {
  const { primary, accent } = resolveProjectAccent(accentSlug)
  try {
    const icon = buildSvg(name, primary, accent, 600, 600)
    const banner = buildSvg(name, primary, accent, 1600, 600)
    const root = await getDataRoot()
    const dir = join(root, REL_BASE, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'icon.svg'), icon, 'utf8')
    await writeFile(join(dir, 'banner.svg'), banner, 'utf8')
    return { iconPath: `${REL_BASE}/${id}/icon.svg`, bannerPath: `${REL_BASE}/${id}/banner.svg` }
  } catch (err) {
    logger.debug(`[stationArt] generate failed for ${id}: ${String(err)}`)
    return { iconPath: null, bannerPath: null }
  }
}
