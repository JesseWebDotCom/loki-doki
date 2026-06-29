// Controller layout resolution — parallel to deviceStudio.ts for the display side.
//
// Resolves a device's controller layout template (builtin or custom) into a
// StreamDeckConfigPayload ready to push over the Wyoming socket. Built-in templates
// populate dynamic rows from the bound user's account at resolve time (not stored).

import { eq, or, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { devices, controllerLayoutTemplates, ytSubscriptions, musicStations } from '@/db/schema'
import { logger } from '@/lib/logger'
import type { StreamDeckConfigPayload } from '@/lib/pod/wyoming'

// ── Built-in template IDs (synthetic — no DB row needed) ──────────────────────
export const BUILTIN_CONTROLLER_TEMPLATES = ['builtin:blank', 'builtin:youtube-channels', 'builtin:music'] as const
export type BuiltinControllerTemplateId = (typeof BUILTIN_CONTROLLER_TEMPLATES)[number]

// ── Types ──────────────────────────────────────────────────────────────────────
type Page = StreamDeckConfigPayload['pages'][0]
type Button = Page['buttons'][0]

interface ButtonOverride {
  pageIndex: number
  row: number
  col: number
  patch: Partial<Button>
}

// ── Main resolver ──────────────────────────────────────────────────────────────

/** Resolve the effective controller layout for a device into a push-ready payload.
 *  Built-in templates with dynamic data (YouTube channels, music stations) are
 *  populated from the bound user's account at resolve time, not stored. */
export async function resolveControllerDescriptor(deviceId: string, userId: string): Promise<StreamDeckConfigPayload> {
  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId))
  const templateId = device?.controllerLayoutTemplateId ?? 'builtin:blank'

  let pages = await resolveTemplate(templateId, userId)

  // Apply per-device overrides (individual button customizations on top of template).
  if (device?.controllerLayoutOverrides) {
    try {
      const overrides = JSON.parse(device.controllerLayoutOverrides) as ButtonOverride[]
      pages = applyOverrides(pages, overrides)
    } catch { /* malformed overrides — ignore */ }
  }

  return { pages }
}

// ── Template resolution ────────────────────────────────────────────────────────

async function resolveTemplate(templateId: string, userId: string): Promise<Page[]> {
  if (templateId === 'builtin:blank') return [blankPage()]
  if (templateId === 'builtin:youtube-channels') return await ytChannelsPage(userId)
  if (templateId === 'builtin:music') return await musicPage(userId)

  // Custom template — load from DB.
  const [tmpl] = await db.select().from(controllerLayoutTemplates).where(eq(controllerLayoutTemplates.id, templateId))
  if (!tmpl) {
    logger.warn(`[controller-studio] unknown template ${templateId}, falling back to blank`)
    return [blankPage()]
  }
  try {
    return JSON.parse(tmpl.pagesJson) as Page[]
  } catch {
    return [blankPage()]
  }
}

// ── Built-in page builders ─────────────────────────────────────────────────────

function blankPage(): Page {
  return { id: 'page-1', name: 'Main', gridRows: 3, gridCols: 5, sortOrder: 0, buttons: [] }
}

