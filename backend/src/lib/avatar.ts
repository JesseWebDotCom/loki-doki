// Server-side DiceBear avatar rendering. Mirrors the web app's client-side
// renderer (frontend/src/components/shared/UserAvatar.tsx +
// frontend/src/components/companion/*) so the PNG a native client loads matches
// the SVG the browser draws. Ported verbatim where the browser code is pure.

// DiceBear is loaded LAZILY (dynamic import in buildDicebearSvg) rather than at
// module top-level: a native-dependency or resolution failure in @dicebear on any
// platform must never crash server startup — the avatar route degrades to the
// initials fallback instead. (Learned the hard way: a top-level import here took
// the whole server down on the production Windows box.)
import type { Style } from '@dicebear/core'

// --- styles (port of components/companion/styles.ts) -----------------------

export const CHARACTER_STYLES = ['avataaars', 'bottts', 'toon-head'] as const
export type CharacterStyle = (typeof CHARACTER_STYLES)[number]

function isCharacterStyle(value: unknown): value is CharacterStyle {
  return typeof value === 'string' && (CHARACTER_STYLES as readonly string[]).includes(value)
}
function coerceStyle(value: unknown): CharacterStyle {
  return isCharacterStyle(value) ? value : 'avataaars'
}

// --- face overrides (port of components/companion/faceForState.ts) ---------

interface FaceOverride { mouth?: string; eyes?: string; eyebrows?: string }
type StateMap = Partial<Record<CharacterStyle, FaceOverride>>

const FACE: Record<string, StateMap> = {
  sick: {
    avataaars: { mouth: 'vomit', eyes: 'cry', eyebrows: 'sadConcerned' },
    'toon-head': { mouth: 'sad', eyes: 'humble', eyebrows: 'sad' },
    bottts: { mouth: 'bite', eyes: 'sensor' },
  },
  listening: {
    avataaars: { mouth: 'twinkle', eyes: 'default', eyebrows: 'defaultNatural' },
    'toon-head': { mouth: 'smile', eyes: 'wide', eyebrows: 'raised' },
    bottts: { mouth: 'smile02', eyes: 'happy' },
  },
  angry: {
    avataaars: { mouth: 'grimace', eyes: 'squint', eyebrows: 'angryNatural' },
    'toon-head': { mouth: 'angry', eyes: 'wide', eyebrows: 'angry' },
    bottts: { mouth: 'bite', eyes: 'dizzy' },
  },
  sad: {
    avataaars: { mouth: 'sad', eyes: 'cry', eyebrows: 'sadConcerned' },
    'toon-head': { mouth: 'sad', eyes: 'humble', eyebrows: 'sad' },
    bottts: { mouth: 'square01', eyes: 'sensor' },
  },
  shocked: {
    avataaars: { mouth: 'screamOpen', eyes: 'surprised', eyebrows: 'raisedExcited' },
    'toon-head': { mouth: 'agape', eyes: 'wide', eyebrows: 'raised' },
    bottts: { mouth: 'square02', eyes: 'roundFrame02' },
  },
  thinking: {
    avataaars: { mouth: 'serious', eyes: 'eyeRoll', eyebrows: 'raisedExcitedNatural' },
    'toon-head': { mouth: 'smile', eyebrows: 'neutral' },
    bottts: { mouth: 'grill02', eyes: 'happy' },
  },
}
function faceForState(state: string, style: CharacterStyle): FaceOverride | null {
  return FACE[state]?.[style] ?? null
}

// --- default resting eye (port of components/companion/visemeMap.ts) -------

const DEFAULT_EYE: Record<CharacterStyle, string | null> = {
  avataaars: 'default',
  bottts: null,
  'toon-head': 'happy',
}
function defaultEyeFor(style: CharacterStyle): string | null {
  return DEFAULT_EYE[style]
}

// --- per-style option filtering (port of companion/dicebearSchema.ts) ------

interface DicebearStyleSchema { properties?: Record<string, unknown> }
const RAW_SCHEMAS: Record<CharacterStyle, DicebearStyleSchema> = {
  avataaars: (collection as Record<string, { schema?: DicebearStyleSchema }>)['avataaars']?.schema ?? {},
  bottts: (collection as Record<string, { schema?: DicebearStyleSchema }>)['bottts']?.schema ?? {},
  'toon-head': (collection as Record<string, { schema?: DicebearStyleSchema }>)['toonHead']?.schema ?? {},
}
const keyCache: Partial<Record<CharacterStyle, Set<string>>> = {}
function getValidKeys(style: CharacterStyle): Set<string> {
  if (!keyCache[style]) keyCache[style] = new Set(Object.keys(RAW_SCHEMAS[style].properties ?? {}))
  return keyCache[style]!
}
function filterOptionsForStyle(style: CharacterStyle, options: Record<string, unknown>): Record<string, unknown> {
  const valid = getValidKeys(style)
  if (valid.size === 0) return options
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (valid.has(key)) out[key] = value
  }
  return out
}

