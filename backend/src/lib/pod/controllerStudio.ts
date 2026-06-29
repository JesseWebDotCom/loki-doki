// Controller layout resolution — parallel to deviceStudio.ts for the display side.
//
// Resolves a device's controller layout template (builtin or custom) into a
// StreamDeckConfigPayload ready to push over the Wyoming socket. Built-in templates
// populate dynamic rows from the bound user's account at resolve time (not stored).

import { eq, or, isNull, isNotNull, and, desc, sql } from 'drizzle-orm'
import { db } from '@/db'
import { devices, controllerLayoutTemplates, ytSubscriptions, ytVideos, musicStations, musicHistory } from '@/db/schema'
import { logger } from '@/lib/logger'
import type { StreamDeckConfigPayload } from '@/lib/pod/wyoming'

// ── Built-in template IDs (synthetic — no DB row needed) ──────────────────────
export const BUILTIN_CONTROLLER_TEMPLATES = ['builtin:default', 'builtin:blank', 'builtin:youtube-channels', 'builtin:music'] as const
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
  const templateId = device?.controllerLayoutTemplateId ?? 'builtin:default'

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
  if (templateId === 'builtin:default') return await defaultDashboardPage(userId)
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

// ── helpers ──
const trunc = (s: string, n = 14) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const accentHex = (slug: string | null | undefined, fallback: string) =>
  slug ? (slug.startsWith('#') ? slug : `#${slug.replace(/^#/, '')}`) : fallback
function tile(id: string, row: number, col: number, icon: string, label: string, bgColor: string,
             action: Record<string, unknown>, image?: string): Button {
  return { id, row, col, icon, label, bgColor, textColor: '#ffffff', action, ...(image ? { image } : {}) }
}

// The default dashboard: 10 tiles in the TOP TWO rows (the bottom row is reserved on the
// device for the global mic/sound controls + status). Content is pulled live from the
// bound user's account; playback controls sit on the right.
//
//   row 0:  station · station · station · ⏮ prev   · ⏯ play/pause
//   row 1:  video   · video   · video   · video    · ⏭ next
async function defaultDashboardPage(userId: string): Promise<Page[]> {
  const buttons: Button[] = []
  try {
    // 3 MOST-PLAYED stations (by history), padded with recent ones if fewer than 3.
    const played = await db
      .select({ stationId: musicHistory.stationId, n: sql<number>`count(*)` })
      .from(musicHistory)
      .where(and(eq(musicHistory.userId, userId), isNotNull(musicHistory.stationId)))
      .groupBy(musicHistory.stationId)
      .orderBy(desc(sql`count(*)`)).limit(8)
    const ids = played.map((p) => p.stationId).filter((x): x is string => !!x)
    const recent = await db
      .select({ id: musicStations.id, name: musicStations.name, iconPath: musicStations.iconPath, accent: musicStations.accent, category: musicStations.category })
      .from(musicStations)
      .where(or(eq(musicStations.userId, userId), isNull(musicStations.userId)))
      .orderBy(desc(musicStations.updatedAt)).limit(12)
    // Order: most-played first (resolved against the visible set), then recent fill.
    const byId = new Map(recent.map((s) => [s.id, s]))
    const ordered = [...ids.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s), ...recent]
    const seen = new Set<string>()
    const stations = ordered.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true))).slice(0, 3)
    for (let i = 0; i < 3; i++) {
      const st = stations[i]
      if (st) {
        // Stations render with the app's StationArt look (accent gradient + thematic
        // watermark). Only a REAL photo icon (non-svg) fills the tile; svg/placeholder
        // stations fall back to the watermark, matching the music app exactly.
        buttons.push({
          ...tile(`station-${st.id}`, 0, i, '📻', trunc(st.name), accentHex(st.accent, '#7c3aed'),
            { type: 'play_station', stationId: st.id },
            st.iconPath && !st.iconPath.endsWith('.svg') ? `/api/music/stations/${st.id}/art/icon` : undefined),
          accent: st.accent ?? undefined,
          category: st.category ?? undefined,
        })
      } else {
        buttons.push(tile(`station-empty-${i}`, 0, i, '📻', 'Stations', '#2d1458', { type: 'navigate', app: 'music' }))
      }
    }

    // 4 newest videos from the user's SUBSCRIPTIONS (the subscription feed), with real
    // titles + thumbnails.
    const vids = await db
      .select({ videoId: ytVideos.videoId, title: ytVideos.title, thumb: ytVideos.thumbnailUrl })
      .from(ytVideos)
      .innerJoin(ytSubscriptions, eq(ytVideos.subscriptionId, ytSubscriptions.id))
      .where(eq(ytSubscriptions.userId, userId))
      .orderBy(desc(ytVideos.publishedAt)).limit(4)
    for (let i = 0; i < 4; i++) {
      const v = vids[i]
      if (v) {
        // Open the video in the YouTube watch page (which plays it) — NOT the music radio.
        buttons.push(tile(`yt-${v.videoId}`, 1, i, '▶', trunc(v.title || 'YouTube'), '#7f1d1d',
          { type: 'navigate', app: 'youtube', videoId: v.videoId }, v.thumb || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`))
      } else {
        buttons.push(tile(`yt-empty-${i}`, 1, i, '▶', 'YouTube', '#7f1d1d', { type: 'navigate', app: 'youtube' }))
      }
    }
  } catch (e) {
    logger.warn(`[controller] default dashboard resolve failed: ${(e as Error).message}`)
  }

  // Playback controls, grouped on the right edge.
  buttons.push(
    tile('pb-prev', 0, 3, '⏮', 'Previous', '#27272a', { type: 'app_action', action: 'prev_track' }),
    tile('pb-play', 0, 4, '⏯', 'Play / Pause', '#16a34a', { type: 'app_action', action: 'play_pause' }),
    tile('pb-next', 1, 4, '⏭', 'Next', '#27272a', { type: 'app_action', action: 'next_track' }),
  )
  return [{ id: 'dashboard', name: 'Dashboard', gridRows: 3, gridCols: 5, sortOrder: 0, buttons }]
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
