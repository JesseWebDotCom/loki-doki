// Admin → Devices → Layouts / Sounds: the slot-based dashboard studio API.
//   GET/POST/PUT/DELETE /studio/templates          named layout templates
//   GET/POST/PUT/DELETE /studio/sound-packs        event → chime maps
//   GET/POST/PUT/DELETE /studio/chimes             synthesised chimes / alarm tones
//   POST              /studio/render               recipe → WAV bytes (browser preview)
//   PUT               /devices/:id/layout          assign a template (+ overrides) to a device
//   POST              /devices/:id/sound           play an earcon on a device (test)
//   GET               /audio/:file                 serve a rendered WAV (LAN-trust; devices fetch this)
//
// Mounted at /api/pod alongside routes/pod.ts (Hono merges same-prefix sub-apps).

import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { eq, or, isNull } from 'drizzle-orm'
import { requireAdmin, requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { db } from '@/db'
import { devices, deviceChimes, deviceSoundPacks, deviceLayoutTemplates, controllerLayoutTemplates, clockAlarms, users } from '@/db/schema'
import { layoutToDevice, soundToDevice, assetSyncToDevice, streamDeckToDevice } from '@/lib/pod/registry'
import { resolveControllerDescriptor } from '@/lib/pod/controllerStudio'
import { setNowPlaying, getNowPlaying, type NowPlaying } from '@/lib/pod/nowPlaying'
import { getServerHost } from '@/lib/pod/firmware'
import {
  AUDIO_DIR, DEFAULT_TEMPLATE_ID, safeId, validateWidgets, renderChimeToDisk,
  resolveDeviceDescriptor, assetSyncForTemplate, ensureBuiltins, getTemplate, descriptorFromTemplate,
  type WidgetPlacement, type ThemeTokens, type SoundEventMap,
} from '@/lib/pod/deviceStudio'
import { renderChimeWav, type ChimeRecipe } from '@/lib/pod/audioSynth'
import { logger } from '@/lib/logger'

const studio = new Hono<AppEnv>()

const now = () => new Date()
const uuid = () => crypto.randomUUID()

async function serverBaseUrl(): Promise<string> {
  const host = await getServerHost().catch(() => 'localhost')
  const port = process.env.PORT ?? '3000'
  return `http://${host}:${port}`
}

/** Re-resolve a device's descriptor and push it (with a custom-asset sync first) live. */
async function pushToDevice(deviceId: string): Promise<boolean> {
  const desc = await resolveDeviceDescriptor(deviceId)
  if (!desc) return false
  const base = await serverBaseUrl()
  const sync = await assetSyncForTemplate(desc.template_id, base)
  // Push the asset manifest first so any custom WAVs are on the SD card before they're
  // referenced (built-in tones ship in flash and never appear here).
  if (sync.files.length) assetSyncToDevice(deviceId, sync.pack_id, sync.files)
  return layoutToDevice(deviceId, desc as unknown as Record<string, unknown>)
}

/** Re-push to every device currently using a given template (or the default layout). */
async function repushTemplate(templateId: string): Promise<void> {
  const all = await db.select({ id: devices.id, tpl: devices.layoutTemplateId }).from(devices)
  for (const d of all) {
    const effective = d.tpl ?? DEFAULT_TEMPLATE_ID
    if (effective === templateId) await pushToDevice(d.id)
  }
}

// ── Templates ──────────────────────────────────────────────────────────────────
studio.get('/studio/templates', requireAdmin, async (c) => {
  await ensureBuiltins()
  return c.json(await db.select().from(deviceLayoutTemplates))
})

studio.post('/studio/templates', requireAdmin, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Partial<TemplateBody>
  const err = validateTemplate(b)
  if (err) return c.json({ error: err }, 400)
  const id = uuid()
  const ts = now()
  await db.insert(deviceLayoutTemplates).values({
    id, name: b.name!.trim(), grid: '3x3',
    theme: JSON.stringify(b.theme ?? {}), widgets: JSON.stringify(b.widgets ?? []),
    soundPackId: b.soundPackId ?? null, volume: clamp01(b.volume, 0.7), alarmVolume: clamp01(b.alarmVolume, 1),
    soundOverrides: JSON.stringify(b.soundOverrides ?? {}), alarmToneId: b.alarmToneId ?? null,
    builtin: false, createdAt: ts, updatedAt: ts,
  })
  return c.json({ id })
})

