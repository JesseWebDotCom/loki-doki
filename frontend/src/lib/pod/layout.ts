// Tab5 slot-based dashboard — shared types, grid math, and the weather catalog.
// Mirrors backend/src/lib/pod/deviceStudio.ts so the admin preview renders the EXACT
// grid the device does (WYSIWYG): same cells, same footprint math, same theme tokens.

// The built-in default layout id (mirrors backend deviceStudio.DEFAULT_TEMPLATE_ID).
// A device with no explicit assignment shows this one.
export const DEFAULT_TEMPLATE_ID = 'builtin:cozy_dark'

export const GRID_COLS = 3
export const GRID_ROWS = 3
// Device panel geometry (px) — the preview scales this down but keeps the ratio.
export const FRAME_W = 1280
export const FRAME_H = 720
export const CELL_W = FRAME_W / GRID_COLS // ≈426
export const CELL_H = FRAME_H / GRID_ROWS // 240
export const GUTTER = 12

export type WidgetSize = 'small' | 'medium' | 'large' | 'full'
export type WidgetOrient = 'horizontal' | 'vertical'
export const WIDGET_TYPES = ['clock', 'weather', 'mic', 'mute'] as const
export type WidgetType = (typeof WIDGET_TYPES)[number]

export interface WidgetPlacement {
  type: WidgetType
  size: WidgetSize
  anchor: [number, number] // [row, col]
  orient?: WidgetOrient
}

export interface ThemeTokens {
  bg: string
  accent: string
  text: string
  secondary?: string
  font_scale: number
}

export const SOUND_EVENTS = ['wake', 'endpoint', 'thinking', 'success', 'error', 'alarm', 'notification'] as const
export type SoundEvent = (typeof SOUND_EVENTS)[number]
export const SOUND_EVENT_HELP: Record<SoundEvent, string> = {
  wake: 'Wake word heard — plays locally on-device for zero latency',
  endpoint: 'Finished listening (the “got it” tick)',
  thinking: 'Processing started — often silent (the spinner covers it)',
  success: 'Action completed',
  error: 'Couldn’t complete',
  alarm: 'Alarm / timer fired',
  notification: 'A pushed alert or event',
}

export type SoundEventMap = Partial<Record<SoundEvent, string | null>>

// ── Footprint math (identical to the server) ──────────────────────────────────────
export function footprint(p: { size: WidgetSize; anchor: [number, number]; orient?: WidgetOrient }): Array<[number, number]> {
  // 'full' always covers the whole grid (anchored top-left) → a big, dead-centre element.
  if (p.size === 'full') {
    const cells: Array<[number, number]> = []
    for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) cells.push([r, c])
    return cells
  }
  const [r, c] = p.anchor
  const cells: Array<[number, number]> = []
  const add = (dr: number, dc: number) => cells.push([r + dr, c + dc])
  if (p.size === 'small') add(0, 0)
  else if (p.size === 'large') { add(0, 0); add(0, 1); add(1, 0); add(1, 1) }
  else if ((p.orient ?? 'horizontal') === 'vertical') { add(0, 0); add(1, 0) }
  else { add(0, 0); add(0, 1) }
  return cells
}

export function spanOf(p: WidgetPlacement): { rows: number; cols: number } {
  if (p.size === 'full') return { rows: GRID_ROWS, cols: GRID_COLS }
  if (p.size === 'small') return { rows: 1, cols: 1 }
  if (p.size === 'large') return { rows: 2, cols: 2 }
  return (p.orient ?? 'horizontal') === 'vertical' ? { rows: 2, cols: 1 } : { rows: 1, cols: 2 }
}

/** Mirror of the server validation (same messages) so the editor blocks bad layouts. */
export function validateWidgets(widgets: WidgetPlacement[]): string | null {
  const occupied = new Map<string, WidgetType>()
  for (const w of widgets) {
    for (const [r, c] of footprint(w)) {
      if (r < 0 || c < 0 || r >= GRID_ROWS || c >= GRID_COLS) return `“${w.type}” doesn’t fit the grid from [${w.anchor}]`
      const key = `${r},${c}`
      if (occupied.has(key)) return `“${w.type}” overlaps “${occupied.get(key)}” at slot [${r},${c}]`
      occupied.set(key, w.type)
    }
  }
  return null
}

// Standard device frame = THREE zones (every template conforms to this):
//   • top status band    — connectivity / status row (e.g. "Server unreachable")
//   • main content band  — the template's widgets (and the typed reply, on-device)
//   • bottom controls band — mic / audio / state+Stop, drawn natively by the firmware
// Widgets are centred in the MAIN band so they never collide with either overlay.
export const TOP_RESERVE = 96
export const BOTTOM_RESERVE = 200

