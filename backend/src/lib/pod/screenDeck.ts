// Unified screen deck — the shared per-device ordered list of "screens" a Pod swipes
// between. Collapses what used to be four separate concepts (display layout template,
// controller layout template, LVGL screen-mode, display content-mode) into one model:
//
//   `screens`        — a small catalog of NEW singleton screen kinds that don't already
//                       have their own template system (digital-clock, analog-clock,
//                       big-weather, nightstand, activity, status, sleeping).
//   `device_screens` — the ordered deck itself. One row = one screen instance in the
//                       swipe order. Both Admin → Devices and the new Settings → Devices
//                       page mutate the SAME rows (no separate per-user override table —
//                       see the schema.ts comment above `screens`).
//
// Two existing, still-independent systems are REUSED rather than duplicated for the two
// kinds that already had rich template CRUD before this file existed:
//   - kind 'clock-weather' → screenId is a `device_layout_templates.id` (deviceStudio.ts)
//   - kind 'controller'    → screenId is a controller template id (controllerStudio.ts:
//                            'builtin:default'|'builtin:blank'|'builtin:youtube-channels'|
//                            'builtin:music', or a custom `controller_layout_templates.id`)
//
// After every deck mutation, `syncLegacyFields()` writes the deck's PRIMARY (first enabled,
// in position order) clock-weather/controller/content-state screen back onto the existing
// `devices.layoutTemplateId` / `controllerLayoutTemplateId` / `controllerLayoutOverrides` /
// `displayMode` columns — so the entire existing push/resolve/render pipeline
// (deviceStudio.resolveDeviceDescriptor, controllerStudio.resolveControllerDescriptor,
// displayController.setPodView, rendererForTemplateId gating in cameraUdp/displayData/
// routes/pod.ts) keeps working completely unchanged. The deck is additive: it can hold
// MORE screens than the legacy single-slot columns track (e.g. an analog-clock or a second
// controller page) — those become fully swipeable once the firmware deck_index work lands
// (see plans; tracked separately), but are already visible/editable here today.

