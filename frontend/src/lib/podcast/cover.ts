// Instant podcast cover generation — topic-themed gradient + an OpenMoji glyph +
// the show title, composited on a canvas. Fully client-side, offline (emoji SVGs
// are bundled under /public/openmoji), no AI model and no API keys.

export interface CoverPalette { c1: string; c2: string; fg: string; accent: string }

const PAL = {
  violet: { c1: '#7c3aed', c2: '#db2777', fg: '#ffffff', accent: '#fbcfe8' },
  indigo: { c1: '#0f172a', c2: '#6d28d9', fg: '#ffffff', accent: '#a78bfa' },
  sky:    { c1: '#0c4a6e', c2: '#0284c7', fg: '#ffffff', accent: '#7dd3fc' },
  cyan:   { c1: '#155e75', c2: '#06b6d4', fg: '#ecfeff', accent: '#67e8f9' },
  teal:   { c1: '#134e4a', c2: '#0d9488', fg: '#f0fdfa', accent: '#5eead4' },
  green:  { c1: '#14532d', c2: '#16a34a', fg: '#f0fdf4', accent: '#bbf7d0' },
  lime:   { c1: '#365314', c2: '#84cc16', fg: '#f7fee7', accent: '#d9f99d' },
  amber:  { c1: '#78350f', c2: '#f59e0b', fg: '#fffbeb', accent: '#fde68a' },
  orange: { c1: '#7c2d12', c2: '#ea580c', fg: '#fff7ed', accent: '#fed7aa' },
  red:    { c1: '#450a0a', c2: '#dc2626', fg: '#fef2f2', accent: '#fca5a5' },
  rose:   { c1: '#1e1b4b', c2: '#be123c', fg: '#fff1f2', accent: '#fda4af' },
  pink:   { c1: '#831843', c2: '#db2777', fg: '#fdf2f8', accent: '#f9a8d4' },
  gold:   { c1: '#1c1917', c2: '#a16207', fg: '#fefce8', accent: '#fcd34d' },
  slate:  { c1: '#0f172a', c2: '#334155', fg: '#f8fafc', accent: '#94a3b8' },
  dark:   { c1: '#111827', c2: '#374151', fg: '#f9fafb', accent: '#9ca3af' },
  yellow: { c1: '#713f12', c2: '#eab308', fg: '#fefce8', accent: '#fef08a' },
} satisfies Record<string, CoverPalette>

export const COVER_PALETTES: CoverPalette[] = Object.values(PAL)
export const paletteBg = (p: CoverPalette) => `linear-gradient(135deg,${p.c1},${p.c2})`

// ── Topic detection (palette family + category kicker + OpenMoji glyphs) ─────────
export interface CoverTheme { kicker: string; palettes: CoverPalette[]; emojis: string[] }

