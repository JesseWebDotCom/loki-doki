// Channel logo generator: a branded SVG tile per channel (gradient + monogram + number),
// used in-app and as the tvg-logo / XMLTV icon for external guide clients. PNG variants
// (some IPTV clients ignore SVG) are rasterized through vips when available and cached
// under data/cache/tv/logos.

import { join } from 'node:path'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureVips, vipsAvailable, vipsBin } from '@/lib/vips'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)
const LOGO_CACHE_DIR = join(process.cwd(), 'data', 'cache', 'tv', 'logos')

export interface TvLogoSpec {
  slug: string
  name: string
  number: number
  color: string
  colorDark: string
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Monogram: up to two significant initials ("MaiPai Movies" → "DM", "Marathon" → "MA"). */
function monogram(name: string): string {
  const words = name.split(/\s+/).filter((w) => /^[a-z0-9]/i.test(w))
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || 'TV'
}

export function channelLogoSvg(spec: TvLogoSpec): string {
  const mono = esc(monogram(spec.name))
  const name = esc(spec.name.length > 18 ? `${spec.name.slice(0, 17)}…` : spec.name)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${esc(spec.color)}"/>
      <stop offset="1" stop-color="${esc(spec.colorDark)}"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="48" fill="url(#g)"/>
  <rect width="256" height="256" rx="48" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
  <text x="128" y="132" text-anchor="middle" font-family="Avenir Next, Segoe UI, Helvetica, Arial, sans-serif" font-size="104" font-weight="800" fill="#ffffff">${mono}</text>
  <text x="128" y="196" text-anchor="middle" font-family="Avenir Next, Segoe UI, Helvetica, Arial, sans-serif" font-size="24" font-weight="600" fill="rgba(255,255,255,0.85)">${name}</text>
  <g>
    <rect x="164" y="28" width="64" height="34" rx="10" fill="rgba(0,0,0,0.35)"/>
    <text x="196" y="52" text-anchor="middle" font-family="Avenir Next, Segoe UI, Helvetica, Arial, sans-serif" font-size="22" font-weight="700" fill="#ffffff">${spec.number}</text>
  </g>
</svg>`
}

/**
 * PNG logo for guide clients that will not render SVG. Cached by (slug, name, colors)
 * so admin edits re-render. Returns null when vips is unavailable or the SVG loader is
 * missing from the build; callers fall back to serving the SVG bytes.
 */
export async function channelLogoPng(spec: TvLogoSpec): Promise<Buffer | null> {
  const key = `${spec.slug}-${Buffer.from(`${spec.name}|${spec.color}|${spec.colorDark}|${spec.number}`).toString('base64url').slice(0, 16)}`
  const pngPath = join(LOGO_CACHE_DIR, `${key}.png`)
  if (existsSync(pngPath)) return readFile(pngPath)
  try {
    await mkdir(LOGO_CACHE_DIR, { recursive: true })
    const svgPath = join(LOGO_CACHE_DIR, `${key}.svg`)
    await writeFile(svgPath, channelLogoSvg(spec), 'utf8')
    if (!vipsAvailable()) await ensureVips()
    await execFileAsync(vipsBin(), ['copy', svgPath, pngPath], { timeout: 15000 })
    if (!existsSync(pngPath)) return null
    return readFile(pngPath)
  } catch (err) {
    logger.warn('[tv] logo png rasterize failed', { slug: spec.slug, err: err instanceof Error ? err.message : String(err) })
    return null
  }
}