import { eq, and, asc, notInArray, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { devices, screens, deviceScreens, deviceLayoutTemplates, controllerLayoutTemplates } from '@/db/schema'
import { logger } from '@/lib/logger'
import { DEFAULT_TEMPLATE_ID, rendererForTemplateId } from '@/lib/pod/deviceStudio'
import { BUILTIN_CONTROLLER_TEMPLATES } from '@/lib/pod/controllerStudio'
import { setPodView, type DeviceDisplayMode } from '@/lib/pod/displayController'

// ── Screen kinds ─────────────────────────────────────────────────────────────────
export const DISPLAY_KINDS = ['clock-weather', 'digital-clock', 'analog-clock', 'big-weather', 'nightstand'] as const
export const CONTENT_KINDS = ['activity', 'status', 'sleeping'] as const
export const CONTROLLER_KIND = 'controller' as const
export type ScreenKind = (typeof DISPLAY_KINDS)[number] | (typeof CONTENT_KINDS)[number] | typeof CONTROLLER_KIND

/** Kinds whose device rendering already exists in firmware today. Anything else in the
 *  deck is fully manageable here but won't actually show on hardware until the firmware
 *  deck work lands (surfaced to the UI so it can label them "firmware pending"). */
export const FIRMWARE_READY_KINDS = new Set<string>(['clock-weather', 'controller', 'activity', 'status', 'sleeping'])

interface ScreenCatalogEntry { id: string; kind: ScreenKind; name: string; renderer: 'lvgl' | 'jpeg'; params?: Record<string, unknown> }

// Only the NEW singleton kinds get a `screens` catalog row — 'clock-weather' and
// 'controller' reuse the existing, richer template systems (see file header).
const BUILTIN_SCREENS: ScreenCatalogEntry[] = [
  { id: 'builtin:digital-clock', kind: 'digital-clock', name: 'Digital Clock', renderer: 'lvgl' },
  { id: 'builtin:analog-clock', kind: 'analog-clock', name: 'Analog Clock', renderer: 'lvgl' },
  { id: 'builtin:big-weather', kind: 'big-weather', name: 'Big Weather', renderer: 'lvgl' },
  { id: 'builtin:nightstand', kind: 'nightstand', name: 'Nightstand', renderer: 'lvgl' },
  { id: 'builtin:activity', kind: 'activity', name: 'Now Playing', renderer: 'jpeg' },
  { id: 'builtin:status', kind: 'status', name: 'Status', renderer: 'jpeg', params: { label: 'Busy', color: '#dc2626' } },
  { id: 'builtin:sleeping', kind: 'sleeping', name: 'Sleeping', renderer: 'jpeg' },
]

const now = () => new Date()
const uuid = () => crypto.randomUUID()
function parse<T>(s: string | null | undefined, fallback: T): T { try { return s ? JSON.parse(s) as T : fallback } catch { return fallback } }

// ── Boot seeding ───────────────────────────────────────────────────────────────────
let screensSeeded = false
export async function ensureBuiltinScreens(): Promise<void> {
  if (screensSeeded) return
  screensSeeded = true
  try {
    const nowTs = now()
    for (const s of BUILTIN_SCREENS) {
      const [row] = await db.select({ id: screens.id }).from(screens).where(eq(screens.id, s.id))
      const vals = { kind: s.kind, name: s.name, renderer: s.renderer, params: JSON.stringify(s.params ?? {}), builtin: true, updatedAt: nowTs }
      if (row) await db.update(screens).set(vals).where(eq(screens.id, s.id))
      else await db.insert(screens).values({ id: s.id, createdAt: nowTs, ...vals })
    }
    // Prune built-ins we no longer ship; custom (builtin=0) rows are untouched.
    const keepIds = BUILTIN_SCREENS.map((s) => s.id)
    await db.delete(screens).where(and(eq(screens.builtin, true), notInArray(screens.id, keepIds)))
  } catch (e) {
    logger.warn(`[screen-deck] ensureBuiltinScreens failed: ${(e as Error).message}`)
  }
}

/** One-time backfill: give every device with an empty deck a deck built from its current
 *  legacy layout/controller assignment, and carry the old template's audio bundle onto the
 *  new device-level sound/alarm columns. Guarded per-device (skips any device that already
 *  has 1-or-more device_screens rows), so it never clobbers an admin/owner edit and is safe
 *  to call on every boot. Call AFTER ensureBuiltinScreens() + deviceStudio.ensureBuiltins(). */
export async function seedDeviceDecks(): Promise<void> {
  try {
    const all = await db.select().from(devices)
    for (const dev of all) {
      const existing = await db.select({ id: deviceScreens.id }).from(deviceScreens).where(eq(deviceScreens.deviceId, dev.id)).limit(1)
      if (existing.length) continue

      const nowTs = now()
      const displayTemplateId = dev.layoutTemplateId ?? DEFAULT_TEMPLATE_ID
      const layoutOverrides = parse<{ theme?: unknown; volume?: number; alarmVolume?: number }>(dev.layoutOverrides, {})
      await db.insert(deviceScreens).values({
        id: uuid(), deviceId: dev.id, position: 0, screenId: displayTemplateId, kind: 'clock-weather',
        params: JSON.stringify(layoutOverrides.theme ? { theme: layoutOverrides.theme } : {}),
        enabled: true, createdAt: nowTs, updatedAt: nowTs,
      })
      const controllerTemplateId = dev.controllerLayoutTemplateId ?? 'builtin:default'
      const buttonOverrides = parse(dev.controllerLayoutOverrides, [] as unknown[])
      await db.insert(deviceScreens).values({
        id: uuid(), deviceId: dev.id, position: 1, screenId: controllerTemplateId, kind: 'controller',
        params: JSON.stringify(buttonOverrides.length ? { buttonOverrides } : {}),
        enabled: true, createdAt: nowTs, updatedAt: nowTs,
      })

      // Carry the display template's audio/alarm bundle onto the device (device-global now).
      if (dev.soundPackId == null && dev.alarmToneId == null) {
        const [tpl] = await db.select().from(deviceLayoutTemplates).where(eq(deviceLayoutTemplates.id, displayTemplateId))
        if (tpl) {
          await db.update(devices).set({
            soundPackId: tpl.soundPackId, soundVolume: layoutOverrides.volume ?? tpl.volume,
            alarmVolume: layoutOverrides.alarmVolume ?? tpl.alarmVolume,
            soundOverrides: tpl.soundOverrides, alarmToneId: tpl.alarmToneId,
          }).where(eq(devices.id, dev.id))
        }
      }
    }
    logger.info('[screen-deck] device decks seeded')
  } catch (e) {
    logger.warn(`[screen-deck] seedDeviceDecks failed: ${(e as Error).message}`)
  }
}

// ── Legacy sync — keeps the existing push/resolve/render pipeline working unchanged ──
async function syncLegacyFields(deviceId: string): Promise<void> {
  const deck = await db.select().from(deviceScreens)
    .where(and(eq(deviceScreens.deviceId, deviceId), eq(deviceScreens.enabled, true)))
    .orderBy(asc(deviceScreens.position))

  const display = deck.find((r) => r.kind === 'clock-weather')
  if (display?.screenId) {
    const params = parse<{ theme?: unknown }>(display.params, {})
    await db.update(devices).set({
      layoutTemplateId: display.screenId,
      layoutOverrides: params.theme ? JSON.stringify({ theme: params.theme }) : null,
    }).where(eq(devices.id, deviceId))
  }

  const controller = deck.find((r) => r.kind === 'controller')
  if (controller?.screenId) {
    const params = parse<{ buttonOverrides?: unknown[] }>(controller.params, {})
    await db.update(devices).set({
      controllerLayoutTemplateId: controller.screenId,
      controllerLayoutOverrides: params.buttonOverrides?.length ? JSON.stringify(params.buttonOverrides) : null,
    }).where(eq(devices.id, deviceId))
  }

  // If the deck's PRIMARY slot (position 0 overall) is a content-state screen, that's the
  // device's baseline pod-view (e.g. a device dedicated to a status/BUSY screen). Otherwise
  // make sure it's back to the ambient default — the live presence system can still layer
  // transient activity/status/sleeping/alert on top at runtime (unaffected by this).
  const primary = deck[0]
  const contentKind = primary && (CONTENT_KINDS as readonly string[]).includes(primary.kind) ? (primary.kind as DeviceDisplayMode) : 'display'
  await setPodView(deviceId, contentKind)
}

// ── Reads ──────────────────────────────────────────────────────────────────────────

/** The device's deck, ordered. */
export async function listDeck(deviceId: string) {
  return db.select().from(deviceScreens).where(eq(deviceScreens.deviceId, deviceId)).orderBy(asc(deviceScreens.position))
}

/** Flat catalog of everything that can be ADDED to a deck, across all three sources
 *  (display templates, controller templates, singleton screen kinds) — one list for the
 *  "add a screen" picker in both the admin and settings editors. */
export async function listAvailableScreens() {
  const displayTemplates = await db.select().from(deviceLayoutTemplates)
  const controllerCustom = await db.select().from(controllerLayoutTemplates)
  await ensureBuiltinScreens()
  const singleton = await db.select().from(screens)

  const out: Array<{ screenId: string; kind: ScreenKind; name: string; renderer: 'lvgl' | 'jpeg'; builtin: boolean }> = []
  for (const t of displayTemplates) out.push({ screenId: t.id, kind: 'clock-weather', name: t.name, renderer: rendererForTemplateId(t.id), builtin: t.builtin })
  const controllerNames: Record<string, string> = { 'builtin:default': 'Default Dashboard', 'builtin:blank': 'Blank', 'builtin:youtube-channels': 'YouTube Channels', 'builtin:music': 'Music' }
  for (const id of BUILTIN_CONTROLLER_TEMPLATES) out.push({ screenId: id, kind: 'controller', name: controllerNames[id] ?? id, renderer: 'lvgl', builtin: true })
  for (const t of controllerCustom) out.push({ screenId: t.id, kind: 'controller', name: t.name, renderer: 'lvgl', builtin: false })
  for (const s of singleton) out.push({ screenId: s.id, kind: s.kind as ScreenKind, name: s.name, renderer: s.renderer, builtin: s.builtin })
  return out
}

// ── Mutations (lock-enforced) ─────────────────────────────────────────────────────
export class ScreenDeckLockedError extends Error {}

async function assertUnlocked(deviceId: string, capability: 'selection' | 'config', asAdmin: boolean): Promise<void> {
  if (asAdmin) return
  const [dev] = await db.select({ lockScreenSelection: devices.lockScreenSelection, lockScreenConfig: devices.lockScreenConfig }).from(devices).where(eq(devices.id, deviceId))
  if (!dev) throw new ScreenDeckLockedError('device not found')
  const locked = capability === 'selection' ? dev.lockScreenSelection : dev.lockScreenConfig
  if (locked) throw new ScreenDeckLockedError(`screen ${capability} is locked by an admin for this device`)
}

export async function addScreen(
  deviceId: string, entry: { screenId: string; kind: ScreenKind; params?: Record<string, unknown> }, opts: { asAdmin: boolean },
) {
  await assertUnlocked(deviceId, 'selection', opts.asAdmin)
  const existing = await db.select({ position: deviceScreens.position }).from(deviceScreens).where(eq(deviceScreens.deviceId, deviceId))
  const nextPos = existing.length ? Math.max(...existing.map((r) => r.position)) + 1 : 0
  const id = uuid(); const ts = now()
  await db.insert(deviceScreens).values({
    id, deviceId, position: nextPos, screenId: entry.screenId, kind: entry.kind,
    params: JSON.stringify(entry.params ?? {}), enabled: true, createdAt: ts, updatedAt: ts,
  })
  await syncLegacyFields(deviceId)
  return id
}

export async function removeScreen(instanceId: string, opts: { asAdmin: boolean }) {
  const [row] = await db.select().from(deviceScreens).where(eq(deviceScreens.id, instanceId))
  if (!row) return false
  await assertUnlocked(row.deviceId, 'selection', opts.asAdmin)
  await db.delete(deviceScreens).where(eq(deviceScreens.id, instanceId))
  await syncLegacyFields(row.deviceId)
  return true
}

/** Full replacement of the deck order (drag-reorder). Rewrites `position` for every row
 *  in one go so a near-simultaneous admin + owner save can't interleave into duplicate
 *  positions — the whole deck is always written as a single, self-consistent list. */
export async function reorderScreens(deviceId: string, orderedInstanceIds: string[], opts: { asAdmin: boolean }) {
  await assertUnlocked(deviceId, 'selection', opts.asAdmin)
  const rows = await db.select({ id: deviceScreens.id }).from(deviceScreens).where(eq(deviceScreens.deviceId, deviceId))
  const validIds = new Set(rows.map((r) => r.id))
  if (orderedInstanceIds.length !== rows.length || !orderedInstanceIds.every((id) => validIds.has(id))) {
    throw new Error('reorder must include exactly the device\'s current screen instances')
  }
  const ts = now()
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedInstanceIds.length; i++) {
      await tx.update(deviceScreens).set({ position: i, updatedAt: ts }).where(eq(deviceScreens.id, orderedInstanceIds[i]!))
    }
  })
  await syncLegacyFields(deviceId)
}

