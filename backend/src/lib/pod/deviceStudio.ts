// Tab5 modular slot-based dashboard — server-side service.
//
// Owns the named layout TEMPLATES (3×3 slot grid + theme tokens + sound pack),
// the swappable SOUND PACKS (event → chime), and the synthesised CHIME library
// (earcons + looping alarm tones). The firmware ships every widget pre-built; the
// server sends a descriptor (which widget in which slot at what size + theme) plus
// the resolved event→file sound map. Changing a layout/colour/sound is a DB edit
// pushed over the gateway — never a re-flash (see plans/hardware-devices/tab5-slot-ui.md).
//
// All audio is recipe-driven: a chime is rendered to a 16 kHz mono WAV under
// data/pod/audio/<id>.wav (audioSynth.ts) and served by /api/pod/audio/<id>.wav.
// Built-in chimes/packs/templates are seeded + rendered at boot by ensureBuiltins().

import { resolve } from 'node:path'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { eq, and, notInArray } from 'drizzle-orm'
import { db } from '@/db'
import { devices, deviceChimes, deviceSoundPacks, deviceLayoutTemplates } from '@/db/schema'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'
import { renderChimeWav, wavSha256, type ChimeRecipe } from '@/lib/pod/audioSynth'

export const AUDIO_DIR = resolve(dataDir, 'pod', 'audio')

// ── The grid + widget contract (mirrored on the device and in the admin preview) ──
export const GRID_COLS = 3
export const GRID_ROWS = 3
export type WidgetSize = 'small' | 'medium' | 'large' | 'full'
export type WidgetOrient = 'horizontal' | 'vertical'
export const WIDGET_TYPES = ['clock', 'weather', 'mic', 'mute', 'blank'] as const
export type WidgetType = (typeof WIDGET_TYPES)[number]

export interface WidgetPlacement {
  type: WidgetType
  size: WidgetSize
  anchor: [number, number]     // [row, col]
  orient?: WidgetOrient        // medium only; default 'horizontal'
  bg?: boolean                 // weather only: full-height weather background behind its column(s)
}

export interface ThemeTokens {
  bg: string
  accent: string
  text: string
  secondary?: string
  font_scale: number
  // Optional SECOND stop for a background gradient (top → bottom). Used by the native
  // LVGL renderer to paint a themed gradient; the JPEG/React renderer falls back to a
  // flat `bg` when absent. Hex like `bg`.
  bg2?: string
  // Optional secondary accent (e.g. the weather-card glow). Falls back to `accent`.
  accent2?: string
}

// How a device should DRAW a template:
//   'jpeg' — the server screenshots the React /display page and streams it as JPEG
//            (the original path; pixel-perfect with the web app, server does the work).
//   'lvgl' — the device renders the dashboard NATIVELY in LVGL from this descriptor +
//            a pushed weather feed (no server pixels; tested for quality + performance).
// Resolved from the template id (built-in LVGL templates are prefixed `builtin:lvgl`).
export type DisplayRenderer = 'jpeg' | 'lvgl'
export function rendererForTemplateId(id: string | null | undefined): DisplayRenderer {
  return id && id.startsWith('builtin:lvgl') ? 'lvgl' : 'jpeg'
}

// The earcon event vocabulary. `null` (silent) is a first-class value per event.
export const SOUND_EVENTS = ['wake', 'endpoint', 'thinking', 'success', 'error', 'alarm', 'notification'] as const
export type SoundEvent = (typeof SOUND_EVENTS)[number]
export type SoundEventMap = Partial<Record<SoundEvent, string | null>>