// --- the DiceBear user shape we read off the users table -------------------

export interface AvatarUser {
  id: string
  firstName: string
  lastName: string
  avatarUrl?: string | null
  dicebearStyle?: string | null
  dicebearSeed?: string | null
  dicebearConfig?: string | null // JSON string of DiceBear options
}

/**
 * Build the DiceBear SVG for a user, mirroring UserAvatar's DicebearSnapshot
 * exactly (default `listening` pose, per-state face overrides, resting eyes,
 * cross-style key filtering).
 */
export async function buildDicebearSvg(user: AvatarUser): Promise<string> {
  // Lazy-load DiceBear so a failure to resolve/load it can never crash startup —
  // the caller treats a thrown/rejected result as "no SVG" and uses initials.
  const { createAvatar } = await import('@dicebear/core')
  const collection = await import('@dicebear/collection')
  const STYLE_MAP = {
    avataaars: collection.avataaars,
    bottts: collection.bottts,
    'toon-head': collection.toonHead,
  } as const

  const style = coerceStyle(user.dicebearStyle)

  let cfg: Record<string, unknown> = {}
  if (typeof user.dicebearConfig === 'string') {
    try { cfg = JSON.parse(user.dicebearConfig) as Record<string, unknown> } catch { /* ignore malformed config */ }
  }

  const pose = (typeof cfg._pose === 'string' ? cfg._pose : undefined) ?? 'listening'
  const expr = faceForState(pose, style)

  const opts: Record<string, unknown> = { ...cfg }
  delete opts._pose // internal key, not a DiceBear option

  const userSetMouth = 'mouth' in opts
  const userSetEyes = 'eyes' in opts
  const userSetEyebrows = 'eyebrows' in opts

  if (expr?.mouth && !userSetMouth) {
    opts.mouth = [expr.mouth]
    opts.mouthProbability = 100
  }
  if (expr?.eyes && !userSetEyes) {
    opts.eyes = [expr.eyes]
    opts.eyesProbability = 100
  } else if (defaultEyeFor(style) && !userSetEyes) {
    opts.eyes = [defaultEyeFor(style) as string]
    opts.eyesProbability = 100
  }
  if (expr?.eyebrows && !userSetEyebrows) {
    opts.eyebrows = [expr.eyebrows]
    opts.eyebrowsProbability = 100
  }

  const filtered = filterOptionsForStyle(style, opts)
  // DiceBear's per-style Options types genuinely differ, so the STYLE_MAP union
  // can't unify with createAvatar's single generic. Cast at the library boundary.
  const chosenStyle = STYLE_MAP[style] as Style<Record<string, unknown>>
  return createAvatar(chosenStyle, { seed: user.dicebearSeed ?? 'default', ...filtered }).toString()
}

// --- initials fallback -----------------------------------------------------

// Per-user identity gradients (hex approximations of UserAvatar's Tailwind
// `from-*`/`to-*` pairs, in the same order) so the fallback square is tinted
// the same way the web app tints a user with no avatar.
const GRADIENTS: [string, string][] = [
  ['#7c3aed', '#3b82f6'], // violet-600 -> blue-500
  ['#db2777', '#f43f5e'], // pink-600 -> rose-500
  ['#059669', '#14b8a6'], // emerald-600 -> teal-500
  ['#f59e0b', '#f97316'], // amber-500 -> orange-500
  ['#0284c7', '#06b6d4'], // sky-600 -> cyan-500
  ['#c026d3', '#a855f7'], // fuchsia-600 -> purple-500
]
function gradientFor(id: string): [string, string] {
  const idx = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % GRADIENTS.length
  return GRADIENTS[idx]
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) =>
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === "'" ? '&apos;' : '&quot;')
}

/** A colored square with the user's initials, matching UserAvatar's text fallback. */
export function buildInitialsSvg(user: AvatarUser, size = 200): string {
  const initials = escapeXml(((user.firstName[0] ?? '') + (user.lastName[0] ?? '')).toUpperCase())
  const [from, to] = gradientFor(user.id)
  const fontSize = Math.round(size * 0.4)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
    `<rect width="${size}" height="${size}" fill="url(#g)"/>` +
    `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" fill="#ffffff" ` +
    `font-family="-apple-system,Helvetica,Arial,sans-serif" font-weight="700" font-size="${fontSize}">${initials}</text>` +
    `</svg>`
}

/**
 * Rasterize an SVG string to a square PNG of `size` px. Returns null if the
 * SVG rasterizer (sharp) is unavailable, so the caller can fall back to serving
 * the raw SVG instead of crashing.
 */
export async function rasterizeSvgToPng(svg: string, size: number): Promise<Buffer | null> {
  try {
    const sharpMod = (await import('sharp')).default
    return await sharpMod(Buffer.from(svg))
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
  } catch {
    return null
  }
}