async function ytChannelsPage(userId: string): Promise<Page[]> {
  try {
    // Load user's YouTube channel subscriptions (up to 5 for the top row).
    const subs = await db
      .select({ externalId: ytSubscriptions.externalId, title: ytSubscriptions.title, thumbnailUrl: ytSubscriptions.thumbnailUrl })
      .from(ytSubscriptions)
      .where(eq(ytSubscriptions.userId, userId))
      .limit(5)

    const buttons: Button[] = []

    // Top row: one button per subscribed channel (up to 5).
    for (let i = 0; i < 5; i++) {
      const sub = subs[i]
      if (sub) {
        buttons.push({
          id: `yt-ch-${i}`,
          row: 0, col: i,
          icon: '▶',
          label: sub.title.length > 12 ? sub.title.slice(0, 11) + '…' : sub.title,
          bgColor: '#cc0000',
          textColor: '#ffffff',
          action: { type: 'navigate', app: 'youtube', channelId: sub.externalId },
        })
      } else {
        // Placeholder for empty slots.
        buttons.push({
          id: `yt-empty-${i}`,
          row: 0, col: i,
          icon: '＋',
          label: 'Subscribe',
          bgColor: '#3a0000',
          textColor: '#888888',
          action: { type: 'navigate', app: 'youtube' },
        })
      }
    }

    // Middle row: navigation shortcuts.
    buttons.push(
      { id: 'yt-home',    row: 1, col: 0, icon: '🏠', label: 'Home',    bgColor: '#1a1a2e', textColor: '#fff', action: { type: 'navigate', app: 'youtube' } },
      { id: 'yt-search',  row: 1, col: 1, icon: '🔍', label: 'Search',  bgColor: '#1a1a2e', textColor: '#fff', action: { type: 'navigate', app: 'youtube', view: 'search' } },
      { id: 'yt-subs',    row: 1, col: 2, icon: '📋', label: 'Feed',    bgColor: '#1a1a2e', textColor: '#fff', action: { type: 'navigate', app: 'youtube', view: 'subscriptions' } },
      { id: 'yt-trending',row: 1, col: 3, icon: '🔥', label: 'Trending',bgColor: '#1a1a2e', textColor: '#fff', action: { type: 'navigate', app: 'youtube', view: 'trending' } },
      { id: 'yt-history', row: 1, col: 4, icon: '🕐', label: 'History', bgColor: '#1a1a2e', textColor: '#fff', action: { type: 'navigate', app: 'youtube', view: 'history' } },
    )

    return [{ id: 'yt-main', name: 'YouTube', gridRows: 3, gridCols: 5, sortOrder: 0, buttons }]
  } catch (e) {
    logger.warn(`[controller-studio] yt channels resolve failed: ${(e as Error).message}`)
    return [blankPage()]
  }
}

async function musicPage(userId: string): Promise<Page[]> {
  try {
    // Load user's own stations plus built-ins for the station row (up to 3 for row 1).
    const stations = await db
      .select({ id: musicStations.id, name: musicStations.name, accent: musicStations.accent, seedType: musicStations.seedType })
      .from(musicStations)
      .where(or(eq(musicStations.userId, userId), isNull(musicStations.userId)))
      .limit(3)

    const buttons: Button[] = [
      // Row 0: playback controls.
      { id: 'music-play',  row: 0, col: 0, icon: '⏸', label: 'Play/Pause', bgColor: '#7c3aed', textColor: '#fff', action: { type: 'app_action', action: 'play_pause' } },
      { id: 'music-next',  row: 0, col: 1, icon: '⏭', label: 'Next',        bgColor: '#4c1d95', textColor: '#fff', action: { type: 'app_action', action: 'next_track' } },
      { id: 'music-nav',   row: 0, col: 2, icon: '🎵', label: 'Music',       bgColor: '#2d1458', textColor: '#fff', action: { type: 'navigate', app: 'music' } },
      { id: 'music-vol+',  row: 0, col: 3, icon: '🔊', label: 'Vol +',       bgColor: '#1e3a5f', textColor: '#fff', action: { type: 'app_action', action: 'volume_up' } },
      { id: 'music-vol-',  row: 0, col: 4, icon: '🔉', label: 'Vol -',       bgColor: '#1e3a5f', textColor: '#fff', action: { type: 'app_action', action: 'volume_down' } },
    ]

    // Row 1: top music stations.
    for (let i = 0; i < stations.length && i < 3; i++) {
      const st = stations[i]!
      const accent = st.accent ? `#${st.accent.replace(/^#/, '')}` : '#7c3aed'
      buttons.push({
        id: `music-station-${i}`,
        row: 1, col: i,
        icon: '📻',
        label: st.name.length > 12 ? st.name.slice(0, 11) + '…' : st.name,
        bgColor: accent,
        textColor: '#ffffff',
        action: { type: 'play_station', stationId: st.id },
      })
    }

    return [{ id: 'music-main', name: 'Music', gridRows: 3, gridCols: 5, sortOrder: 0, buttons }]
  } catch (e) {
    logger.warn(`[controller-studio] music page resolve failed: ${(e as Error).message}`)
    return [blankPage()]
  }
}

// ── Per-device button overrides ────────────────────────────────────────────────

function applyOverrides(pages: Page[], overrides: ButtonOverride[]): Page[] {
  for (const ov of overrides) {
    const page = pages[ov.pageIndex]
    if (!page) continue
    const btn = page.buttons.find((b) => b.row === ov.row && b.col === ov.col)
    if (btn) Object.assign(btn, ov.patch)
  }
  return pages
}
