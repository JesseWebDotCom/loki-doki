// The Doki TV scheduler: materializes each channel's next ~24h of concrete blocks into
// tv_schedule (plans/doki-tv.md). Determinism rule: the same channel on the same day
// draws from the same seeded lineup, so incremental extensions never reshuffle what the
// guide already promised. Every source degrades to offair blocks, never to a failure.

import { and, eq, gt, gte, lt, desc, asc, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { tvChannels, tvSchedule, tvSegments } from '@/db/schema'
import { logger } from '@/lib/logger'
import { TV_CATALOG, CAMERA_CHANNEL_BASE, CAMERA_CHANNEL_MAX } from './catalog'
import { hashSeed, seededShuffle, dayKey } from './rng'
import {
  plexMoviePool, plexEpisodePool, youtubeFeedPool, youtubeSearchPool,
  podcastPool, liveRadioStationCount, frigateCameraList, type TvMediaItem, type TvEpisodeItem,
} from './sources'
import type { TvBlockKind, TvBlockPayload, TvChannelConfig, TvDaypartProgram, TvScreenId, TvSignoff } from './types'

const HORIZON_MS = 24 * 60 * 60 * 1000
const PRUNE_AFTER_MS = 6 * 60 * 60 * 1000
const GRID_MS = 5 * 60 * 1000
const MIN_FILLER_MS = 45 * 1000
const MAX_BLOCKS_PER_BUILD = 600

interface PendingBlock {
  startAt: Date
  endAt: Date
  blockKind: TvBlockKind
  title: string
  subtitle?: string | null
  art?: string | null
  payload: TvBlockPayload
}

function floorToHour(t: number): number {
  const d = new Date(t)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}

function inSignoff(hour: number, s: TvSignoff): boolean {
  return s.startHour > s.endHour ? hour >= s.startHour || hour < s.endHour : hour >= s.startHour && hour < s.endHour
}

/** End of the signoff window strictly after `t`. Bounded: a degenerate window that
 *  covers every hour (bad config) must not spin the event loop forever. */
function signoffEnd(t: number, s: TvSignoff): number {
  const d = new Date(t)
  d.setMinutes(0, 0, 0)
  for (let i = 0; i < 26 && inSignoff(d.getHours(), s); i++) d.setTime(d.getTime() + 60 * 60 * 1000)
  return Math.max(d.getTime(), t + 60 * 60 * 1000)
}

function programFor(hour: number, programs: TvDaypartProgram[] | undefined, fallback: string): { title: string; subtitle?: string } {
  if (!programs?.length) return { title: fallback }
  const sorted = programs.slice().sort((a, b) => a.fromHour - b.fromHour)
  let pick = sorted[sorted.length - 1]
  for (const p of sorted) if (hour >= p.fromHour) pick = p
  return { title: pick.title, subtitle: pick.subtitle }
}

function offairBlock(startAt: number, endAt: number, reason: 'not-configured' | 'coming-soon' | 'signoff', title: string, message?: string): PendingBlock {
  return {
    startAt: new Date(startAt), endAt: new Date(endAt), blockKind: 'offair',
    title, subtitle: message ?? null,
    payload: { src: 'offair', reason, message },
  }
}

/**
 * Deterministic per-day lineup cursor: the Nth media block a channel schedules on a
 * given day is lineup[N % len] of that day's seeded shuffle. `existing` counts blocks
 * already materialized for that day, so extensions continue the lineup mid-day.
 */
function lineupItem<T>(pool: T[], slug: string, day: string, index: number): T {
  const lineup = seededShuffle(pool, hashSeed('tv', slug, day))
  return lineup[index % lineup.length]
}

async function countBlocksOnDay(channelId: string, kinds: TvBlockKind[], t: number): Promise<number> {
  const dayStart = new Date(t)
  dayStart.setHours(0, 0, 0, 0)
  const rows = await db.select({ id: tvSchedule.id }).from(tvSchedule)
    .where(and(
      eq(tvSchedule.channelId, channelId),
      inArray(tvSchedule.blockKind, kinds),
      gte(tvSchedule.startAt, dayStart),
      lt(tvSchedule.startAt, new Date(t)),
    ))
  return rows.length
}

// ── Per-kind block builders ────────────────────────────────────────────────────────

async function buildMediaBlocks(
  channel: { id: string; slug: string; name: string },
  config: Extract<TvChannelConfig, { kind: 'media' }>,
  from: number, until: number,
): Promise<PendingBlock[]> {
  let pool: TvMediaItem[] = []
  if (config.source === 'plex-movies') pool = await plexMoviePool()
  else if (config.source === 'plex-episodes') pool = await plexEpisodePool()
  else if (config.source === 'plex-marathon') {
    const episodes = await plexEpisodePool()
    const shows = [...new Set(episodes.map((e) => e.showKey))].sort()
    if (shows.length > 0) {
      // Show of the week: keyed by the local Monday of `from`'s week so the rotation
      // flips at local midnight into Monday, not at a UTC epoch-week boundary.
      const monday = new Date(from)
      monday.setHours(0, 0, 0, 0)
      while (monday.getDay() !== 1) monday.setDate(monday.getDate() - 1)
      const week = dayKey(monday)
      const showKey = shows[hashSeed('tv-marathon', week) % shows.length]
      pool = (episodes as TvEpisodeItem[])
        .filter((e) => e.showKey === showKey)
        .sort((a, b) => a.season - b.season || a.episode - b.episode)
    }
  } else if (config.source === 'youtube-feed') pool = await youtubeFeedPool(config.minDurationSec ?? 240, config.maxDurationSec ?? 0)
  else if (config.source === 'youtube-search') pool = await youtubeSearchPool(config.queries ?? [], config.minDurationSec ?? 120, config.maxDurationSec ?? 0)

  if (pool.length === 0) {
    const blocks: PendingBlock[] = []
    let cursor = from
    while (cursor < until) {
      const end = Math.min(cursor + 60 * 60 * 1000, until)
      blocks.push(offairBlock(cursor, end, 'not-configured', `${channel.name} is off the air`, 'No programming source is available yet'))
      cursor = end
    }
    return blocks
  }

  const blocks: PendingBlock[] = []
  let cursor = from
  let index = await countBlocksOnDay(channel.id, ['media'], from)
  let day = dayKey(new Date(from))
  const marathon = config.source === 'plex-marathon'
  while (cursor < until && blocks.length < MAX_BLOCKS_PER_BUILD) {
    if (config.signoff && inSignoff(new Date(cursor).getHours(), config.signoff)) {
      const end = Math.min(signoffEnd(cursor, config.signoff), until)
      blocks.push(offairBlock(cursor, end, 'signoff', 'Off air until morning', `${channel.name} has signed off for the night`))
      cursor = end
      continue
    }
    const nowDay = dayKey(new Date(cursor))
    if (nowDay !== day) { day = nowDay; index = 0 }
    // Marathon plays in episode order (no shuffle); everything else shuffles per day.
    const item = marathon ? pool[(hashSeed('tv-marathon-idx', day) + index) % pool.length] : lineupItem(pool, channel.slug, day, index)
    index++
    const end = cursor + Math.max(item.durationMs, 60 * 1000)
    blocks.push({
      startAt: new Date(cursor), endAt: new Date(end), blockKind: 'media',
      title: item.title, subtitle: item.subtitle ?? null, art: item.art ?? null, payload: item.payload,
    })
    // Pad to the broadcast grid with an up-next filler card, real-TV style.
    const grid = Math.ceil(end / GRID_MS) * GRID_MS
    const nextItem = marathon ? pool[(hashSeed('tv-marathon-idx', day) + index) % pool.length] : lineupItem(pool, channel.slug, day, index)
    if (grid - end >= MIN_FILLER_MS && grid < until) {
      blocks.push({
        startAt: new Date(end), endAt: new Date(grid), blockKind: 'filler',
        title: 'Up next', subtitle: nextItem?.title ?? null,
        payload: { src: 'filler', style: 'upnext', nextTitle: nextItem?.title },
      })
      cursor = grid
    } else {
      cursor = end
    }
  }
  return blocks
}

function buildPageBlocks(
  channel: { name: string },
  config: Extract<TvChannelConfig, { kind: 'page' }>,
  from: number, until: number,
): PendingBlock[] {
  const blocks: PendingBlock[] = []
  const len = Math.max(5, config.programMin ?? 30) * 60 * 1000
  let cursor = from
  while (cursor < until && blocks.length < MAX_BLOCKS_PER_BUILD) {
    if (config.signoff && inSignoff(new Date(cursor).getHours(), config.signoff)) {
      const end = Math.min(signoffEnd(cursor, config.signoff), until)
      blocks.push(offairBlock(cursor, end, 'signoff', 'Off air until morning'))
      cursor = end
      continue
    }
    const end = Math.min(cursor + len, until)
    const program = programFor(new Date(cursor).getHours(), config.programs, channel.name)
    blocks.push({
      startAt: new Date(cursor), endAt: new Date(end), blockKind: 'page',
      title: program.title, subtitle: program.subtitle ?? null,
      payload: { src: 'page', screen: config.screen },
    })
    cursor = end
  }
  return blocks
}

async function buildAudioBlocks(
  channel: { id: string; slug: string; name: string },
  config: Extract<TvChannelConfig, { kind: 'audio' }>,
  from: number, until: number,
): Promise<PendingBlock[]> {
  const blocks: PendingBlock[] = []

  if (config.source === 'podcasts' || config.source === 'ai-podcasts') {
    const pool = await podcastPool(config.source === 'ai-podcasts')
    if (pool.length === 0) {
      let cursor = from
      while (cursor < until) {
        const end = Math.min(cursor + 60 * 60 * 1000, until)
        blocks.push(offairBlock(cursor, end, 'not-configured', `${channel.name} is off the air`,
          config.source === 'ai-podcasts' ? 'Make an AI podcast and it will air here' : 'Subscribe to podcasts and they will air here'))
        cursor = end
      }
      return blocks
    }
    let cursor = from
    let index = await countBlocksOnDay(channel.id, ['audio'], from)
    let day = dayKey(new Date(from))
    while (cursor < until && blocks.length < MAX_BLOCKS_PER_BUILD) {
      const nowDay = dayKey(new Date(cursor))
      if (nowDay !== day) { day = nowDay; index = 0 }
      const item = lineupItem(pool, channel.slug, day, index)
      index++
      const end = cursor + Math.max(item.durationMs, 5 * 60 * 1000)
      blocks.push({
        startAt: new Date(cursor), endAt: new Date(end), blockKind: 'audio',
        title: item.title, subtitle: item.subtitle ?? null, art: item.art ?? null, payload: item.payload,
      })
      cursor = end
    }
    return blocks
  }

  if (config.source === 'live-radio') {
    const hasStations = (await liveRadioStationCount()) > 0
    let cursor = from
    while (cursor < until && blocks.length < MAX_BLOCKS_PER_BUILD) {
      const end = Math.min(cursor + 60 * 60 * 1000, until)
      if (hasStations) {
        blocks.push({
          startAt: new Date(cursor), endAt: new Date(end), blockKind: 'audio',
          title: 'Live Radio Hour', subtitle: 'Your saved stations, straight off the air',
          payload: { src: 'live-radio' },
        })
      } else {
        blocks.push(offairBlock(cursor, end, 'not-configured', 'Live Radio is off the air', 'Save a live radio station in Music and it will air here'))
      }
      cursor = end
    }
    return blocks
  }

  // stations: daypart rotation of AI music stations.
  const stations = config.stations ?? []
  let cursor = from
  while (cursor < until && blocks.length < MAX_BLOCKS_PER_BUILD) {
    const end = Math.min(cursor + 60 * 60 * 1000, until)
    const hour = new Date(cursor).getHours()
    let pick = stations[stations.length - 1]
    for (const s of stations) if (hour >= (s.fromHour ?? 0)) pick = s
    if (pick) {
      blocks.push({
        startAt: new Date(cursor), endAt: new Date(end), blockKind: 'audio',
        title: pick.name, subtitle: 'Doki FM', payload: { src: 'station', stationId: pick.id, stationName: pick.name },
      })
    } else {
      blocks.push(offairBlock(cursor, end, 'not-configured', `${channel.name} is off the air`))
    }
    cursor = end
  }
  return blocks
}

function buildLiveBlocks(
  channel: { name: string },
  config: Extract<TvChannelConfig, { kind: 'live' }>,
  from: number, until: number,
): PendingBlock[] {
  const blocks: PendingBlock[] = []
  const rotate = Math.max(1, config.rotateMin ?? 30) * 60 * 1000
  let cursor = from
  while (cursor < until && blocks.length < MAX_BLOCKS_PER_BUILD) {
    const end = Math.min(cursor + rotate, until)
    if (config.feeds.length === 0) {
      blocks.push(offairBlock(cursor, end, 'not-configured', `${channel.name} is off the air`, 'Add a stream in the TV admin settings'))
    } else {
      const feed = config.feeds[Math.floor(cursor / rotate) % config.feeds.length]
      blocks.push({
        startAt: new Date(cursor), endAt: new Date(end), blockKind: 'live',
        title: `Live: ${feed.label}`, subtitle: channel.name,
        payload: { src: 'live', feed: { type: feed.type, url: feed.url, camera: feed.camera, label: feed.label } },
      })
    }
    cursor = end
  }
  return blocks
}

async function buildSegmentBlocks(
  channel: { id: string; name: string },
  config: Extract<TvChannelConfig, { kind: 'segment' }>,
  from: number, until: number,
): Promise<PendingBlock[]> {
  const ready = await db.select().from(tvSegments)
    .where(and(eq(tvSegments.channelId, channel.id), eq(tvSegments.status, 'ready')))
    .orderBy(desc(tvSegments.airDate))
    .limit(50)
  const blocks: PendingBlock[] = []
  let cursor = from
  // Continue the rotation where the day's earlier extensions left off, like media blocks.
  let i = await countBlocksOnDay(channel.id, ['segment'], from)
  while (cursor < until && blocks.length < MAX_BLOCKS_PER_BUILD) {
    if (config.signoff && inSignoff(new Date(cursor).getHours(), config.signoff)) {
      const end = Math.min(signoffEnd(cursor, config.signoff), until)
      blocks.push(offairBlock(cursor, end, 'signoff', 'Off air until morning'))
      cursor = end
      continue
    }
    if (ready.length === 0) {
      if (config.fallbackScreen) {
        const end = Math.min(cursor + 30 * 60 * 1000, until)
        blocks.push({
          startAt: new Date(cursor), endAt: new Date(end), blockKind: 'page',
          title: channel.name, payload: { src: 'page', screen: config.fallbackScreen as TvScreenId },
        })
        cursor = end
      } else {
        const end = Math.min(cursor + 60 * 60 * 1000, until)
        blocks.push(offairBlock(cursor, end, 'coming-soon', `${channel.name} signs on soon`, config.comingSoon))
        cursor = end
      }
      continue
    }
    const seg = ready[i % ready.length]
    i++
    const end = cursor + Math.max((seg.durationSec ?? 600) * 1000, 60 * 1000)
    blocks.push({
      startAt: new Date(cursor), endAt: new Date(end), blockKind: 'segment',
      title: seg.title, payload: { src: 'segment', segmentId: seg.id },
    })
    cursor = end
  }
  return blocks
}

// ── Seeding + rebuild ─────────────────────────────────────────────────────────────

/** Humanize a frigate camera key: "front_door" → "Front Door". */
function humanize(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}

const CAMERA_COLORS: Array<[string, string]> = [
  ['#64748b', '#0f172a'], ['#78716c', '#1c1917'], ['#6b7280', '#111827'], ['#71717a', '#18181b'],
]

/** Insert catalog channels that do not exist yet; leave existing rows (admin edits) alone. */
export async function seedTvChannels(): Promise<void> {
  const existing = await db.select({ slug: tvChannels.slug, number: tvChannels.number }).from(tvChannels)
  const slugs = new Set(existing.map((r) => r.slug))
  const numbers = new Set(existing.map((r) => r.number))
  const now = new Date()

  for (const entry of TV_CATALOG) {
    if (slugs.has(entry.slug) || numbers.has(entry.number)) continue
    // onConflictDoNothing: boot seeding and an admin rebuild can race; the unique
    // constraints stay authoritative and a lost race must not abort the seed loop.
    await db.insert(tvChannels).values({
      id: crypto.randomUUID(),
      number: entry.number, slug: entry.slug, name: entry.name, tagline: entry.tagline,
      kind: entry.kind, glyph: entry.glyph, color: entry.color, colorDark: entry.colorDark,
      audience: entry.audience ?? 'everyone',
      config: JSON.stringify(entry.config), enabled: true, builtin: true,
      createdAt: now, updatedAt: now,
    }).onConflictDoNothing()
    slugs.add(entry.slug)
    numbers.add(entry.number)
  }

  // One channel per Frigate camera on the 20s. New cameras get the next free slot.
  const cams = (await frigateCameraList()).slice(0, CAMERA_CHANNEL_MAX)
  for (const cam of cams) {
    const slug = `cam-${cam.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    if (slugs.has(slug)) continue
    let number = CAMERA_CHANNEL_BASE
    while (numbers.has(number) && number < CAMERA_CHANNEL_BASE + CAMERA_CHANNEL_MAX) number++
    if (numbers.has(number)) continue
    const palette = CAMERA_COLORS[(number - CAMERA_CHANNEL_BASE) % CAMERA_COLORS.length]
    await db.insert(tvChannels).values({
      id: crypto.randomUUID(),
      number, slug, name: `${humanize(cam)} Cam`, tagline: 'Live from around the house',
      kind: 'live', glyph: 'Cctv', color: palette[0], colorDark: palette[1],
      audience: 'everyone',
      config: JSON.stringify({ kind: 'live', feeds: [{ key: cam, label: humanize(cam), type: 'frigate', camera: cam }], rotateMin: 30 } satisfies TvChannelConfig),
      enabled: true, builtin: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing()
    slugs.add(slug)
    numbers.add(number)
  }
}

// Serialize all schedule writes per channel: boot init, the hourly timer, on-demand
// extension from /now, and admin rebuilds can otherwise interleave (each read of
// last.endAt races the others' row-by-row inserts) and double-materialize every block.
const channelLocks = new Map<string, Promise<unknown>>()

async function withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  const prev = channelLocks.get(channelId) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  channelLocks.set(channelId, tail)
  void tail.then(() => {
    if (channelLocks.get(channelId) === tail) channelLocks.delete(channelId)
  })
  return run
}

/** Extend one channel's schedule to now + horizon. Returns blocks added. */
export function extendChannelSchedule(channelId: string): Promise<number> {
  return withChannelLock(channelId, () => extendChannelScheduleLocked(channelId))
}

async function extendChannelScheduleLocked(channelId: string): Promise<number> {
  const rows = await db.select().from(tvChannels).where(eq(tvChannels.id, channelId)).limit(1)
  const channel = rows[0]
  if (!channel || !channel.enabled) return 0
  const config = JSON.parse(channel.config) as TvChannelConfig

  const now = Date.now()
  const horizon = now + HORIZON_MS
  const last = await db.select({ endAt: tvSchedule.endAt }).from(tvSchedule)
    .where(eq(tvSchedule.channelId, channel.id))
    .orderBy(desc(tvSchedule.endAt))
    .limit(1)
  // First build starts at the top of the current hour so tune-in lands mid-program,
  // like TV that was already on before you sat down.
  const from = Math.max(last[0]?.endAt.getTime() ?? floorToHour(now), floorToHour(now) - 0)
  if (from >= horizon) return 0

  let blocks: PendingBlock[] = []
  try {
    if (config.kind === 'media') blocks = await buildMediaBlocks(channel, config, from, horizon)
    else if (config.kind === 'page') blocks = buildPageBlocks(channel, config, from, horizon)
    else if (config.kind === 'audio') blocks = await buildAudioBlocks(channel, config, from, horizon)
    else if (config.kind === 'live') blocks = buildLiveBlocks(channel, config, from, horizon)
    else if (config.kind === 'segment') blocks = await buildSegmentBlocks(channel, config, from, horizon)
  } catch (err) {
    logger.warn('[tv] schedule build failed', { channel: channel.slug, err: err instanceof Error ? err.message : String(err) })
    return 0
  }

  const now2 = new Date()
  for (const b of blocks) {
    await db.insert(tvSchedule).values({
      id: crypto.randomUUID(),
      channelId: channel.id,
      startAt: b.startAt, endAt: b.endAt, blockKind: b.blockKind,
      title: b.title, subtitle: b.subtitle ?? null, art: b.art ?? null,
      payload: JSON.stringify(b.payload),
      createdAt: now2,
    })
  }
  return blocks.length
}

/** Drop a channel's future blocks and rebuild (admin config change). */
export function rebuildChannelSchedule(channelId: string): Promise<number> {
  return withChannelLock(channelId, async () => {
    await db.delete(tvSchedule).where(and(eq(tvSchedule.channelId, channelId), gt(tvSchedule.startAt, new Date())))
    return extendChannelScheduleLocked(channelId)
  })
}

export async function ensureTvSchedules(): Promise<void> {
  await db.delete(tvSchedule).where(lt(tvSchedule.endAt, new Date(Date.now() - PRUNE_AFTER_MS)))
  const channels = await db.select({ id: tvChannels.id, slug: tvChannels.slug }).from(tvChannels).where(eq(tvChannels.enabled, true)).orderBy(asc(tvChannels.number))
  for (const ch of channels) {
    const added = await extendChannelSchedule(ch.id)
    if (added > 0) logger.info('[tv] schedule extended', { channel: ch.slug, added })
  }
}

let started = false
/** Boot hook: seed the dial, build schedules, keep them topped up hourly. */
export function initTvScheduler(): void {
  if (started) return
  started = true
  void (async () => {
    try {
      await seedTvChannels()
      await ensureTvSchedules()
    } catch (err) {
      logger.warn('[tv] init failed', { err: err instanceof Error ? err.message : String(err) })
    }
  })()
  setInterval(() => {
    void ensureTvSchedules().catch(() => {})
  }, 60 * 60 * 1000).unref()
}