const THEMES: { test: RegExp; kicker: string; emojis: string[]; palettes: CoverPalette[] }[] = [
  { test: /\b(film|movie|cinema|reel|hollywood|tv|screen|series|oscar)/i, kicker: 'Film & TV', emojis: ['1F3AC', '1F37F'], palettes: [PAL.gold, PAL.red, PAL.amber, PAL.dark, PAL.rose, PAL.orange] },
  { test: /\b(news|headline|daily|world|politic|current|brief|report)/i,  kicker: 'News',      emojis: ['1F4F0'],          palettes: [PAL.red, PAL.slate, PAL.sky, PAL.dark, PAL.indigo, PAL.amber] },
  { test: /\b(sport|game|nfl|nba|mlb|soccer|football|baseball|league|match)/i, kicker: 'Sports', emojis: ['1F3C0', '26BD'],  palettes: [PAL.green, PAL.teal, PAL.sky, PAL.lime, PAL.amber, PAL.dark] },
  { test: /\b(music|song|beat|album|band|sound|audio|dj)/i,               kicker: 'Music',     emojis: ['1F3B5', '1F3A4'], palettes: [PAL.violet, PAL.pink, PAL.indigo, PAL.rose, PAL.cyan, PAL.amber] },
  { test: /\b(tech|ai|code|dev|software|science|gadget|future|digital)/i, kicker: 'Technology',emojis: ['1F4BB', '1F916'], palettes: [PAL.indigo, PAL.cyan, PAL.sky, PAL.slate, PAL.violet, PAL.teal] },
  { test: /\b(food|recipe|cook|kitchen|meal|chef|eat|cuisine)/i,          kicker: 'Food',      emojis: ['1F373', '1F374'], palettes: [PAL.orange, PAL.amber, PAL.green, PAL.red, PAL.lime, PAL.yellow] },
  { test: /\b(history|historical|past|ancient|war|empire|book|story)/i,   kicker: 'History',   emojis: ['1F4DC', '1F4DA'], palettes: [PAL.gold, PAL.slate, PAL.amber, PAL.dark, PAL.red, PAL.teal] },
  { test: /\b(comedy|joke|funny|humor|laugh|stand[- ]?up)/i,             kicker: 'Comedy',    emojis: ['1F602'],          palettes: [PAL.yellow, PAL.orange, PAL.pink, PAL.lime, PAL.violet, PAL.amber] },
  { test: /\b(health|medical|wellness|fitness|mind|therapy)/i,          kicker: 'Health',    emojis: ['1F3E5', '1FA7A'], palettes: [PAL.teal, PAL.green, PAL.sky, PAL.cyan, PAL.lime, PAL.slate] },
  { test: /\b(weather|forecast|climate|storm|world|earth|travel|map)/i,  kicker: 'World',     emojis: ['26C5', '1F30D'],  palettes: [PAL.sky, PAL.cyan, PAL.slate, PAL.indigo, PAL.teal, PAL.dark] },
]

const DEFAULT_THEME: CoverTheme = {
  kicker: 'Podcast', emojis: ['1F399', '1F3A7', '1F4A1', '1F4F1'],
  palettes: [PAL.violet, PAL.indigo, PAL.sky, PAL.orange, PAL.green, PAL.rose],
}

export function detectTheme(text: string): CoverTheme {
  const t = (text || '').toLowerCase()
  for (const theme of THEMES) if (theme.test.test(t)) return { kicker: theme.kicker, palettes: theme.palettes, emojis: theme.emojis }
  return DEFAULT_THEME
}