/** Centre the occupied cells within the MAIN content band (between the top status row
 *  and the bottom controls row), so a layout that doesn't fill all 9 cells reads as
 *  intentional and never sits under the native overlays. */
export function centerOffset(widgets: WidgetPlacement[]): { x: number; y: number } {
  if (!widgets.length) return { x: 0, y: 0 }
  let minR = GRID_ROWS, maxR = -1, minC = GRID_COLS, maxC = -1
  for (const w of widgets) for (const [r, c] of footprint(w)) {
    if (r < minR) minR = r; if (r > maxR) maxR = r; if (c < minC) minC = c; if (c > maxC) maxC = c
  }
  if (maxR < 0) return { x: 0, y: 0 }
  const blockW = (maxC - minC + 1) * CELL_W, blockH = (maxR - minR + 1) * CELL_H
  const bandH = FRAME_H - TOP_RESERVE - BOTTOM_RESERVE
  const y = TOP_RESERVE + Math.max(0, (bandH - blockH) / 2) - minR * CELL_H // pin tall layouts to the top of the band
  return { x: (FRAME_W - blockW) / 2 - minC * CELL_W, y }
}

/** How to fit the occupied widget block ENTIRELY inside the main content band (between
 *  the top status row and the bottom controls) — scaling it down if it's taller/wider
 *  than the band, and centring it there. Returns a CSS transform + origin so content can
 *  never overlap either reserved zone (the cause of widgets crossing into the buttons). */
export function contentFit(widgets: WidgetPlacement[]): { scale: number; tx: number; ty: number; ox: number; oy: number } {
  const none = { scale: 1, tx: 0, ty: 0, ox: 0, oy: 0 }
  if (!widgets.length) return none
  let minR = GRID_ROWS, maxR = -1, minC = GRID_COLS, maxC = -1
  for (const w of widgets) for (const [r, c] of footprint(w)) {
    if (r < minR) minR = r; if (r > maxR) maxR = r; if (c < minC) minC = c; if (c > maxC) maxC = c
  }
  if (maxR < 0) return none
  const ox = minC * CELL_W, oy = minR * CELL_H              // block origin (grid px)
  const blockW = (maxC - minC + 1) * CELL_W, blockH = (maxR - minR + 1) * CELL_H
  const bandH = FRAME_H - TOP_RESERVE - BOTTOM_RESERVE
  const scale = Math.min(1, FRAME_W / blockW, bandH / blockH)  // shrink to fit; never enlarge
  const bcx = ox + blockW / 2, bcy = oy + blockH / 2          // block centre
  const tcx = FRAME_W / 2, tcy = TOP_RESERVE + bandH / 2      // band centre
  return { scale, tx: tcx - bcx, ty: tcy - bcy, ox: bcx, oy: bcy }
}

/** First free anchor where a widget of the given span fits, or null. */
export function firstFreeAnchor(widgets: WidgetPlacement[], size: WidgetSize, orient: WidgetOrient = 'horizontal'): [number, number] | null {
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const candidate: WidgetPlacement = { type: 'clock', size, anchor: [r, c], orient }
      if (validateWidgets([...widgets, candidate]) === null) return [r, c]
    }
  }
  return null
}

// ── Weather animation catalog (§6.1) → preview gradients + labels ───────────────────
// The device renders particle/frame animations; the admin preview shows a representative
// CSS gradient per (condition, day/night). Condition keys map 1:1 to the app's WMO
// gradients (frontend/src/lib/weather.ts heroBackground keys) plus a few extras.
export type WeatherCondition =
  | 'clear' | 'partly-cloudy' | 'cloudy' | 'fog' | 'drizzle' | 'light-rain'
  | 'heavy-rain' | 'thunderstorm' | 'snow' | 'sleet' | 'windy'

export const WEATHER_CONDITIONS: WeatherCondition[] = [
  'clear', 'partly-cloudy', 'cloudy', 'fog', 'drizzle', 'light-rain', 'heavy-rain', 'thunderstorm', 'snow', 'sleet', 'windy',
]