// ── Footprint math: cells a placement covers (and whether it fits the grid) ──────
export function footprint(p: { size: WidgetSize; anchor: [number, number]; orient?: WidgetOrient }): Array<[number, number]> {
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

/** Server-side validation (the firmware trusts the descriptor — §3.2). Returns a
 *  human-readable error, or null if the layout is valid. */
export function validateWidgets(widgets: WidgetPlacement[]): string | null {
  const occupied = new Map<string, WidgetType>()
  for (const w of widgets) {
    if (!WIDGET_TYPES.includes(w.type)) return `Unknown widget "${w.type}"`
    if (w.type === 'blank') continue
    for (const [r, c] of footprint(w)) {
      if (r < 0 || c < 0 || r >= GRID_ROWS || c >= GRID_COLS) return `"${w.type}" doesn't fit the grid from [${w.anchor}]`
      const key = `${r},${c}`
      if (occupied.has(key)) return `"${w.type}" overlaps "${occupied.get(key)}" at slot [${r},${c}]`
      occupied.set(key, w.type)
    }
  }
  return null
}

// ── Built-in chime recipes ───────────────────────────────────────────────────────
// ids are stable strings (prefixed builtin:) so packs/templates reference them and a
// re-render keeps the same id. Designed to be short, bright, and pre-normalised.
interface BuiltinChime { id: string; name: string; category: 'earcon' | 'alarm'; loop: boolean; recipe: ChimeRecipe }

const note = (freq: number, start_ms: number, dur_ms: number, gain = 0.85) => ({ freq, start_ms, dur_ms, gain })

export const BUILTIN_CHIMES: BuiltinChime[] = [
  { id: 'builtin:wake_bright', name: 'Bright Wake', category: 'earcon', loop: false,
    recipe: { waveform: 'sine', envelope: { attack_ms: 4, decay_ms: 40, sustain: 0.3, release_ms: 130 }, effects: { reverb: 0.15 },
      notes: [note(880, 0, 110), note(1320, 60, 150)] } },
  { id: 'builtin:endpoint', name: 'Got It', category: 'earcon', loop: false,
    recipe: { waveform: 'sine', envelope: { attack_ms: 3, decay_ms: 30, sustain: 0.2, release_ms: 80 },
      notes: [note(1175, 0, 70, 0.7)] } },
  { id: 'builtin:thinking_blip', name: 'Thinking Blip', category: 'earcon', loop: false,
    recipe: { waveform: 'triangle', envelope: { attack_ms: 2, decay_ms: 20, sustain: 0.1, release_ms: 60 },
      notes: [note(660, 0, 50, 0.5)] } },
  { id: 'builtin:success', name: 'Success', category: 'earcon', loop: false,
    recipe: { waveform: 'sine', envelope: { attack_ms: 4, decay_ms: 50, sustain: 0.3, release_ms: 140 }, effects: { reverb: 0.18 },
      notes: [note(659, 0, 90), note(988, 70, 110), note(1319, 150, 170)] } },
  { id: 'builtin:error_soft', name: 'Soft Error', category: 'earcon', loop: false,
    recipe: { waveform: 'triangle', envelope: { attack_ms: 4, decay_ms: 40, sustain: 0.3, release_ms: 120 },
      notes: [note(440, 0, 120), note(330, 110, 180, 0.8)] } },
  { id: 'builtin:notify', name: 'Notify', category: 'earcon', loop: false,
    recipe: { waveform: 'sine', envelope: { attack_ms: 4, decay_ms: 40, sustain: 0.3, release_ms: 130 }, effects: { reverb: 0.12 },
      notes: [note(784, 0, 90), note(1047, 70, 130)] } },
  { id: 'builtin:classic_beep', name: 'Classic Beep', category: 'earcon', loop: false,
    recipe: { waveform: 'square', envelope: { attack_ms: 2, decay_ms: 10, sustain: 0.6, release_ms: 40 },
      notes: [note(1000, 0, 90, 0.5)] } },
  // ── Alarm tones (looping, insistent) ──
  { id: 'builtin:alarm_gentle', name: 'Gentle', category: 'alarm', loop: true,
    recipe: { loop_ms: 2400, waveform: 'sine', envelope: { attack_ms: 60, decay_ms: 200, sustain: 0.4, release_ms: 400 }, effects: { reverb: 0.25 },
      notes: [note(523, 0, 400), note(659, 300, 400), note(784, 600, 600), note(659, 1200, 500)] } },
  { id: 'builtin:alarm_classic', name: 'Classic', category: 'alarm', loop: true,
    recipe: { loop_ms: 1600, waveform: 'square', envelope: { attack_ms: 4, decay_ms: 20, sustain: 0.7, release_ms: 40 },
      notes: [note(880, 0, 180, 0.5), note(880, 300, 180, 0.5), note(880, 600, 180, 0.5), note(880, 900, 180, 0.5)] } },
  { id: 'builtin:alarm_klaxon', name: 'Klaxon', category: 'alarm', loop: true,
    recipe: { loop_ms: 1400, waveform: 'sawtooth', envelope: { attack_ms: 8, decay_ms: 20, sustain: 0.8, release_ms: 60 },
      notes: [note(440, 0, 350, 0.55), note(587, 350, 350, 0.55), note(440, 700, 350, 0.55), note(587, 1050, 350, 0.55)] } },
  { id: 'builtin:alarm_birdsong', name: 'Birdsong', category: 'alarm', loop: true,
    recipe: { loop_ms: 2600, waveform: 'fm', envelope: { attack_ms: 5, decay_ms: 60, sustain: 0.2, release_ms: 120 }, effects: { reverb: 0.35 },
      notes: [note(2093, 0, 80, 0.5), note(2637, 120, 80, 0.5), note(2093, 260, 80, 0.5),
        note(3136, 900, 90, 0.5), note(2637, 1040, 90, 0.5), note(2093, 1180, 100, 0.5),
        note(2349, 1900, 80, 0.5), note(2793, 2040, 120, 0.5)] } },
  // ── Status display earcons ──
  { id: 'builtin:status_set', name: 'Status Set', category: 'earcon', loop: false,
    recipe: { waveform: 'sine', envelope: { attack_ms: 6, decay_ms: 60, sustain: 0.25, release_ms: 180 }, effects: { reverb: 0.2 },
      notes: [note(587, 0, 100), note(880, 90, 140)] } },
  { id: 'builtin:status_clear', name: 'Status Clear', category: 'earcon', loop: false,
    recipe: { waveform: 'sine', envelope: { attack_ms: 6, decay_ms: 50, sustain: 0.2, release_ms: 150 }, effects: { reverb: 0.15 },
      notes: [note(880, 0, 100), note(587, 90, 140)] } },
  { id: 'builtin:sleep_enter', name: 'Sleep Enter', category: 'earcon', loop: false,
    recipe: { waveform: 'sine', envelope: { attack_ms: 30, decay_ms: 120, sustain: 0.15, release_ms: 500 }, effects: { reverb: 0.4 },
      notes: [note(440, 0, 200), note(330, 180, 280), note(220, 380, 400, 0.6)] } },
  { id: 'builtin:wake_chime', name: 'Wake Chime', category: 'earcon', loop: false,
    recipe: { waveform: 'sine', envelope: { attack_ms: 8, decay_ms: 60, sustain: 0.3, release_ms: 200 }, effects: { reverb: 0.25 },
      notes: [note(523, 0, 120), note(659, 110, 130), note(784, 230, 180), note(1047, 380, 250)] } },
  { id: 'builtin:pomodoro_work', name: 'Focus Start', category: 'earcon', loop: false,
    recipe: { waveform: 'sine', envelope: { attack_ms: 5, decay_ms: 40, sustain: 0.35, release_ms: 160 }, effects: { reverb: 0.3 },
      notes: [note(528, 0, 100, 0.7), note(528, 120, 140, 0.9)] } },
  { id: 'builtin:pomodoro_break', name: 'Break Start', category: 'earcon', loop: false,
    recipe: { waveform: 'sine', envelope: { attack_ms: 5, decay_ms: 40, sustain: 0.3, release_ms: 160 }, effects: { reverb: 0.3 },
      notes: [note(396, 0, 140, 0.8), note(528, 150, 160, 0.7)] } },
]

export const FALLBACK_ALARM_TONE = 'builtin:alarm_classic'

// ── Built-in sound packs (event → chime id, or null = silent) ─────────────────────
interface BuiltinPack { id: string; name: string; events: SoundEventMap }
export const BUILTIN_PACKS: BuiltinPack[] = [
  { id: 'builtin:none', name: 'None', events: {
    wake: null, endpoint: null, thinking: null, success: null, error: null, alarm: null, notification: null } },
  { id: 'builtin:minimal', name: 'Minimal', events: {
    wake: 'builtin:wake_bright', endpoint: null, thinking: null, success: null,
    error: 'builtin:error_soft', alarm: 'builtin:alarm_gentle', notification: 'builtin:notify' } },
  { id: 'builtin:chimes', name: 'Chimes', events: {
    wake: 'builtin:wake_bright', endpoint: 'builtin:endpoint', thinking: null, success: 'builtin:success',
    error: 'builtin:error_soft', alarm: 'builtin:alarm_gentle', notification: 'builtin:notify' } },
  { id: 'builtin:classic', name: 'Classic', events: {
    wake: 'builtin:classic_beep', endpoint: 'builtin:classic_beep', thinking: null, success: 'builtin:success',
    error: 'builtin:error_soft', alarm: 'builtin:alarm_classic', notification: 'builtin:classic_beep' } },
]

// ── Built-in templates (so a fresh screen device always has a sensible dashboard, and
// there are simple starters to duplicate) ──
// For now we ship a SINGLE dashboard: the native-LVGL Clock & Weather. The id keeps the
// `builtin:lvgl` prefix so rendererForTemplateId resolves it to the native renderer.
export const DEFAULT_TEMPLATE_ID = 'builtin:lvgl_clock_weather'
const BUILTIN_TEMPLATES = [
  {
    // The one shipped dashboard — drawn on-device in LVGL from this descriptor + a pushed
    // weather feed (animated sky, terrain, sun/moon, suggested-wear icons). No server JPEG.
    // The old JPEG starters (Clock / Weather / Clock+Weather / Cozy Dark) were collapsed
    // into this one for now; ensureBuiltins() prunes them and devices fall back here.
    id: DEFAULT_TEMPLATE_ID, name: 'Clock & Weather',
    theme: { bg: '#0B1020', bg2: '#241652', accent: '#818CF8', accent2: '#22D3EE', text: '#EEF2FF', font_scale: 1.0 } as ThemeTokens,
    widgets: [
      { type: 'clock', size: 'large', anchor: [0, 0] },
      { type: 'weather', size: 'medium', anchor: [0, 2], orient: 'vertical' },
    ] as WidgetPlacement[],
    soundPackId: 'builtin:chimes', volume: 0.7, alarmVolume: 1, alarmToneId: 'builtin:alarm_gentle',
  },
]

// ── Rendering chimes to disk ──────────────────────────────────────────────────────
async function exists(p: string): Promise<boolean> { try { await access(p); return true } catch { return false } }
export function wavPathFor(chimeId: string): string {
  return resolve(AUDIO_DIR, `${safeId(chimeId)}.wav`)
}
/** A chime id → on-disk/url-safe filename stem. */
export function safeId(id: string): string { return id.replace(/[^a-zA-Z0-9._-]/g, '_') }

/** Render a recipe to data/pod/audio/<id>.wav and return its sha256. */
export async function renderChimeToDisk(chimeId: string, recipe: ChimeRecipe): Promise<string> {
  await mkdir(AUDIO_DIR, { recursive: true })
  const wav = renderChimeWav(recipe)
  await writeFile(wavPathFor(chimeId), wav)
  return wavSha256(wav)
}

// ── Boot seeding ──────────────────────────────────────────────────────────────────
let seeded = false
export async function ensureBuiltins(): Promise<void> {
  if (seeded) return
  seeded = true
  try {
    await mkdir(AUDIO_DIR, { recursive: true })
    const now = new Date()

    for (const c of BUILTIN_CHIMES) {
      // (Re)render the WAV if missing; always keep the sha current in the row.
      const sha = (await exists(wavPathFor(c.id))) ? wavSha256(renderChimeWav(c.recipe)) : await renderChimeToDisk(c.id, c.recipe)
      const [row] = await db.select({ id: deviceChimes.id }).from(deviceChimes).where(eq(deviceChimes.id, c.id))
      if (row) {
        await db.update(deviceChimes).set({ name: c.name, category: c.category, loop: c.loop, recipe: JSON.stringify(c.recipe), wavSha: sha, builtin: true, updatedAt: now }).where(eq(deviceChimes.id, c.id))
      } else {
        await db.insert(deviceChimes).values({ id: c.id, name: c.name, category: c.category, loop: c.loop, recipe: JSON.stringify(c.recipe), wavSha: sha, builtin: true, createdAt: now, updatedAt: now })
      }
      if (!(await exists(wavPathFor(c.id)))) await renderChimeToDisk(c.id, c.recipe)
    }

    for (const p of BUILTIN_PACKS) {
      const [row] = await db.select({ id: deviceSoundPacks.id }).from(deviceSoundPacks).where(eq(deviceSoundPacks.id, p.id))
      if (row) await db.update(deviceSoundPacks).set({ name: p.name, events: JSON.stringify(p.events), builtin: true, updatedAt: now }).where(eq(deviceSoundPacks.id, p.id))
      else await db.insert(deviceSoundPacks).values({ id: p.id, name: p.name, events: JSON.stringify(p.events), builtin: true, createdAt: now, updatedAt: now })
    }

    for (const t of BUILTIN_TEMPLATES) {
      const [row] = await db.select({ id: deviceLayoutTemplates.id }).from(deviceLayoutTemplates).where(eq(deviceLayoutTemplates.id, t.id))
      const vals = { name: t.name, grid: '3x3', theme: JSON.stringify(t.theme), widgets: JSON.stringify(t.widgets), soundPackId: t.soundPackId, volume: t.volume, alarmVolume: t.alarmVolume, soundOverrides: '{}', alarmToneId: t.alarmToneId, builtin: true, updatedAt: now }
      if (row) await db.update(deviceLayoutTemplates).set(vals).where(eq(deviceLayoutTemplates.id, t.id))
      else await db.insert(deviceLayoutTemplates).values({ id: t.id, createdAt: now, ...vals })
    }
    // Prune built-in rows we no longer ship (e.g. a starter that was renamed/removed),
    // so a stale built-in doesn't linger. User-made (builtin=0) templates are untouched.
    const keepIds = BUILTIN_TEMPLATES.map((t) => t.id)
    await db.delete(deviceLayoutTemplates).where(and(eq(deviceLayoutTemplates.builtin, true), notInArray(deviceLayoutTemplates.id, keepIds)))
    logger.info('[pod] device studio built-ins ready (chimes/packs/templates)')
  } catch (e) {
    logger.warn(`[pod] ensureBuiltins failed: ${(e as Error).message}`)
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────────────
export async function listTemplates() { return db.select().from(deviceLayoutTemplates) }
export async function getTemplate(id: string) { const [r] = await db.select().from(deviceLayoutTemplates).where(eq(deviceLayoutTemplates.id, id)); return r ?? null }
export async function listPacks() { return db.select().from(deviceSoundPacks) }
export async function getPack(id: string) { const [r] = await db.select().from(deviceSoundPacks).where(eq(deviceSoundPacks.id, id)); return r ?? null }
export async function listChimes() { return db.select().from(deviceChimes) }
export async function getChime(id: string) { const [r] = await db.select().from(deviceChimes).where(eq(deviceChimes.id, id)); return r ?? null }

function parse<T>(s: string | null | undefined, fallback: T): T { try { return s ? JSON.parse(s) as T : fallback } catch { return fallback } }

// ── Descriptor resolution: the `layout` message a device receives ──────────────────
export interface LayoutDescriptor {
  type: 'layout'
  template_id: string
  // Native LVGL vs server-JPEG (see DisplayRenderer). The device switches its render
  // path on this: 'lvgl' → draw natively + hide the ambient blit; 'jpeg' → blit frames.
  renderer: DisplayRenderer
  theme: ThemeTokens
  widgets: WidgetPlacement[]
  sound_pack: {
    pack_id: string | null
    volume: number
    alarm_volume: number
    // Resolved event → audio URL (or null = silent). The device GETs/caches the URLs.
    events: Partial<Record<SoundEvent, string | null>>
  }
  alarm_tone: string | null   // resolved URL of the template default alarm tone
}

function audioUrl(chimeId: string | null | undefined): string | null {
  if (!chimeId) return null
  return `/api/pod/audio/${safeId(chimeId)}.wav`
}

/** Build the full descriptor for a device: its template (or the built-in default),
 *  with per-device theme/volume overrides applied, and event sounds resolved to URLs. */
export async function resolveDeviceDescriptor(deviceId: string): Promise<LayoutDescriptor | null> {
  const [dev] = await db.select().from(devices).where(eq(devices.id, deviceId))
  if (!dev) return null
  const tpl = (dev.layoutTemplateId ? await getTemplate(dev.layoutTemplateId) : null) ?? await getTemplate(DEFAULT_TEMPLATE_ID)
  if (!tpl) return null
  return descriptorFromTemplate(tpl, parse(dev.layoutOverrides, {} as { theme?: Partial<ThemeTokens>; volume?: number; alarmVolume?: number }))
}

export async function descriptorFromTemplate(
  tpl: typeof deviceLayoutTemplates.$inferSelect,
  overrides: { theme?: Partial<ThemeTokens>; volume?: number; alarmVolume?: number } = {},
): Promise<LayoutDescriptor> {
  const theme = { ...parse<ThemeTokens>(tpl.theme, { bg: '#0E0B1A', accent: '#7C3AED', text: '#EAEAF2', font_scale: 1 }), ...(overrides.theme ?? {}) }
  const widgets = parse<WidgetPlacement[]>(tpl.widgets, [])
  const packEvents = tpl.soundPackId ? parse<SoundEventMap>((await getPack(tpl.soundPackId))?.events ?? null, {}) : {}
  const ov = parse<SoundEventMap>(tpl.soundOverrides, {})
  const events: Partial<Record<SoundEvent, string | null>> = {}
  for (const ev of SOUND_EVENTS) {
    const chimeId = ev in ov ? ov[ev] : packEvents[ev] ?? null   // override → pack → silent
    events[ev] = audioUrl(chimeId)
  }
  return {
    type: 'layout', template_id: tpl.id, renderer: rendererForTemplateId(tpl.id), theme, widgets,
    sound_pack: {
      pack_id: tpl.soundPackId ?? null,
      volume: overrides.volume ?? tpl.volume,
      alarm_volume: overrides.alarmVolume ?? tpl.alarmVolume,
      events,
    },
    alarm_tone: audioUrl(tpl.alarmToneId),
  }
}

/** The asset-sync manifest for a template: every CUSTOM chime it references (built-in
 *  WAVs are assumed present in flash on the device). Files carry url + sha256. */
export async function assetSyncForTemplate(templateId: string, baseUrl: string): Promise<{ pack_id: string | null; files: Array<{ path: string; url: string; sha256: string }> }> {
  const tpl = await getTemplate(templateId)
  if (!tpl) return { pack_id: null, files: [] }
  const ids = new Set<string>()
  const packEvents = tpl.soundPackId ? parse<SoundEventMap>((await getPack(tpl.soundPackId))?.events ?? null, {}) : {}
  for (const ev of SOUND_EVENTS) { const id = packEvents[ev]; if (id) ids.add(id) }
  for (const id of Object.values(parse<SoundEventMap>(tpl.soundOverrides, {}))) if (id) ids.add(id)
  if (tpl.alarmToneId) ids.add(tpl.alarmToneId)
  const files: Array<{ path: string; url: string; sha256: string }> = []
  for (const id of ids) {
    if (id.startsWith('builtin:')) continue            // shipped in flash
    const ch = await getChime(id)
    if (!ch?.wavSha) continue
    files.push({ path: `${safeId(id)}.wav`, url: `${baseUrl}/api/pod/audio/${safeId(id)}.wav`, sha256: ch.wavSha })
  }
  return { pack_id: tpl.soundPackId ?? null, files }
}

/** Resolve an alarm's device tone (per-alarm → device template default → fallback) → URL. */
export async function resolveAlarmToneUrl(toneId: string | null | undefined, deviceId: string): Promise<string | null> {
  if (toneId) return audioUrl(toneId)
  const [dev] = await db.select().from(devices).where(eq(devices.id, deviceId))
  const tpl = (dev?.layoutTemplateId ? await getTemplate(dev.layoutTemplateId) : null) ?? await getTemplate(DEFAULT_TEMPLATE_ID)
  return audioUrl(tpl?.alarmToneId ?? FALLBACK_ALARM_TONE)
}
