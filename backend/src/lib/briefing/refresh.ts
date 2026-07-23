// Briefing refresh orchestration.
//
// refreshBriefing() fans out to every enabled source with Promise.allSettled — each
// source already swallows its own errors, and any that fail land in `degraded[]` and have
// their section dropped. NOTHING here ever runs on the companion request path: the route
// only reads the warm cache. startBriefingRefresh() warms the default location at boot and
// re-refreshes on the admin cadence; ensureBriefingWarm() is a fire-and-forget lazy refresh
// the route can kick for a user's location without ever awaiting it.

import { logger } from '@/lib/logger'
import type { BriefingPayload } from './types'
import { getBriefingSettings, type BriefingSettings } from './settings'
import { setCachedBriefing, getCachedBriefing, peekCachedBriefing, cachedBriefingKeys } from './cache'
import { renderBriefingBlock } from './render'
import { resolvePatchSlug } from './resolveSlug'
import { blendedLocalNews } from './localNews'
import { weatherSummary } from './sources/weather'
import { worldNews } from './sources/worldNews'
import { notableDeaths } from './sources/notableDeaths'
import { onThisDay } from './sources/onThisDay'
import { todaysHolidays } from './sources/holidays'
import { googleNewsSearch, bingNewsSearch } from './sources/rss'
import { sportsToday } from './sources/sports'
import { plexRecentlyAdded } from './sources/plex'
import { todaysHouseholdEvents } from './sources/calendar'

export const DEFAULT_BRIEFING_KEY = '__default__'

export interface BriefingLocation {
  displayName: string
  lat?: number
  lng?: number
}