// ── Smart icon selection ─────────────────────────────────────────────────────────
// Map content words → specific OpenMoji glyphs so covers show icons that actually
// match the show (not one blindly-chosen emoji). Earlier entries win for ordering.
const KEYWORD_EMOJI: { re: RegExp; hex: string[] }[] = [
  { re: /\b(movie|film|cinema|reel|flick)/i,            hex: ['1F3AC', '1F39E'] },
  { re: /\b(popcorn|snack)/i,                           hex: ['1F37F'] },
  { re: /\b(oscar|award|star|rating|review|critic)/i,   hex: ['2B50'] },
  { re: /\b(ticket|premiere|box office)/i,              hex: ['1F3AB'] },
  { re: /\b(tv|television|series|episode|sitcom)/i,     hex: ['1F4FA'] },
  { re: /\b(camera|photo|photograph)/i,                 hex: ['1F4F7'] },
  { re: /\b(theat|drama|stage|broadway|act)/i,          hex: ['1F3AD'] },
  { re: /\b(news|headline|press|report|journal)/i,      hex: ['1F4F0'] },
  { re: /\b(announce|megaphone|update)/i,               hex: ['1F4E3'] },
  { re: /\b(radio|broadcast|fm)/i,                      hex: ['1F4FB'] },
  { re: /\b(talk|chat|interview|convo|discuss|debate)/i,hex: ['1F4AC'] },
  { re: /\b(ai|magic|generat|sparkle)/i,                hex: ['2728'] },
  { re: /\b(hot|trend|viral|fire|lit)/i,                hex: ['1F525'] },
  { re: /\b(podcast|mic|microphone|host|audio show)/i,  hex: ['1F399', '1F3A4'] },
  { re: /\b(headphone|listen|sound)/i,                  hex: ['1F3A7'] },
  { re: /\b(basketball|nba|hoops)/i,                    hex: ['1F3C0'] },
  { re: /\b(soccer|fifa|premier league)/i,              hex: ['26BD'] },
  { re: /\b(nfl|gridiron|quarterback)/i,                hex: ['1F3C8'] },
  { re: /\b(baseball|mlb)/i,                            hex: ['26BE'] },
  { re: /\b(tennis)/i,                                  hex: ['1F3BE'] },
  { re: /\b(trophy|champion|final|title)/i,             hex: ['1F3C6'] },
  { re: /\b(medal|olympic)/i,                           hex: ['1F3C5'] },
  { re: /\b(run|marathon|fitness|workout|gym)/i,        hex: ['1F3C3'] },
  { re: /\b(music|song|track|tune|playlist)/i,          hex: ['1F3B5', '1F3B6'] },
  { re: /\b(guitar|rock|band)/i,                        hex: ['1F3B8'] },
  { re: /\b(piano|keys)/i,                              hex: ['1F3B9'] },
  { re: /\b(sax|jazz|blues)/i,                          hex: ['1F3B7'] },
  { re: /\b(drum|beat|hip[- ]?hop)/i,                   hex: ['1F941'] },
  { re: /\b(robot|machine|automat)/i,                   hex: ['1F916'] },
  { re: /\b(code|dev|program|software|tech|comput|laptop)/i, hex: ['1F4BB'] },
  { re: /\b(engineer|gear|settings|mechanic)/i,         hex: ['2699'] },
  { re: /\b(space|satellite|signal|orbit)/i,            hex: ['1F4E1'] },
  { re: /\b(rocket|launch|startup|mars)/i,              hex: ['1F680'] },
  { re: /\b(brain|mind|psych|cogniti|think)/i,          hex: ['1F9E0'] },
  { re: /\b(science|research|lab|microscope)/i,         hex: ['1F52C'] },
  { re: /\b(chemistry|experiment)/i,                    hex: ['1F9EA'] },
  { re: /\b(biology|dna|genetic|evolution)/i,           hex: ['1F9EC'] },
  { re: /\b(phone|mobile|app)/i,                        hex: ['1F4F1'] },
  { re: /\b(idea|insight|learn|tip|how[- ]?to)/i,       hex: ['1F4A1'] },
  { re: /\b(pizza)/i,                                   hex: ['1F355'] },
  { re: /\b(burger|fast food)/i,                        hex: ['1F354'] },
  { re: /\b(coffee|cafe|espresso|morning)/i,            hex: ['2615'] },
  { re: /\b(wine|cocktail|bar|drink)/i,                 hex: ['1F377'] },
  { re: /\b(cake|dessert|bake|sweet)/i,                 hex: ['1F370'] },
  { re: /\b(food|cook|kitchen|recipe|chef|meal|cuisine)/i, hex: ['1F373', '1F374'] },
  { re: /\b(history|ancient|past|scroll)/i,             hex: ['1F4DC', '1F4DA'] },
  { re: /\b(book|read|literature|novel|story|author)/i, hex: ['1F4D6', '1F4DA'] },
  { re: /\b(castle|medieval|knight)/i,                  hex: ['1F3F0'] },
  { re: /\b(king|queen|royal|crown|empire|throne)/i,    hex: ['1F451'] },
  { re: /\b(museum|rome|greek|architect|classic)/i,     hex: ['1F3DB'] },
  { re: /\b(comedy|funny|humor|joke|laugh|standup)/i,   hex: ['1F602', '1F600'] },
  { re: /\b(clown|prank|silly)/i,                       hex: ['1F921'] },
  { re: /\b(hospital|doctor|medic|clinic|nurse)/i,      hex: ['1F3E5', '1FA7A'] },
  { re: /\b(medicine|pill|pharma|drug)/i,               hex: ['1F48A'] },
  { re: /\b(nature|plant|green|eco|garden|leaf)/i,      hex: ['1F343'] },
  { re: /\b(meditat|yoga|wellness|calm|mindful|zen)/i,  hex: ['1F9D8'] },
  { re: /\b(sun|sunny|summer)/i,                        hex: ['2600', '26C5'] },
  { re: /\b(cloud|overcast|fog)/i,                      hex: ['2601'] },
  { re: /\b(rain|umbrella|monsoon)/i,                   hex: ['2602'] },
  { re: /\b(snow|winter|cold|ski)/i,                    hex: ['2744'] },
  { re: /\b(rainbow|pride)/i,                           hex: ['1F308'] },
  { re: /\b(storm|thunder|lightning|energy|power)/i,    hex: ['26A1'] },
  { re: /\b(weather|forecast|climate)/i,                hex: ['26C5', '2601'] },
  { re: /\b(world|global|earth|geo|planet)/i,           hex: ['1F30D'] },
  { re: /\b(map|location|place|city)/i,                 hex: ['1F5FA'] },
  { re: /\b(travel|explore|adventure|journey|compass)/i,hex: ['1F9ED'] },
  { re: /\b(flight|plane|airport|trip|vacation)/i,      hex: ['2708'] },
  { re: /\b(mountain|hike|outdoor|trail)/i,             hex: ['26F0'] },
  { re: /\b(calendar|daily|schedule|today|weekly|date)/i, hex: ['1F4C5'] },
  { re: /\b(video|youtube|stream|vlog)/i,               hex: ['1F4F9', '1F4FA'] },
]

