// Turns a character's DiceBear avatar config into a short natural-language
// description, injected into the system prompt so the character KNOWS what it
// looks like and answers questions about its appearance consistently (rather than
// deflecting). Reads only explicitly-set fields — the renderer suppresses random
// accessories/facial hair, so config and avatar stay in sync.

const HAIR_COLOR: Record<string, string> = {
  '2c1b18': 'black', '4a312c': 'dark brown', '724130': 'brown', a55728: 'auburn',
  b58143: 'light brown', d6b370: 'blond', '1a1a1a': 'black', e8e1e1: 'silver-gray', ecdcbf: 'platinum-blond',
}
const SKIN: Record<string, string> = {
  ffdbb4: 'fair', edb98a: 'light', d08b5b: 'tan', ae5d29: 'brown', '614335': 'deep brown',
}
const CLOTHES_COLOR: Record<string, string> = {
  '3c4e5e': 'slate', '262e33': 'charcoal', '65c9ff': 'sky-blue', '5199e4': 'blue', '25557c': 'navy',
  a7ffc4: 'mint-green', ff488e: 'pink', ff5c5c: 'red', ffffff: 'white',
}
const BASE_COLOR: Record<string, string> = {
  d9d9d9: 'light-gray', acacac: 'gray', '6b7280': 'slate', '3b82f6': 'blue', '60a5fa': 'light-blue',
  '22c55e': 'green', ef4444: 'red', f59e0b: 'amber', ec4899: 'pink', '8b5cf6': 'purple', '1e293b': 'dark',
}
const TOP: Record<string, string> = {
  shortFlat: 'short hair', shortRound: 'short hair', shortCurly: 'short curly hair', shortWaved: 'short wavy hair',
  theCaesar: 'short cropped hair', bob: 'a bob cut', curly: 'curly hair', dreads01: 'dreadlocks', frizzle: 'frizzy hair',
  shaggy: 'shaggy hair', sides: 'shaved sides', bigHair: 'big voluminous hair', hat: 'a hat', turban: 'a turban', winterHat1: 'a winter hat',
}
const CLOTHING: Record<string, string> = {
  hoodie: 'a hoodie', blazerAndShirt: 'a blazer and shirt', blazerAndSweater: 'a blazer and sweater',
  collarAndSweater: 'a collared sweater', graphicShirt: 'a graphic tee', overall: 'overalls',
  shirtCrewNeck: 'a crew-neck shirt', shirtScoopNeck: 'a scoop-neck top', shirtVNeck: 'a v-neck shirt',
}
const ACCESSORY: Record<string, string> = {
  prescription01: 'glasses', prescription02: 'glasses', round: 'round glasses', kurt: 'glasses',
  sunglasses: 'sunglasses', wayfarers: 'sunglasses', eyepatch: 'an eye patch',
}
const FACIAL_HAIR: Record<string, string> = {
  beardLight: 'a light beard', beardMedium: 'a beard', beardMajestic: 'a full beard',
  moustacheFancy: 'a moustache', moustacheMagnum: 'a moustache',
}
const TOON_HAIR: Record<string, string> = { sideComed: 'side-combed hair', undercut: 'an undercut', spiky: 'spiky hair', bun: 'hair in a bun' }
const TOON_BEARD: Record<string, string> = { moustacheTwirl: 'a curled moustache', fullBeard: 'a full beard', chin: 'a chin beard', chinMoustache: 'a goatee', longBeard: 'a long beard' }
const TOON_CLOTHES: Record<string, string> = { turtleNeck: 'a turtleneck', openJacket: 'an open jacket', dress: 'a dress', shirt: 'a shirt', tShirt: 'a t-shirt' }
const BOTTTS_TOP: Record<string, string> = {
  antenna: 'an antenna', antennaCrooked: 'a crooked antenna', bulb01: 'a bulb antenna', glowingBulb01: 'a glowing bulb',
  glowingBulb02: 'a glowing bulb', horns: 'little horns', lights: 'blinking lights', pyramid: 'a pyramid top', radar: 'a radar dish',
}

function first(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined
  return typeof v === 'string' ? v : undefined
}
function lookup(map: Record<string, string>, v: unknown): string | undefined {
  const k = first(v)
  return k ? map[k] : undefined
}
function join(parts: (string | undefined)[]): string {
  const p = parts.filter(Boolean) as string[]
  if (p.length <= 1) return p.join('')
  return `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}`
}
const nice = (s: string | undefined): string => (s ? s.replace(/-/g, ' ') : '')

const PREAMBLE =
  'You are fully aware of your own appearance and describe it naturally, consistently, and without hesitation whenever asked. ' +
  'Your appearance is simply how your avatar looks — it is never private, medical, or secret information.'

/** Returns an appearance block for the system prompt, or null if nothing useful is known. */
export function describeAppearance(style: string | null | undefined, avatarConfigRaw: string | null | undefined): string | null {
  let cfg: Record<string, unknown> = {}
  if (avatarConfigRaw) { try { const o = JSON.parse(avatarConfigRaw); if (o && typeof o === 'object') cfg = o as Record<string, unknown> } catch { /* ignore */ } }

  let look: string
  if (style === 'bottts') {
    const color = nice(BASE_COLOR[first(cfg['baseColor']) ?? ''])
    look = join(['a friendly little robot' + (color ? ` with a ${color} body` : ''), lookup(BOTTTS_TOP, cfg['top'])])
  } else if (style === 'toon-head') {
    const hairColor = HAIR_COLOR[first(cfg['hairColor']) ?? '']
    const hair = lookup(TOON_HAIR, cfg['hair'])
    look = join([
      'a stylized cartoon character',
      hair ? `${hairColor ? hairColor + ' ' : ''}${hair}` : undefined,
      lookup(TOON_BEARD, cfg['beard']),
      lookup(TOON_CLOTHES, cfg['clothes']) ? `wearing ${lookup(TOON_CLOTHES, cfg['clothes'])}` : undefined,
    ])
  } else {
    // avataaars (default human style)
    const hairColor = HAIR_COLOR[first(cfg['hairColor']) ?? '']
    const top = lookup(TOP, cfg['top'])
    const clothing = lookup(CLOTHING, cfg['clothing'])
    const cc = nice(CLOTHES_COLOR[first(cfg['clothesColor']) ?? ''])
    const skin = SKIN[first(cfg['skinColor']) ?? '']
    look = join([
      'a person' + (skin ? ` with ${skin} skin` : ''),
      top ? `${hairColor && !top.startsWith('a ') ? hairColor + ' ' : ''}${top}` : undefined,
      lookup(FACIAL_HAIR, cfg['facialHair']),
      lookup(ACCESSORY, cfg['accessories']),
      clothing ? `wearing ${clothing}${cc ? ` in ${cc}` : ''}` : undefined,
    ])
  }

  if (!look) return null
  return `YOUR APPEARANCE: You look like ${look}. ${PREAMBLE}`
}