function todayDateString(): string {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

/**
 * Build a fresh briefing for `location` and write it to the cache under `cacheKey`
 * (defaults to the location's displayName; the boot default uses DEFAULT_BRIEFING_KEY).
 */
export async function refreshBriefing(
  location: BriefingLocation,
  opts: { cacheKey?: string; settings?: BriefingSettings; userId?: string } = {},
): Promise<BriefingPayload> {
  const s = opts.settings ?? (await getBriefingSettings())
  const cacheKey = opts.cacheKey ?? location.displayName
  const degraded: string[] = []

  const payload: BriefingPayload = {
    location: location.displayName,
    generatedAt: Date.now(),
    date: todayDateString(),
    holidays: [],
    localNews: [],
    localEvents: [],
    worldNews: [],
    sports: [],
    notableDeaths: [],
    onThisDay: [],
    plex: [],
    calendar: [],
    degraded,
  }

  // Master switch off → cache an empty block so the route injects nothing.
  if (!s.enabled) {
    setCachedBriefing(cacheKey, payload, '')
    return payload
  }

  const tasks: Promise<void>[] = []

  if (s.sources.weather) {
    tasks.push(
      weatherSummary({ location: location.displayName, lat: location.lat, lng: location.lng })
        .then((w) => { payload.weather = w })
        .catch(() => { degraded.push('weather') }),
    )
  }
  if (s.sources.worldNews) {
    tasks.push(worldNews(s.maxItems.worldNews).then((x) => { payload.worldNews = x }).catch(() => { degraded.push('worldNews') }))
  }
  if (s.sources.notableDeaths) {
    tasks.push(notableDeaths(2).then((x) => { payload.notableDeaths = x }).catch(() => { degraded.push('notableDeaths') }))
  }
  if (s.sources.onThisDay) {
    // Notable events + a couple of notable birthdays ("celebrity born today").
    tasks.push(
      Promise.all([
        onThisDay({ limit: 2, feed: 'selected' }).catch(() => []),
        onThisDay({ limit: 2, feed: 'births' }).catch(() => []),
      ])
        .then(([events, births]) => {
          payload.onThisDay = [...events, ...births.map((b) => ({ title: `Born today: ${b.title}` }))]
          if (!payload.onThisDay.length) degraded.push('onThisDay')
        })
        .catch(() => { degraded.push('onThisDay') }),
    )
  }
  if (s.sources.sports) {
    tasks.push(sportsToday({ limit: s.maxItems.sports }).then((x) => { payload.sports = x }).catch(() => { degraded.push('sports') }))
  }
  if (s.sources.holidays) {
    tasks.push(todaysHolidays('US').then((x) => { payload.holidays = x }).catch(() => { degraded.push('holidays') }))
  }
  if (s.sources.plex) {
    tasks.push(plexRecentlyAdded(4).then((x) => { payload.plex = x }).catch(() => { degraded.push('plex') }))
  }
  if (s.sources.calendar) {
    // Local DB read (already-synced iCloud events); empty when the gate is off.
    tasks.push(todaysHouseholdEvents(4).then((x) => { payload.calendar = x }).catch(() => { degraded.push('calendar') }))
  }
  if (s.sources.localNews || s.sources.localEvents) {
    const limit = Math.max(s.maxItems.localNews, s.maxItems.localEvents)
    const userId = opts.userId ?? ''
    if (userId) {
      // Blended path — Patch + Daily Voice + Google News RSS, consent already granted.
      // Shared with the News app's "Local" tab and the localNews tool (see localNews.ts).
      const slugP = s.patchSlug ? Promise.resolve<string | null>(s.patchSlug) : resolvePatchSlug(location.displayName)
      tasks.push(
        slugP
          .then((slug) => blendedLocalNews({ patchSlug: slug, townLabel: location.displayName, limit }))
          .then((r) => {
            if (s.sources.localNews) payload.localNews = r.news
            if (s.sources.localEvents) payload.localEvents = r.events
          })
          .catch(() => { degraded.push('localNews'); degraded.push('localEvents') }),
      )
    } else {
      // Clean default — Bing News RSS (real per-article images, unlike Google News), no scraping.
      if (s.sources.localNews) {
        tasks.push(
          bingNewsSearch(`${location.displayName} local news`, limit, 7000)
            .then((items) => { payload.localNews = items.map(i => ({ title: i.title, detail: i.source || undefined, url: i.url, imageUrl: i.imageUrl, summary: i.summary, publishedAt: i.publishedAt })) })
            .catch(() => { degraded.push('localNews') }),
        )
      }
      if (s.sources.localEvents) {
        tasks.push(
          googleNewsSearch(`${location.displayName} local events this week`, limit, 7000)
            .then((items) => { payload.localEvents = items.map(i => ({ title: i.title, url: i.url ?? undefined, detail: i.source ?? undefined })) })
            .catch(() => { degraded.push('localEvents') }),
        )
      }
    }
  }

  await Promise.allSettled(tasks)

  const block = renderBriefingBlock(payload, s.maxItems)
  setCachedBriefing(cacheKey, payload, block)
  if (degraded.length) logger.info(`[briefing] refreshed ${cacheKey} (degraded: ${degraded.join(',')})`)
  return payload
}

// Coalesce concurrent refreshes for the same key (the route may kick this every turn).
const inFlight = new Set<string>()

/**
 * Fire-and-forget lazy warm: if the cache entry for `cacheKey` is missing or stale,
 * refresh it in the background. Safe to call from the request path (never awaited).
 */
export function ensureBriefingWarm(cacheKey: string, location?: BriefingLocation | null, userId?: string): void {
  if (getCachedBriefing(cacheKey)) return // fresh — nothing to do
  if (inFlight.has(cacheKey)) return
  inFlight.add(cacheKey)
  void (async () => {
    try {
      const s = await getBriefingSettings()
      const loc = location ?? { displayName: s.defaultLocation }
      await refreshBriefing(loc, { cacheKey, settings: s, userId })
    } catch (err) {
      logger.error(`[briefing] lazy warm failed for ${cacheKey}: ${err}`)
    } finally {
      inFlight.delete(cacheKey)
    }
  })()
}

/**
 * Start the background refresher. Warms the default-location briefing immediately, then
 * re-refreshes the default plus every other cached location on the admin cadence.
 * Returns a stop handle (mirrors startMemorySweep()).
 */
export function startBriefingRefresh(): { stop: () => void } {
  // Immediate warm-up for the default key so the first post-boot companion turn has a block.
  void (async () => {
    try {
      const s = await getBriefingSettings()
      await refreshBriefing({ displayName: s.defaultLocation }, { cacheKey: DEFAULT_BRIEFING_KEY, settings: s })
    } catch (err) {
      logger.error(`[briefing] startup warm failed: ${err}`)
    }
  })()

  // Re-check cadence dynamically each tick (admins can change it); run a light tick
  // every 5 min and refresh any entry older than the configured cadence.
  const TICK_MS = 5 * 60 * 1000
  let lastRunByKey = new Map<string, number>()

  const timer = setInterval(() => {
    void (async () => {
      try {
        const s = await getBriefingSettings()
        const cadenceMs = Math.max(30, s.cadenceMinutes) * 60 * 1000
        const keys = new Set(cachedBriefingKeys())
        keys.add(DEFAULT_BRIEFING_KEY)
        const now = Date.now()
        for (const key of keys) {
          if (now - (lastRunByKey.get(key) ?? 0) < cadenceMs) continue
          lastRunByKey.set(key, now)
          const entry = peekCachedBriefing(key)
          const displayName = entry?.payload.location ?? s.defaultLocation
          void refreshBriefing({ displayName }, { cacheKey: key, settings: s }).catch((err) =>
            logger.error(`[briefing] refresh ${key} failed: ${err}`),
          )
        }
      } catch (err) {
        logger.error(`[briefing] refresh tick failed: ${err}`)
      }
    })()
  }, TICK_MS)

  return {
    stop() {
      clearInterval(timer)
      lastRunByKey = new Map()
    },
  }
}