const GENERAL_EMOJI = ['1F399', '1F3A7', '2728', '2B50', '1F4A1', '1F4AC']

// Token → hex index built from OpenMoji's own annotations/tags (~2000 icons), so
// any topic word can resolve to a fitting glyph. Loaded once, lazily.
interface IndexEntry { h: string; a: string; t: string; g: string }
let tokenIndexPromise: Promise<Map<string, string>> | null = null

function buildTokenIndex(entries: IndexEntry[]): Map<string, string> {
  const m = new Map<string, string>()
  const add = (list: IndexEntry[]) => {
    for (const e of list) {
      const toks = `${e.a} ${e.t}`.split(/[^a-z0-9]+/).filter(w => w.length >= 3)
      for (const t of toks) if (!m.has(t)) m.set(t, e.h)
    }
  }
  // Prefer clean single-codepoint base emoji, then fall back to sequences.
  add(entries.filter(e => !e.h.includes('-')))
  add(entries.filter(e => e.h.includes('-')))
  return m
}

async function loadTokenIndex(): Promise<Map<string, string>> {
  if (!tokenIndexPromise) {
    tokenIndexPromise = fetch('/openmoji/index.json')
      .then(r => r.json() as Promise<IndexEntry[]>)
      .then(buildTokenIndex)
      .catch(() => new Map<string, string>())
  }
  return tokenIndexPromise
}

/** Pick a varied, content-matched set of glyphs: curated topic icons first, then
 *  OpenMoji tag-search over the show's words, then theme + general fallbacks. */
export async function selectEmojis(text: string, theme: CoverTheme): Promise<string[]> {
  const out: string[] = []
  const push = (h?: string) => { if (h && !out.includes(h)) out.push(h) }
  const lc = (text || '').toLowerCase()
  for (const { re, hex } of KEYWORD_EMOJI) if (re.test(lc)) hex.forEach(push)
  try {
    const idx = await loadTokenIndex()
    const words = [...new Set(lc.split(/[^a-z0-9]+/).filter(w => w.length >= 3))].slice(0, 10)
    for (const w of words) push(idx.get(w))
  } catch { /* index optional */ }
  theme.emojis.forEach(push)
  GENERAL_EMOJI.forEach(push)
  return out
}

export function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Deterministic palette + kicker + emoji for a show (stable fallback art). */
export function fallbackTheme(seed: string, text: string): { palette: CoverPalette; kicker: string; emojiHex: string } {
  const theme = detectTheme(text)
  const i = hashString(seed)
  return { palette: theme.palettes[i % theme.palettes.length], kicker: theme.kicker, emojiHex: theme.emojis[i % theme.emojis.length] }
}

export const emojiUrl = (hex: string) => `/openmoji/${hex}.svg`

// ── Canvas rendering ─────────────────────────────────────────────────────────────
const emojiCache = new Map<string, Promise<HTMLImageElement>>()
function loadEmoji(hex: string): Promise<HTMLImageElement> {
  let p = emojiCache.get(hex)
  if (!p) {
    p = new Promise((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = () => reject(new Error('emoji'))
      im.src = emojiUrl(hex)
    })
    emojiCache.set(hex, p)
  }
  return p
}