studio.put('/studio/templates/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(deviceLayoutTemplates).where(eq(deviceLayoutTemplates.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  const b = (await c.req.json().catch(() => ({}))) as Partial<TemplateBody>
  const err = validateTemplate(b)
  if (err) return c.json({ error: err }, 400)
  const vals = {
    name: b.name!.trim(), theme: JSON.stringify(b.theme ?? {}), widgets: JSON.stringify(b.widgets ?? []),
    soundPackId: b.soundPackId ?? null, volume: clamp01(b.volume, 0.7), alarmVolume: clamp01(b.alarmVolume, 1),
    soundOverrides: JSON.stringify(b.soundOverrides ?? {}), alarmToneId: b.alarmToneId ?? null,
  }
  if (row.builtin) {
    // Built-ins are read-only, so editing one FORKS it into a custom copy and moves the
    // devices that were showing the built-in onto the copy — so "edit the layout my
    // device uses → my device changes" actually works (no separate duplicate+assign).
    const newId = uuid(); const ts = now()
    await db.insert(deviceLayoutTemplates).values({ id: newId, grid: '3x3', builtin: false, createdAt: ts, updatedAt: ts, ...vals })
    // Devices explicitly on this built-in — plus, if it's the default, those with none.
    const where = id === DEFAULT_TEMPLATE_ID
      ? or(eq(devices.layoutTemplateId, id), isNull(devices.layoutTemplateId))
      : eq(devices.layoutTemplateId, id)
    const affected = await db.select({ id: devices.id }).from(devices).where(where)
    await db.update(devices).set({ layoutTemplateId: newId }).where(where)
    for (const d of affected) await pushToDevice(d.id)
    return c.json({ ok: true, id: newId, forked: true })
  }
  await db.update(deviceLayoutTemplates).set({ ...vals, updatedAt: now() }).where(eq(deviceLayoutTemplates.id, id))
  await repushTemplate(id)
  return c.json({ ok: true })
})

studio.delete('/studio/templates/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(deviceLayoutTemplates).where(eq(deviceLayoutTemplates.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.builtin) return c.json({ error: 'cannot delete a built-in template' }, 400)
  // Devices assigned to it fall back to the default layout.
  await db.update(devices).set({ layoutTemplateId: null }).where(eq(devices.layoutTemplateId, id))
  await db.delete(deviceLayoutTemplates).where(eq(deviceLayoutTemplates.id, id))
  return c.json({ ok: true })
})

// ── Sound packs ──────────────────────────────────────────────────────────────────
studio.get('/studio/sound-packs', requireAdmin, async (c) => {
  await ensureBuiltins()
  return c.json(await db.select().from(deviceSoundPacks))
})

studio.post('/studio/sound-packs', requireAdmin, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { name?: string; events?: SoundEventMap }
  if (!b.name?.trim()) return c.json({ error: 'name is required' }, 400)
  const id = uuid(); const ts = now()
  await db.insert(deviceSoundPacks).values({ id, name: b.name.trim(), events: JSON.stringify(b.events ?? {}), builtin: false, createdAt: ts, updatedAt: ts })
  return c.json({ id })
})

studio.put('/studio/sound-packs/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(deviceSoundPacks).where(eq(deviceSoundPacks.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.builtin) return c.json({ error: 'built-in packs cannot be edited — duplicate it first' }, 400)
  const b = (await c.req.json().catch(() => ({}))) as { name?: string; events?: SoundEventMap }
  await db.update(deviceSoundPacks).set({ name: b.name?.trim() || row.name, events: JSON.stringify(b.events ?? {}), updatedAt: now() }).where(eq(deviceSoundPacks.id, id))
  // Re-push templates that use this pack.
  const tpls = await db.select({ id: deviceLayoutTemplates.id }).from(deviceLayoutTemplates).where(eq(deviceLayoutTemplates.soundPackId, id))
  for (const t of tpls) await repushTemplate(t.id)
  return c.json({ ok: true })
})

