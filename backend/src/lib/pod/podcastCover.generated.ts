// AUTO-GENERATED from frontend cover.ts. Do not edit by hand.
export interface CoverPalette { c1: string; c2: string; fg: string; accent: string }
const PAL: Record<string, CoverPalette> = {
  violet: { c1: '#7c3aed', c2: '#db2777', fg: '#ffffff', accent: '#fbcfe8' },
  indigo: { c1: '#0f172a', c2: '#6d28d9', fg: '#ffffff', accent: '#a78bfa' },
  sky: { c1: '#0c4a6e', c2: '#0284c7', fg: '#ffffff', accent: '#7dd3fc' },
  cyan: { c1: '#155e75', c2: '#06b6d4', fg: '#ecfeff', accent: '#67e8f9' },
  teal: { c1: '#134e4a', c2: '#0d9488', fg: '#f0fdfa', accent: '#5eead4' },
  green: { c1: '#14532d', c2: '#16a34a', fg: '#f0fdf4', accent: '#bbf7d0' },
  lime: { c1: '#365314', c2: '#84cc16', fg: '#f7fee7', accent: '#d9f99d' },
  amber: { c1: '#78350f', c2: '#f59e0b', fg: '#fffbeb', accent: '#fde68a' },
  orange: { c1: '#7c2d12', c2: '#ea580c', fg: '#fff7ed', accent: '#fed7aa' },
  red: { c1: '#450a0a', c2: '#dc2626', fg: '#fef2f2', accent: '#fca5a5' },
  rose: { c1: '#1e1b4b', c2: '#be123c', fg: '#fff1f2', accent: '#fda4af' },
  pink: { c1: '#831843', c2: '#db2777', fg: '#fdf2f8', accent: '#f9a8d4' },
  gold: { c1: '#1c1917', c2: '#a16207', fg: '#fefce8', accent: '#fcd34d' },
  slate: { c1: '#0f172a', c2: '#334155', fg: '#f8fafc', accent: '#94a3b8' },
  dark: { c1: '#111827', c2: '#374151', fg: '#f9fafb', accent: '#9ca3af' },
  yellow: { c1: '#713f12', c2: '#eab308', fg: '#fefce8', accent: '#fef08a' },
}
const THEMES: { test: RegExp; emojis: string[]; palettes: CoverPalette[] }[] = [
  { test: /\b(film|movie|cinema|reel|hollywood|tv|screen|series|oscar)/i, emojis: ['1F3AC', '1F37F'], palettes: [PAL.gold, PAL.red, PAL.amber, PAL.dark, PAL.rose, PAL.orange] },
  { test: /\b(news|headline|daily|world|politic|current|brief|report)/i, emojis: ['1F4F0'], palettes: [PAL.red, PAL.slate, PAL.sky, PAL.dark, PAL.indigo, PAL.amber] },
  { test: /\b(sport|game|nfl|nba|mlb|soccer|football|baseball|league|match)/i, emojis: ['1F3C0', '26BD'], palettes: [PAL.green, PAL.teal, PAL.sky, PAL.lime, PAL.amber, PAL.dark] },
  { test: /\b(music|song|beat|album|band|sound|audio|dj)/i, emojis: ['1F3B5', '1F3A4'], palettes: [PAL.violet, PAL.pink, PAL.indigo, PAL.rose, PAL.cyan, PAL.amber] },
  { test: /\b(tech|ai|code|dev|software|science|gadget|future|digital)/i, emojis: ['1F4BB', '1F916'], palettes: [PAL.indigo, PAL.cyan, PAL.sky, PAL.slate, PAL.violet, PAL.teal] },
  { test: /\b(food|recipe|cook|kitchen|meal|chef|eat|cuisine)/i, emojis: ['1F373', '1F374'], palettes: [PAL.orange, PAL.amber, PAL.green, PAL.red, PAL.lime, PAL.yellow] },
  { test: /\b(history|historical|past|ancient|war|empire|book|story)/i, emojis: ['1F4DC', '1F4DA'], palettes: [PAL.gold, PAL.slate, PAL.amber, PAL.dark, PAL.red, PAL.teal] },
  { test: /\b(comedy|joke|funny|humor|laugh|stand[- ]?up)/i, emojis: ['1F602'], palettes: [PAL.yellow, PAL.orange, PAL.pink, PAL.lime, PAL.violet, PAL.amber] },
  { test: /\b(health|medical|wellness|fitness|mind|therapy)/i, emojis: ['1F3E5', '1FA7A'], palettes: [PAL.teal, PAL.green, PAL.sky, PAL.cyan, PAL.lime, PAL.slate] },
  { test: /\b(weather|forecast|climate|storm|world|earth|travel|map)/i, emojis: ['26C5', '1F30D'], palettes: [PAL.sky, PAL.cyan, PAL.slate, PAL.indigo, PAL.teal, PAL.dark] },
]
const DEFAULT_THEME = { emojis: ['1F399', '1F3A7', '1F4A1', '1F4F1'], palettes: [PAL.violet, PAL.indigo, PAL.sky, PAL.orange, PAL.green, PAL.rose] }

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
/** Deterministic palette + emoji hex for a show (mirrors frontend fallbackTheme). */
export function podcastFallback(seed: string, text: string): { palette: CoverPalette; emojiHex: string } {
  const t = (text || '').toLowerCase()
  const theme = THEMES.find(th => th.test.test(t)) ?? DEFAULT_THEME
  const i = hashString(seed)
  return { palette: theme.palettes[i % theme.palettes.length]!, emojiHex: theme.emojis[i % theme.emojis.length]! }
}