// Source photos (channel avatar / playlist or video thumbnail) loaded same-origin via
// our proxy, so they can be composited onto the cover canvas without tainting it.
const imageCache = new Map<string, Promise<HTMLImageElement>>()
export function loadCoverImage(url: string): Promise<HTMLImageElement> {
  let p = imageCache.get(url)
  if (!p) {
    p = new Promise((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = () => reject(new Error('image'))
      im.src = url
    })
    imageCache.set(url, p)
  }
  return p
}

/** Draw an image scaled to *cover* the target box (center-cropped). */
function drawImageCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, dx: number, dy: number, dw: number, dh: number) {
  const ir = img.width / img.height, dr = dw / dh
  let sx = 0, sy = 0, sw = img.width, sh = img.height
  if (ir > dr) { sw = sh * dr; sx = (img.width - sw) / 2 }
  else { sh = sw / dr; sy = (img.height - sh) / 2 }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
}

export type Layout =
  | 'center' | 'badge' | 'watermark' | 'bleedRight' | 'bleedLeft' | 'bleedBottom' | 'giantText' | 'bigIcon'
  | 'circle' | 'circleBadge' | 'split' | 'tiled' | 'iconRow'
  | 'photoFull' | 'photoCircle' | 'photoBadge'
export const LAYOUTS: Layout[] = [
  'center', 'bleedRight', 'giantText', 'circle', 'iconRow', 'bigIcon',
  'watermark', 'split', 'tiled', 'badge', 'bleedLeft', 'circleBadge', 'bleedBottom',
]
// Layouts that build the cover around a supplied photo (channel avatar / thumbnail).
export const IMAGE_LAYOUTS: Layout[] = ['photoFull', 'photoCircle', 'photoBadge']

export interface CoverOpts {
  title: string; kicker: string; palette: CoverPalette
  emojiHex: string; emojis?: string[]; layout: Layout; size?: number
  image?: HTMLImageElement | null
}

function wrapAll(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w }
    else line = test
  }
  if (line) lines.push(line)
  return lines
}

/** Shrink the font until the wrapped title fits the box (width, line count, height). */
function fitTitle(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startFs: number, maxLines: number, maxBlockH: number) {
  let fs = startFs
  for (;;) {
    ctx.font = `800 ${Math.round(fs)}px sans-serif`
    const lines = wrapAll(ctx, text, maxWidth)
    const widest = Math.max(0, ...lines.map(l => ctx.measureText(l).width))
    if ((lines.length <= maxLines && widest <= maxWidth && lines.length * fs * 1.06 <= maxBlockH) || fs <= 12) return { fs, lines }
    fs *= 0.92
  }
}

function drawTitleBlock(ctx: CanvasRenderingContext2D, lines: string[], fs: number, color: string,
  x: number, topY: number, align: CanvasTextAlign) {
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'top'
  ctx.font = `800 ${Math.round(fs)}px sans-serif`
  let y = topY
  for (const ln of lines) { ctx.fillText(ln, x, y); y += fs * 1.06 }
  ctx.textAlign = 'left'
}

function drawEmoji(ctx: CanvasRenderingContext2D, emoji: HTMLImageElement, x: number, y: number, s: number, alpha = 1) {
  if (alpha < 1) { ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(emoji, x, y, s, s); ctx.restore() }
  else ctx.drawImage(emoji, x, y, s, s)
}

function drawKicker(ctx: CanvasRenderingContext2D, text: string, color: string, x: number, y: number, size: number, align: CanvasTextAlign = 'left') {
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'top'
  ctx.font = `700 ${Math.round(size * 0.044)}px sans-serif`
  ctx.fillText(text.toUpperCase(), x, y)
  ctx.textAlign = 'left'
}