studio.delete('/studio/sound-packs/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(deviceSoundPacks).where(eq(deviceSoundPacks.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.builtin) return c.json({ error: 'cannot delete a built-in pack' }, 400)
  await db.update(deviceLayoutTemplates).set({ soundPackId: null }).where(eq(deviceLayoutTemplates.soundPackId, id))
  await db.delete(deviceSoundPacks).where(eq(deviceSoundPacks.id, id))
  return c.json({ ok: true })
})

// ── Chimes / alarm tones ──────────────────────────────────────────────────────────
studio.get('/studio/chimes', requireAdmin, async (c) => {
  await ensureBuiltins()
  return c.json(await db.select().from(deviceChimes))
})

studio.post('/studio/chimes', requireAdmin, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { name?: string; category?: 'earcon' | 'alarm'; loop?: boolean; recipe?: ChimeRecipe }
  if (!b.name?.trim()) return c.json({ error: 'name is required' }, 400)
  const id = uuid(); const ts = now()
  const recipe = b.recipe ?? {}
  const loop = b.category === 'alarm' ? true : !!b.loop
  const sha = await renderChimeToDisk(id, recipe).catch((e) => { logger.warn(`[pod] chime render failed: ${(e as Error).message}`); return null })
  await db.insert(deviceChimes).values({ id, name: b.name.trim(), category: b.category ?? 'earcon', loop, recipe: JSON.stringify(recipe), wavSha: sha, builtin: false, createdAt: ts, updatedAt: ts })
  return c.json({ id })
})

studio.put('/studio/chimes/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(deviceChimes).where(eq(deviceChimes.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.builtin) return c.json({ error: 'built-in chimes cannot be edited — duplicate it first' }, 400)
  const b = (await c.req.json().catch(() => ({}))) as { name?: string; category?: 'earcon' | 'alarm'; loop?: boolean; recipe?: ChimeRecipe }
  const recipe = b.recipe ?? (JSON.parse(row.recipe) as ChimeRecipe)
  const category = b.category ?? row.category
  const loop = category === 'alarm' ? true : (b.loop ?? row.loop)
  const sha = await renderChimeToDisk(id, recipe).catch(() => row.wavSha)
  await db.update(deviceChimes).set({ name: b.name?.trim() || row.name, category, loop, recipe: JSON.stringify(recipe), wavSha: sha, updatedAt: now() }).where(eq(deviceChimes.id, id))
  return c.json({ ok: true })
})

studio.delete('/studio/chimes/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(deviceChimes).where(eq(deviceChimes.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.builtin) return c.json({ error: 'cannot delete a built-in chime' }, 400)
  await db.delete(deviceChimes).where(eq(deviceChimes.id, id))
  return c.json({ ok: true })
})

