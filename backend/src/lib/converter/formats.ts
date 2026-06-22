// Format catalogue — the source of truth for which extensions belong to which media
// family, and the per-engine capability lists. Trimmed to a sane launch set; extend the
// arrays (or add a new engine) to grow coverage.

import type { MediaFamily } from './types'

// Raster image formats every engine handles. 'svg' is input-only (vector → raster).
export const IMAGE = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif', 'gif', 'svg']

// vips extends raster I/O with modern codecs (depends on the libvips build, but these are
// in the standard "web" builds and Homebrew's formula).
export const VIPS_IN = [...IMAGE, 'avif', 'heic', 'heif']
export const VIPS_OUT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif', 'gif', 'avif', 'heic', 'heif']

export const AUDIO = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'opus', 'm4a', 'aiff', 'wma']
export const VIDEO = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'wmv', 'flv']

// Single ext → family lookup. 'gif' is treated as an image (animated-gif video is out of
// scope for the launch set), so it lives only in IMAGE above.
const FAMILY = new Map<string, MediaFamily>()
for (const f of new Set([...IMAGE, ...VIPS_IN, ...VIPS_OUT])) FAMILY.set(f, 'image')
for (const f of AUDIO) FAMILY.set(f, 'audio')
for (const f of VIDEO) FAMILY.set(f, 'video')

export function familyOf(ext: string): MediaFamily | null {
  return FAMILY.get(ext.toLowerCase()) ?? null
}

/** Lossy formats where a quality knob is meaningful. */
export const LOSSY = new Set(['jpg', 'jpeg', 'webp', 'avif', 'heic', 'heif', 'mp3', 'aac', 'ogg', 'opus'])
