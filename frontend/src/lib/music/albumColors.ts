// Album-art colour extraction for the "UltraBlur" backdrop and the visualizers.
// Downsamples the cover to a tiny canvas, buckets pixels into a coarse histogram, and
// picks a small palette biased toward vibrant colours (covers are mostly dark/neutral,
// so a naive "most common" pick yields mud). All art is served same-origin through our
// image proxies, so canvas pixel reads are never CORS-tainted.

import { useEffect, useState } from 'react'

export interface Palette {
  /** Most prominent colour overall. */
  dominant: string
  /** Most saturated prominent colour - the accent for bars/glow. */
  vibrant: string
  /** A darker companion, for gradient depth. */
  dark: string
  /** A light companion, for text-safe highlights. */
  light: string
  /** True when the cover is essentially monochrome (palette collapses to tints). */
  muted: boolean
}

export const DEFAULT_PALETTE: Palette = {
  dominant: '#3b3660', vibrant: '#b06bff', dark: '#171622', light: '#e6e2ff', muted: true,
}

const cache = new Map<string, Palette>()

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}
const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')

function extract(img: HTMLImageElement): Palette {
  const N = 40
  const cv = document.createElement('canvas')
  cv.width = N; cv.height = N
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  if (!ctx) return DEFAULT_PALETTE
  ctx.drawImage(img, 0, 0, N, N)
  let data: Uint8ClampedArray
  try { data = ctx.getImageData(0, 0, N, N).data } catch { return DEFAULT_PALETTE }

  // Coarse 4-bit-per-channel histogram; track a saturation-weighted score per bucket so
  // vibrant regions outrank a large flat dark background.
  const buckets = new Map<number, { r: number; g: number; b: number; n: number; score: number }>()
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!
    if (a < 128) continue
    const [, s, l] = rgbToHsl(r, g, b)
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const cur = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0, score: 0 }
    cur.r += r; cur.g += g; cur.b += b; cur.n += 1
    // Prefer mid-luminance, saturated pixels; discount near-black/near-white and grey.
    cur.score += (0.25 + s) * (1 - Math.abs(l - 0.5) * 1.2)
    buckets.set(key, cur)
  }
  const list = [...buckets.values()].filter(b => b.n > 1)
  if (!list.length) return DEFAULT_PALETTE

  const avg = (b: { r: number; g: number; b: number; n: number }) => [b.r / b.n, b.g / b.n, b.b / b.n] as const
  const byCount = [...list].sort((a, b) => b.n - a.n)
  const byScore = [...list].sort((a, b) => b.score - a.score)
  const byDark = [...list].sort((a, b) => {
    const [ar, ag, ab] = avg(a), [br, bg, bb] = avg(b)
    return (ar + ag + ab) - (br + bg + bb)
  })
  const byLight = [...byDark].reverse()

  const [dr, dg, db] = avg(byCount[0]!)
  const [vr, vg, vb] = avg(byScore[0]!)
  const [kr, kg, kb] = avg(byDark[0]!)
  const [lr, lg, lb] = avg(byLight[0]!)
  const [, vibrSat] = rgbToHsl(vr, vg, vb)
  return {
    dominant: hex(dr, dg, db),
    vibrant: hex(vr, vg, vb),
    dark: hex(kr * 0.7, kg * 0.7, kb * 0.7),
    light: hex(lr, lg, lb),
    muted: vibrSat < 0.2,
  }
}

/** Extract (and cache) the palette for an album-art URL. Returns the default palette until
 *  the image loads, then the real one. */
export function useAlbumPalette(url: string | null | undefined): Palette {
  const [palette, setPalette] = useState<Palette>(() => (url && cache.get(url)) || DEFAULT_PALETTE)
  useEffect(() => {
    if (!url) { setPalette(DEFAULT_PALETTE); return }
    const cached = cache.get(url)
    if (cached) { setPalette(cached); return }
    let alive = true
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const p = extract(img)
      cache.set(url, p)
      if (alive) setPalette(p)
    }
    img.onerror = () => { if (alive) setPalette(DEFAULT_PALETTE) }
    img.src = url
    return () => { alive = false }
  }, [url])
  return palette
}