// Render an ad-hoc recipe to WAV bytes for instant browser preview (no row created).
studio.post('/studio/render', requireAdmin, async (c) => {
  const recipe = (await c.req.json().catch(() => ({}))) as ChimeRecipe
  try {
    const wav = renderChimeWav(recipe)
    return new Response(new Uint8Array(wav), { status: 200, headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

// ── Device assignment ──────────────────────────────────────────────────────────────
studio.put('/devices/:id/layout', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const [dev] = await db.select().from(devices).where(eq(devices.id, id))
  if (!dev) return c.json({ error: 'device not found' }, 404)
  const b = (await c.req.json().catch(() => ({}))) as { templateId?: string | null; overrides?: unknown }
  // Validate the template exists (null → built-in default layout).
  if (b.templateId) {
    const [t] = await db.select({ id: deviceLayoutTemplates.id }).from(deviceLayoutTemplates).where(eq(deviceLayoutTemplates.id, b.templateId))
    if (!t) return c.json({ error: 'unknown template' }, 400)
  }
  await db.update(devices).set({
    layoutTemplateId: b.templateId ?? null,
    layoutOverrides: b.overrides ? JSON.stringify(b.overrides) : null,
  }).where(eq(devices.id, id))
  const online = await pushToDevice(id)
  return c.json({ ok: true, online })
})

// Resolved descriptor for a device (drives the admin device-accurate preview).
studio.get('/devices/:id/descriptor', requireAdmin, async (c) => {
  const desc = await resolveDeviceDescriptor(c.req.param('id'))
  return desc ? c.json(desc) : c.json({ error: 'device not found' }, 404)
})

// Session-authed descriptor for the /display page (the ambient screen renderer). The
// headless display render is logged in as the device's bound user, so this is the path
// the live slot-based display uses. `?deviceId=` selects that device's assigned layout
// (ownership-checked); omitted → the built-in default layout. Unifies the old per-user
// "Home screen" config into the one Layouts system.
studio.get('/display-layout', requireAuth, async (c) => {
  const user = c.get('user')
  const deviceId = c.req.query('deviceId')
  if (deviceId) {
    const [dev] = await db.select().from(devices).where(eq(devices.id, deviceId))
    if (dev && (dev.userId === user.id || user.role === 'admin')) {
      const desc = await resolveDeviceDescriptor(deviceId)
      if (desc) return c.json(desc)
    }
  } else {
    // No explicit device (e.g. opening /display in a browser to check it): show the
    // requesting user's own device layout so it reflects what's assigned — not just the
    // global default. Prefer a SCREEN device (tablet/show, e.g. the Tab5) with a layout,
    // since screenless pods (Atom Echo) don't render a layout anyway.
    const mine = await db.select().from(devices).where(eq(devices.userId, user.id))
    const isScreen = (d: typeof devices.$inferSelect) =>
      ['tablet', 'show'].includes(d.kind) || /tab5|show|tablet/i.test(d.model ?? '') || /"screen"\s*:\s*true/.test(d.capabilities ?? '')
    const pick =
      mine.find((d) => isScreen(d) && d.layoutTemplateId) ??
      mine.find((d) => isScreen(d)) ??
      mine.find((d) => d.layoutTemplateId) ?? mine[0]
    if (pick) {
      const desc = await resolveDeviceDescriptor(pick.id)
      if (desc) return c.json(desc)
    }
  }
  // Fallback: the built-in default layout (so /display always shows something).
  const tpl = await getTemplate(DEFAULT_TEMPLATE_ID)
  if (!tpl) return c.json({ error: 'no default layout' }, 404)
  return c.json(await descriptorFromTemplate(tpl))
})

// Resolved controller (button-grid) layout for the server-rendered controller page —
// the parallel of /display-layout. /display renders this when ?view=controller. Returns
// the active page's buttons (with live artwork) plus the device's theme for consistency.
studio.get('/controller-layout', requireAuth, async (c) => {
  const user = c.get('user')
  const deviceId = c.req.query('deviceId')
  let dev: typeof devices.$inferSelect | null = null
  if (deviceId) {
    const [d] = await db.select().from(devices).where(eq(devices.id, deviceId))
    if (d && (d.userId === user.id || user.role === 'admin')) dev = d
  } else {
    const mine = await db.select().from(devices).where(eq(devices.userId, user.id))
    const isScreen = (d: typeof devices.$inferSelect) =>
      ['tablet', 'show'].includes(d.kind) || /tab5|show|tablet/i.test(d.model ?? '')
    dev = mine.find(isScreen) ?? mine[0] ?? null
  }
  const uid = dev?.userId ?? user.id
  const payload = await resolveControllerDescriptor(dev?.id ?? '', uid)
  let theme: unknown = undefined
  if (dev) theme = (await resolveDeviceDescriptor(dev.id))?.theme
  return c.json({ pages: payload.pages, theme })
})

// Now-playing: the browser's radio player POSTs its state here; the controller surface
// (and the device, rendered in a separate tab) GETs it to show the active station,
// play/pause state, and progress.
studio.post('/now-playing', requireAuth, async (c) => {
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as Partial<NowPlaying>
  setNowPlaying(user.id, {
    stationId: typeof b.stationId === 'string' ? b.stationId : null,
    videoId: typeof b.videoId === 'string' ? b.videoId : null,
    title: typeof b.title === 'string' ? b.title : '',
    artist: typeof b.artist === 'string' ? b.artist : null,
    cover: typeof b.cover === 'string' ? b.cover : '',
    positionSec: Number(b.positionSec) || 0,
    durationSec: Number(b.durationSec) || 0,
    playing: !!b.playing,
  })
  return c.json({ ok: true })
})

studio.get('/now-playing', requireAuth, async (c) => {
  const user = c.get('user')
  const deviceId = c.req.query('deviceId')
  let uid = user.id
  if (deviceId) {
    const [dev] = await db.select().from(devices).where(eq(devices.id, deviceId))
    if (dev && (dev.userId === user.id || user.role === 'admin')) uid = dev.userId
  }
  return c.json(getNowPlaying(uid) ?? { stationId: null, videoId: null, title: '', artist: null, cover: '', positionSec: 0, durationSec: 0, playing: false })
})

// Play an earcon on a device now (admin test of the sound path).
studio.post('/devices/:id/sound', requireAdmin, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { event?: string }
  const ok = soundToDevice(c.req.param('id'), b.event || 'notification')
  return ok ? c.json({ ok: true }) : c.json({ error: 'device is not connected' }, 409)
})

// ── Controller layout templates (Stream Deck / button-grid mode) ──────────────────────
// Parallel to the display-side layout templates above. Three built-in templates ship as
// synthetic entries (no DB row). Custom templates persist to controller_layout_templates.

const BUILTIN_CONTROLLER_ENTRIES = [
  { id: 'builtin:blank',            name: 'Blank',            builtin: true, gridRows: 3, gridCols: 5 },
  { id: 'builtin:youtube-channels', name: 'YouTube Channels', builtin: true, gridRows: 3, gridCols: 5 },
  { id: 'builtin:music',            name: 'Music',            builtin: true, gridRows: 3, gridCols: 5 },
]

studio.get('/studio/controller-templates', requireAdmin, async (c) => {
  const custom = await db.select().from(controllerLayoutTemplates)
  return c.json([...BUILTIN_CONTROLLER_ENTRIES, ...custom])
})

studio.post('/studio/controller-templates', requireAdmin, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { name?: string; gridRows?: number; gridCols?: number; pagesJson?: string }
  if (!b.name?.trim()) return c.json({ error: 'name is required' }, 400)
  const id = uuid(); const ts = now()
  await db.insert(controllerLayoutTemplates).values({
    id, name: b.name.trim(), builtin: false,
    gridRows: clampInt(b.gridRows ?? 3, 1, 8), gridCols: clampInt(b.gridCols ?? 5, 1, 8),
    pagesJson: b.pagesJson ?? '[]',
    createdAt: ts, updatedAt: ts,
  })
  return c.json({ id })
})

studio.patch('/studio/controller-templates/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  // Built-in templates are resolved dynamically — they cannot be stored or edited.
  if (id.startsWith('builtin:')) return c.json({ error: 'built-in controller templates cannot be edited' }, 400)
  const [row] = await db.select().from(controllerLayoutTemplates).where(eq(controllerLayoutTemplates.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  const b = (await c.req.json().catch(() => ({}))) as { name?: string; gridRows?: number; gridCols?: number; pagesJson?: string }
  await db.update(controllerLayoutTemplates).set({
    name: b.name?.trim() || row.name,
    gridRows: b.gridRows != null ? clampInt(b.gridRows, 1, 8) : row.gridRows,
    gridCols: b.gridCols != null ? clampInt(b.gridCols, 1, 8) : row.gridCols,
    pagesJson: b.pagesJson ?? row.pagesJson,
    updatedAt: now(),
  }).where(eq(controllerLayoutTemplates.id, id))
  return c.json({ ok: true })
})

studio.delete('/studio/controller-templates/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  if (id.startsWith('builtin:')) return c.json({ error: 'cannot delete a built-in controller template' }, 400)
  const [row] = await db.select().from(controllerLayoutTemplates).where(eq(controllerLayoutTemplates.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  // Devices assigned to this template fall back to builtin:blank.
  await db.update(devices).set({ controllerLayoutTemplateId: null }).where(eq(devices.controllerLayoutTemplateId, id))
  await db.delete(controllerLayoutTemplates).where(eq(controllerLayoutTemplates.id, id))
  return c.json({ ok: true })
})

// Assign a controller layout template to a device (and optional per-device button overrides).
// Resolves and pushes the new layout live if the device is connected.
studio.post('/devices/:id/controller-layout', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const [dev] = await db.select().from(devices).where(eq(devices.id, id))
  if (!dev) return c.json({ error: 'device not found' }, 404)
  const b = (await c.req.json().catch(() => ({}))) as { templateId?: string | null; overrides?: unknown }
  // Validate a custom template exists (null / builtin: → no row needed).
  if (b.templateId && !b.templateId.startsWith('builtin:')) {
    const [t] = await db.select({ id: controllerLayoutTemplates.id }).from(controllerLayoutTemplates).where(eq(controllerLayoutTemplates.id, b.templateId))
    if (!t) return c.json({ error: 'unknown controller template' }, 400)
  }
  await db.update(devices).set({
    controllerLayoutTemplateId: b.templateId ?? null,
    controllerLayoutOverrides: b.overrides ? JSON.stringify(b.overrides) : null,
  }).where(eq(devices.id, id))
  // Re-resolve and push live.
  let online = false
  try {
    const cfg = await resolveControllerDescriptor(id, dev.userId)
    online = streamDeckToDevice(id, cfg)
  } catch (e) {
    logger.warn(`[controller-studio] push failed for device ${id}: ${(e as Error).message}`)
  }
  return c.json({ ok: true, online })
})

// ── Centralised alarms (server-owned; targets devices, picks a device tone) ─────────
// The per-user Time app keeps using /api/time/alarms; this is the cross-device admin
// view that adds device `targets` + a `toneId` from the chime library. Both read/write
// the same clock_alarms table, so an alarm authored here also shows in the Time app.
studio.get('/studio/alarms', requireAdmin, async (c) => {
  const rows = await db.select().from(clockAlarms)
  const us = await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, nickname: users.nickname }).from(users)
  const nameOf = (id: string) => { const u = us.find((x) => x.id === id); return u ? (u.nickname?.trim() || `${u.firstName} ${u.lastName}`.trim()) : id }
  return c.json(rows.map((a) => ({
    id: a.id, userId: a.userId, userName: nameOf(a.userId), label: a.label, hour: a.hour, minute: a.minute,
    repeatDays: safeJson(a.repeatDays, [] as number[]), enabled: a.enabled,
    toneId: a.toneId, toneName: a.toneName, targets: safeJson(a.targets, null as string[] | null),
    announce: a.announce, snoozeMinutes: a.snoozeMinutes,
  })))
})

studio.post('/studio/alarms', requireAdmin, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Partial<AlarmBody> & { userId?: string }
  if (typeof b.hour !== 'number' || typeof b.minute !== 'number') return c.json({ error: 'hour and minute are required' }, 400)
  // Owner = explicit userId, else the owner of the first target device, else the admin.
  let userId = b.userId
  if (!userId && b.targets?.length) userId = (await db.select({ userId: devices.userId }).from(devices).where(eq(devices.id, b.targets[0]!)))[0]?.userId
  if (!userId) userId = c.get('user')?.id
  if (!userId) return c.json({ error: 'could not resolve an owning user' }, 400)
  const id = uuid(); const ts = now()
  await db.insert(clockAlarms).values({
    id, userId, label: b.label?.trim() || 'Alarm', hour: clampInt(b.hour, 0, 23), minute: clampInt(b.minute, 0, 59),
    repeatDays: JSON.stringify(b.repeatDays ?? []), enabled: b.enabled ?? true,
    tone: 'builtin:radar', toneId: b.toneId ?? null, toneName: b.toneName ?? null,
    targets: b.targets?.length ? JSON.stringify(b.targets) : null,
    announce: b.announce ?? true, snoozeMinutes: clampInt(b.snoozeMinutes ?? 9, 1, 60), createdAt: ts, updatedAt: ts,
  })
  return c.json({ id })
})