export async function updateScreenParams(instanceId: string, params: Record<string, unknown>, opts: { asAdmin: boolean }) {
  const [row] = await db.select().from(deviceScreens).where(eq(deviceScreens.id, instanceId))
  if (!row) return false
  await assertUnlocked(row.deviceId, 'config', opts.asAdmin)
  await db.update(deviceScreens).set({ params: JSON.stringify(params), updatedAt: now() }).where(eq(deviceScreens.id, instanceId))
  await syncLegacyFields(row.deviceId)
  return true
}

export async function setScreenEnabled(instanceId: string, enabled: boolean, opts: { asAdmin: boolean }) {
  const [row] = await db.select().from(deviceScreens).where(eq(deviceScreens.id, instanceId))
  if (!row) return false
  await assertUnlocked(row.deviceId, 'selection', opts.asAdmin)
  await db.update(deviceScreens).set({ enabled, updatedAt: now() }).where(eq(deviceScreens.id, instanceId))
  await syncLegacyFields(row.deviceId)
  return true
}

/** Admin-only: gate what the owner may do in Settings → Devices. */
export async function setDeckLocks(deviceId: string, locks: { lockScreenSelection?: boolean; lockScreenConfig?: boolean }) {
  await db.update(devices).set(locks).where(eq(devices.id, deviceId))
}

/** Remove every device_screens row referencing a display/controller template that's about
 *  to be deleted, falling back cleanly instead of leaving a dangling screenId. Call this
 *  from the existing template-delete routes alongside their current devices.* fallback. */
export async function clearScreensReferencing(kind: 'clock-weather' | 'controller', screenId: string) {
  const rows = await db.select({ id: deviceScreens.id, deviceId: deviceScreens.deviceId }).from(deviceScreens)
    .where(and(eq(deviceScreens.kind, kind), eq(deviceScreens.screenId, screenId)))
  if (!rows.length) return
  await db.delete(deviceScreens).where(inArray(deviceScreens.id, rows.map((r) => r.id)))
  const deviceIds = [...new Set(rows.map((r) => r.deviceId))]
  for (const id of deviceIds) await syncLegacyFields(id)
}