async function renderCanvas(opts: CoverOpts): Promise<HTMLCanvasElement> {
  const size = opts.size ?? 512
  const { palette: p, emojiHex, layout } = opts
  const title = (opts.title.trim() || 'Untitled').toUpperCase()
  const kicker = opts.kicker
  const canvas = document.createElement('canvas')
  canvas.width = size; canvas.height = size
  const ctx = canvas.getContext('2d')!
  const pad = Math.round(size * 0.09)

  // Gradient background
  const g = ctx.createLinearGradient(0, 0, size, size)
  g.addColorStop(0, p.c1); g.addColorStop(1, p.c2)
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size)

  const img = opts.image ?? null
  let emoji: HTMLImageElement | null = null
  try { emoji = await loadEmoji(emojiHex) } catch { /* gradient-only */ }

  switch (layout) {
    case 'photoFull': {
      if (img) drawImageCover(ctx, img, 0, 0, size, size)
      const grd = ctx.createLinearGradient(0, size * 0.4, 0, size)
      grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,0,0,0.8)')
      ctx.fillStyle = grd; ctx.fillRect(0, 0, size, size)
      drawKicker(ctx, kicker, p.accent, pad, size * 0.6, size)
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.13, 3, size * 0.3)
      const blockH = lines.length * fs * 1.06
      drawTitleBlock(ctx, lines, fs, '#ffffff', pad, size - pad - blockH, 'left')
      break
    }
    case 'photoCircle': {
      const r = size * 0.21, cx = size / 2, cy = size * 0.34
      if (img) {
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip()
        drawImageCover(ctx, img, cx - r, cy - r, r * 2, r * 2); ctx.restore()
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.lineWidth = Math.max(2, size * 0.012); ctx.strokeStyle = p.accent; ctx.stroke(); ctx.restore()
      }
      drawKicker(ctx, kicker, p.accent, size / 2, size * 0.58, size, 'center')
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.12, 3, size * 0.28)
      drawTitleBlock(ctx, lines, fs, p.fg, size / 2, size * 0.64, 'center')
      break
    }
    case 'photoBadge': {
      const b = size * 0.4
      if (img) {
        ctx.save(); roundRect(ctx, pad, pad, b, b, b * 0.16); ctx.clip()
        drawImageCover(ctx, img, pad, pad, b, b); ctx.restore()
      }
      drawKicker(ctx, kicker, p.accent, pad, pad + b + size * 0.04, size)
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.13, 3, size * 0.34)
      const blockH = lines.length * fs * 1.06
      drawTitleBlock(ctx, lines, fs, p.fg, pad, size - pad - blockH, 'left')
      break
    }
    case 'center': {
      if (emoji) drawEmoji(ctx, emoji, (size - size * 0.34) / 2, size * 0.14, size * 0.34)
      drawKicker(ctx, kicker, p.accent, size / 2, size * 0.55, size, 'center')
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.13, 3, size * 0.3)
      drawTitleBlock(ctx, lines, fs, p.fg, size / 2, size * 0.62, 'center')
      break
    }
    case 'bigIcon': {
      if (emoji) drawEmoji(ctx, emoji, (size - size * 0.6) / 2, size * 0.1, size * 0.6)
      drawKicker(ctx, kicker, p.accent, size / 2, size * 0.74, size, 'center')
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.085, 2, size * 0.18)
      drawTitleBlock(ctx, lines, fs, p.fg, size / 2, size * 0.8, 'center')
      break
    }
    case 'giantText': {
      // Typographic: huge title filling the cover, tiny emoji accent in the corner.
      if (emoji) drawEmoji(ctx, emoji, size - pad - size * 0.16, pad, size * 0.16, 0.9)
      drawKicker(ctx, kicker, p.accent, pad, pad, size)
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.3, 5, size * 0.66)
      const blockH = lines.length * fs * 1.06
      drawTitleBlock(ctx, lines, fs, p.fg, pad, (size - blockH) / 2 + size * 0.04, 'left')
      ctx.fillStyle = p.accent; ctx.fillRect(pad, size - pad, size * 0.34, Math.max(3, size * 0.018))
      break
    }
    case 'watermark': {
      if (emoji) drawEmoji(ctx, emoji, size - size * 0.5, size - size * 0.46, size * 0.66, 0.22)
      drawKicker(ctx, kicker, p.accent, pad, pad, size)
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.14, 4, size * 0.5)
      drawTitleBlock(ctx, lines, fs, p.fg, pad, pad + size * 0.09, 'left')
      break
    }
    case 'badge': {
      const b = size * 0.24
      ctx.save(); ctx.globalAlpha = 0.18; ctx.fillStyle = p.fg
      roundRect(ctx, pad, pad, b, b, b * 0.22); ctx.fill(); ctx.restore()
      if (emoji) drawEmoji(ctx, emoji, pad + b * 0.16, pad + b * 0.16, b * 0.68)
      drawKicker(ctx, kicker, p.accent, pad, pad + b + size * 0.03, size)
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.13, 3, size * 0.34)
      const blockH = lines.length * fs * 1.06
      drawTitleBlock(ctx, lines, fs, p.fg, pad, size - pad - blockH, 'left')
      break
    }
    case 'bleedRight': {
      if (emoji) drawEmoji(ctx, emoji, size * 0.42, (size - size * 0.92) / 2, size * 0.92)
      drawKicker(ctx, kicker, p.accent, pad, size * 0.34, size)
      const { fs, lines } = fitTitle(ctx, title, size * 0.46, size * 0.12, 4, size * 0.4)
      drawTitleBlock(ctx, lines, fs, p.fg, pad, size * 0.42, 'left')
      break
    }
    case 'bleedLeft': {
      if (emoji) drawEmoji(ctx, emoji, -size * 0.34, (size - size * 0.92) / 2, size * 0.92)
      drawKicker(ctx, kicker, p.accent, size - pad, size * 0.34, size, 'right')
      const { fs, lines } = fitTitle(ctx, title, size * 0.46, size * 0.12, 4, size * 0.4)
      drawTitleBlock(ctx, lines, fs, p.fg, size - pad, size * 0.42, 'right')
      break
    }
    case 'bleedBottom': {
      if (emoji) drawEmoji(ctx, emoji, (size - size * 0.95) / 2, size * 0.44, size * 0.95)
      drawKicker(ctx, kicker, p.accent, pad, pad, size)
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.15, 3, size * 0.3)
      drawTitleBlock(ctx, lines, fs, p.fg, pad, pad + size * 0.09, 'left')
      break
    }
    case 'circle': {
      const r = size * 0.2, cx = size / 2, cy = size * 0.34
      ctx.save(); ctx.globalAlpha = 0.16; ctx.fillStyle = p.fg
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.restore()
      if (emoji) drawEmoji(ctx, emoji, cx - r * 0.62, cy - r * 0.62, r * 1.24)
      drawKicker(ctx, kicker, p.accent, size / 2, size * 0.58, size, 'center')
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.12, 3, size * 0.28)
      drawTitleBlock(ctx, lines, fs, p.fg, size / 2, size * 0.64, 'center')
      break
    }
    case 'circleBadge': {
      const r = size * 0.12, cx = pad + r, cy = pad + r
      ctx.save(); ctx.globalAlpha = 0.18; ctx.fillStyle = p.fg
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.restore()
      if (emoji) drawEmoji(ctx, emoji, cx - r * 0.6, cy - r * 0.6, r * 1.2)
      drawKicker(ctx, kicker, p.accent, pad, cy + r + size * 0.03, size)
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.13, 3, size * 0.34)
      const blockH = lines.length * fs * 1.06
      drawTitleBlock(ctx, lines, fs, p.fg, pad, size - pad - blockH, 'left')
      break
    }
    case 'split': {
      const h = size * 0.52
      ctx.save(); ctx.globalAlpha = 0.1; ctx.fillStyle = p.fg; ctx.fillRect(0, 0, size, h); ctx.restore()
      if (emoji) { const es = size * 0.34; drawEmoji(ctx, emoji, (size - es) / 2, (h - es) / 2, es) }
      drawKicker(ctx, kicker, p.accent, pad, h + size * 0.06, size)
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.13, 2, size * 0.28)
      drawTitleBlock(ctx, lines, fs, p.fg, pad, h + size * 0.12, 'left')
      break
    }
    case 'tiled': {
      if (emoji) {
        const s = size * 0.16, gap = size * 0.22
        ctx.save(); ctx.globalAlpha = 0.12
        for (let y = size * 0.04; y < size; y += gap) for (let x = size * 0.04; x < size; x += gap) ctx.drawImage(emoji, x, y, s, s)
        ctx.restore()
      }
      const grd = ctx.createLinearGradient(0, size * 0.45, 0, size)
      grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,0,0,0.55)')
      ctx.fillStyle = grd; ctx.fillRect(0, 0, size, size)
      drawKicker(ctx, kicker, p.accent, size / 2, size * 0.62, size, 'center')
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.13, 3, size * 0.28)
      drawTitleBlock(ctx, lines, fs, p.fg, size / 2, size * 0.68, 'center')
      break
    }
    case 'iconRow': {
      const set = (opts.emojis?.length ? opts.emojis : [emojiHex]).slice(0, 3)
      const imgs = (await Promise.all(set.map(h => loadEmoji(h).catch(() => null)))).filter(Boolean) as HTMLImageElement[]
      const es = size * 0.2, gap = size * 0.06
      const totalW = imgs.length * es + Math.max(0, imgs.length - 1) * gap
      let x = (size - totalW) / 2
      for (const im of imgs) { ctx.drawImage(im, x, size * 0.2, es, es); x += es + gap }
      drawKicker(ctx, kicker, p.accent, size / 2, size * 0.5, size, 'center')
      const { fs, lines } = fitTitle(ctx, title, size - pad * 2, size * 0.13, 3, size * 0.32)
      drawTitleBlock(ctx, lines, fs, p.fg, size / 2, size * 0.56, 'center')
      break
    }
  }

  return canvas
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Render a cover to a data URL (for previews). */
export async function coverPreview(opts: CoverOpts): Promise<string> {
  return (await renderCanvas(opts)).toDataURL('image/png')
}