studio.put('/studio/alarms/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(clockAlarms).where(eq(clockAlarms.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  const b = (await c.req.json().catch(() => ({}))) as Partial<AlarmBody>
  await db.update(clockAlarms).set({
    label: b.label?.trim() || row.label,
    hour: b.hour != null ? clampInt(b.hour, 0, 23) : row.hour,
    minute: b.minute != null ? clampInt(b.minute, 0, 59) : row.minute,
    repeatDays: b.repeatDays ? JSON.stringify(b.repeatDays) : row.repeatDays,
    enabled: b.enabled ?? row.enabled,
    toneId: b.toneId === undefined ? row.toneId : b.toneId,
    toneName: b.toneName === undefined ? row.toneName : b.toneName,
    targets: b.targets === undefined ? row.targets : (b.targets?.length ? JSON.stringify(b.targets) : null),
    announce: b.announce ?? row.announce,
    snoozeMinutes: b.snoozeMinutes != null ? clampInt(b.snoozeMinutes, 1, 60) : row.snoozeMinutes,
    updatedAt: now(),
  }).where(eq(clockAlarms.id, id))
  return c.json({ ok: true })
})

studio.delete('/studio/alarms/:id', requireAdmin, async (c) => {
  await db.delete(clockAlarms).where(eq(clockAlarms.id, c.req.param('id')))
  return c.json({ ok: true })
})