interface WeatherViz { label: string; day: string; night: string; approach: 'A' | 'B' | 'C' }
export const WEATHER_CATALOG: Record<WeatherCondition, WeatherViz> = {
  'clear': { label: 'Clear', approach: 'C', day: 'linear-gradient(160deg,#4a90d9,#9fc7f0)', night: 'linear-gradient(160deg,#0b1026,#1b2452)' },
  'partly-cloudy': { label: 'Partly cloudy', approach: 'B', day: 'linear-gradient(160deg,#5a93c9,#b9cfe4)', night: 'linear-gradient(160deg,#10162e,#27304f)' },
  'cloudy': { label: 'Cloudy', approach: 'C', day: 'linear-gradient(160deg,#7a8aa0,#aeb9c8)', night: 'linear-gradient(160deg,#23262e,#3a3f4a)' },
  'fog': { label: 'Fog', approach: 'A', day: 'linear-gradient(160deg,#9aa0a6,#cdd2d6)', night: 'linear-gradient(160deg,#2a2d31,#474b50)' },
  'drizzle': { label: 'Drizzle', approach: 'B', day: 'linear-gradient(160deg,#6b8190,#9fb0bb)', night: 'linear-gradient(160deg,#1a2228,#333d44)' },
  'light-rain': { label: 'Light rain', approach: 'B', day: 'linear-gradient(160deg,#52708a,#8ea3b5)', night: 'linear-gradient(160deg,#141d28,#2b3947)' },
  'heavy-rain': { label: 'Heavy rain', approach: 'B', day: 'linear-gradient(160deg,#3c4f63,#6c7d8e)', night: 'linear-gradient(160deg,#0e151d,#222e3a)' },
  'thunderstorm': { label: 'Thunderstorm', approach: 'B', day: 'linear-gradient(160deg,#2e3440,#525c6b)', night: 'linear-gradient(160deg,#0a0d14,#1c2330)' },
  'snow': { label: 'Snow', approach: 'B', day: 'linear-gradient(160deg,#aebfd0,#e7eef6)', night: 'linear-gradient(160deg,#1d2740,#3a4767)' },
  'sleet': { label: 'Sleet / wintry mix', approach: 'B', day: 'linear-gradient(160deg,#8295a8,#c2cdd9)', night: 'linear-gradient(160deg,#1a212f,#343f52)' },
  'windy': { label: 'Windy', approach: 'B', day: 'linear-gradient(160deg,#6f8aa0,#aebfce)', night: 'linear-gradient(160deg,#161d28,#2f3a47)' },
}

// ── API rows ────────────────────────────────────────────────────────────────────
export interface TemplateRow {
  id: string; name: string; grid: string; theme: string; widgets: string
  soundPackId: string | null; volume: number; alarmVolume: number
  soundOverrides: string; alarmToneId: string | null; builtin: boolean
}
export interface SoundPackRow { id: string; name: string; builtin: boolean; events: string }
export interface ChimeRow { id: string; name: string; category: 'earcon' | 'alarm'; loop: boolean; recipe: string; wavSha: string | null; builtin: boolean }
export interface AlarmRow {
  id: string; userId: string; userName: string; label: string; hour: number; minute: number
  repeatDays: number[]; enabled: boolean; toneId: string | null; toneName: string | null
  targets: string[] | null; announce: boolean; snoozeMinutes: number
}

// Chime recipe (mirrors backend audioSynth.ChimeRecipe).
export interface ChimeNote { freq: number; start_ms: number; dur_ms: number; gain?: number }
export interface ChimeRecipe {
  sample_rate?: number
  waveform?: 'sine' | 'triangle' | 'square' | 'sawtooth' | 'fm'
  notes?: ChimeNote[]
  envelope?: { attack_ms?: number; decay_ms?: number; sustain?: number; release_ms?: number }
  effects?: { reverb?: number }
  loop_ms?: number
}

export const opts: RequestInit = { credentials: 'include' }
export const JSON_HEADERS = { 'Content-Type': 'application/json' }

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, opts)
  if (!r.ok) throw new Error(`Failed to load ${url}`)
  return r.json() as Promise<T>
}
export function parse<T>(s: string | null | undefined, fallback: T): T {
  try { return s ? (JSON.parse(s) as T) : fallback } catch { return fallback }
}
export const audioUrl = (chimeId: string | null | undefined) => (chimeId ? `/api/pod/audio/${chimeId.replace(/[^a-zA-Z0-9._-]/g, '_')}.wav` : null)

// Normalise a theme so a missing/invalid token can never blank a screen to black.
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const DEFAULT_THEME: ThemeTokens = { bg: '#0E0B1A', accent: '#7C3AED', text: '#EAEAF2', font_scale: 1 }
export function safeTheme(t: Partial<ThemeTokens> | null | undefined): ThemeTokens {
  const v = t ?? {}
  const pick = (c: string | undefined, d: string) => (typeof c === 'string' && HEX.test(c) ? c : d)
  const fs = typeof v.font_scale === 'number' && Number.isFinite(v.font_scale) && v.font_scale > 0 ? v.font_scale : 1
  return { bg: pick(v.bg, DEFAULT_THEME.bg), accent: pick(v.accent, DEFAULT_THEME.accent), text: pick(v.text, DEFAULT_THEME.text), secondary: v.secondary, font_scale: fs }
}