/** Render a cover to a PNG blob + data URL (for saving). */
export async function coverBlob(opts: CoverOpts): Promise<{ blob: Blob; dataUrl: string }> {
  const canvas = await renderCanvas({ ...opts, size: opts.size ?? 512 })
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob')), 'image/png'))
  return { blob, dataUrl: canvas.toDataURL('image/png') }
}

export interface CoverVariant { key: number; dataUrl: string; palette: CoverPalette; emojiHex: string; emojis: string[]; layout: Layout; kicker: string; image?: HTMLImageElement | null }

function rotate<T>(arr: T[], n: number): T[] {
  if (arr.length === 0) return arr
  const k = ((n % arr.length) + arr.length) % arr.length
  return [...arr.slice(k), ...arr.slice(0, k)]
}

/** A grid of distinct topic-themed variants — varied palette × layout × smartly
 *  selected (content-matched) icons, with multi-icon layouts using several. */
export async function generateThemedVariants(title: string, topicText: string, count = 6, size = 320, offset = 0, imageUrl?: string): Promise<CoverVariant[]> {
  const theme = detectTheme(`${title} ${topicText}`)
  const picked = await selectEmojis(`${title} ${topicText}`, theme)
  const pool = offset === 0 ? theme.palettes : [...theme.palettes, ...COVER_PALETTES]
  // When a source image is supplied, build roughly half the variants around it.
  const image = imageUrl ? await loadCoverImage(imageUrl).catch(() => null) : null
  const out: CoverVariant[] = []
  for (let i = 0; i < count; i++) {
    const palette = pool[(offset + i) % pool.length]
    const emojis = rotate(picked, offset + i)            // primary + extras differ per variant
    const emojiHex = emojis[0]
    const useImage = !!image && (offset + i) % 2 === 0
    const layout = useImage ? IMAGE_LAYOUTS[(offset + i) % IMAGE_LAYOUTS.length] : LAYOUTS[(offset + i) % LAYOUTS.length]
    const opts: CoverOpts = { title: title || 'New Show', kicker: theme.kicker, palette, emojiHex, emojis, layout, size, image: useImage ? image : null }
    out.push({ key: offset * 100 + i, dataUrl: await coverPreview(opts), palette, emojiHex, emojis, layout, kicker: theme.kicker, image: useImage ? image : null })
  }
  return out
}