// ── Serve rendered WAVs (LAN-trust like /display; devices + browser preview fetch this) ──
studio.get('/audio/:file', async (c) => {
  const file = c.req.param('file')
  // Only allow our generated <safeId>.wav names — no traversal.
  const m = /^([a-zA-Z0-9._-]+)\.wav$/.exec(file)
  if (!m) return c.json({ error: 'not found' }, 404)
  const path = resolve(AUDIO_DIR, `${safeId(m[1]!)}.wav`)
  try {
    const buf = await readFile(path)
    return new Response(new Uint8Array(buf), { status: 200, headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'public, max-age=86400' } })
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

// ── helpers ────────────────────────────────────────────────────────────────────────
interface TemplateBody {
  name: string; theme: Partial<ThemeTokens>; widgets: WidgetPlacement[]
  soundPackId: string | null; volume: number; alarmVolume: number
  soundOverrides: SoundEventMap; alarmToneId: string | null
}
function validateTemplate(b: Partial<TemplateBody>): string | null {
  if (!b.name?.trim()) return 'name is required'
  if (!Array.isArray(b.widgets)) return 'widgets must be an array'
  return validateWidgets(b.widgets as WidgetPlacement[])
}
function clamp01(v: number | undefined, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt
  return v < 0 ? 0 : v > 1 ? 1 : v
}
function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(Number(v))
  return !Number.isFinite(n) ? lo : n < lo ? lo : n > hi ? hi : n
}
function safeJson<T>(s: string | null, fallback: T): T { try { return s ? JSON.parse(s) as T : fallback } catch { return fallback } }

interface AlarmBody {
  label: string; hour: number; minute: number; repeatDays: number[]; enabled: boolean
  toneId: string | null; toneName: string | null; targets: string[]; announce: boolean; snoozeMinutes: number
}

export { studio }
