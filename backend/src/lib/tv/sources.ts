// Content pools the TV scheduler draws from. Every source degrades to an empty pool
// when its subsystem is unconfigured or unreachable; the scheduler turns an empty pool
// into offair blocks instead of failing the whole rebuild.

import { desc, isNotNull, and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { ytVideos, podcastEpisodes, podcastShows, musicRadioStations } from '@/db/schema'
import { getPlexConnection, plexGet, type PlexConnection } from '@/lib/plex'
import { getFrigateConfig } from '@/lib/frigate/config'
import { innertubeSearch, tryInnertube, SEARCH_FILTERS, type ItVideo } from '@/lib/youtube/innertube'
import { logger } from '@/lib/logger'
import type { TvBlockPayload } from './types'

export interface TvMediaItem {
  payload: TvBlockPayload
  title: string
  subtitle?: string | null
  art?: string | null
  durationMs: number
}

// Pools are rebuilt at most every POOL_TTL_MS; the scheduler runs hourly and on boot,
// so this keeps Plex/InnerTube traffic to a handful of calls a day.
const POOL_TTL_MS = 6 * 60 * 60 * 1000
const poolCache = new Map<string, { at: number; items: TvMediaItem[] }>()

async function cachedPool(key: string, build: () => Promise<TvMediaItem[]>): Promise<TvMediaItem[]> {
  const hit = poolCache.get(key)
  if (hit && Date.now() - hit.at < POOL_TTL_MS && hit.items.length > 0) return hit.items
  try {
    const items = await build()
    poolCache.set(key, { at: Date.now(), items })
    return items
  } catch (err) {
    logger.warn('[tv] pool build failed', { key, err: err instanceof Error ? err.message : String(err) })
    return hit?.items ?? []
  }
}

// ── Plex ─────────────────────────────────────────────────────────────────────────

interface PlexListMeta {
  ratingKey?: string
  title?: string
  year?: number
  thumb?: string
  duration?: number
  grandparentTitle?: string
  grandparentThumb?: string
  grandparentRatingKey?: string
  parentIndex?: number
  index?: number
}

async function plexSectionsOfType(conn: PlexConnection, type: 'movie' | 'show'): Promise<string[]> {
  const data = await plexGet<{ MediaContainer?: { Directory?: Array<{ key?: string; type?: string }> } }>(conn, '/library/sections')
  return (data?.MediaContainer?.Directory ?? [])
    .filter((d) => d.type === type && d.key)
    .map((d) => String(d.key))
}

export async function plexMoviePool(): Promise<TvMediaItem[]> {
  return cachedPool('plex-movies', async () => {
    const conn = await getPlexConnection()
    if (!conn) return []
    const items: TvMediaItem[] = []
    for (const key of await plexSectionsOfType(conn, 'movie')) {
      const data = await plexGet<{ MediaContainer?: { Metadata?: PlexListMeta[] } }>(
        conn, `/library/sections/${encodeURIComponent(key)}/all?X-Plex-Container-Size=1000&X-Plex-Container-Start=0`)
      for (const m of data?.MediaContainer?.Metadata ?? []) {
        if (!m.ratingKey || !m.duration) continue
        items.push({
          payload: { src: 'plex', ratingKey: String(m.ratingKey), durationMs: m.duration, thumb: m.thumb ?? null },
          title: m.title ?? 'Movie',
          subtitle: m.year ? String(m.year) : null,
          art: m.thumb ?? null,
          durationMs: m.duration,
        })
      }
    }
    return items
  })
}

export interface TvEpisodeItem extends TvMediaItem {
  showKey: string
  showTitle: string
  season: number
  episode: number
}

export async function plexEpisodePool(): Promise<TvEpisodeItem[]> {
  const items = await cachedPool('plex-episodes', async () => {
    const conn = await getPlexConnection()
    if (!conn) return []
    const out: TvEpisodeItem[] = []
    for (const key of await plexSectionsOfType(conn, 'show')) {
      // type=4 = episodes; durations and show rollup fields come back in the listing.
      const data = await plexGet<{ MediaContainer?: { Metadata?: PlexListMeta[] } }>(
        conn, `/library/sections/${encodeURIComponent(key)}/all?type=4&X-Plex-Container-Size=3000&X-Plex-Container-Start=0`)
      for (const m of data?.MediaContainer?.Metadata ?? []) {
        if (!m.ratingKey || !m.duration || !m.grandparentRatingKey) continue
        const season = Number(m.parentIndex ?? 0)
        const episode = Number(m.index ?? 0)
        out.push({
          payload: { src: 'plex', ratingKey: String(m.ratingKey), durationMs: m.duration, thumb: m.grandparentThumb ?? m.thumb ?? null },
          title: m.grandparentTitle ?? 'Episode',
          subtitle: m.title ? `S${season}E${episode} ${m.title}` : `S${season}E${episode}`,
          art: m.grandparentThumb ?? m.thumb ?? null,
          durationMs: m.duration,
          showKey: String(m.grandparentRatingKey),
          showTitle: m.grandparentTitle ?? 'Show',
          season,
          episode,
        })
      }
    }
    return out
  })
  return items as TvEpisodeItem[]
}

// ── YouTube ──────────────────────────────────────────────────────────────────────

function ytItemToMedia(v: { videoId: string; title: string; author?: string | null; durationSec: number; thumbnailUrl?: string | null }): TvMediaItem {
  return {
    payload: { src: 'youtube', videoId: v.videoId, durationSec: v.durationSec, thumb: v.thumbnailUrl ?? null },
    title: v.title,
    subtitle: v.author ?? null,
    art: v.thumbnailUrl ?? `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    durationMs: v.durationSec * 1000,
  }
}

export async function youtubeFeedPool(minSec = 240, maxSec = 0): Promise<TvMediaItem[]> {
  return cachedPool(`yt-feed-${minSec}-${maxSec}`, async () => {
    const rows = await db.select().from(ytVideos)
      .where(isNotNull(ytVideos.durationSec))
      .orderBy(desc(ytVideos.publishedAt))
      .limit(400)
    return rows
      .filter((r) => r.tab !== 'shorts')
      .filter((r) => (r.durationSec ?? 0) >= minSec && (maxSec === 0 || (r.durationSec ?? 0) <= maxSec))
      .map((r) => ytItemToMedia({ videoId: r.videoId, title: r.title, author: r.author, durationSec: r.durationSec ?? 600, thumbnailUrl: r.thumbnailUrl }))
  })
}

export async function youtubeSearchPool(queries: string[], minSec: number, maxSec: number): Promise<TvMediaItem[]> {
  return cachedPool(`yt-search-${queries.join('~')}`, async () => {
    const out: TvMediaItem[] = []
    for (const q of queries) {
      const page = await tryInnertube('tvSearch',
        () => innertubeSearch(q, 36, 0, 8000, 0, SEARCH_FILTERS.videos, true),
        { videos: [] as ItVideo[], channels: [], playlists: [], continuation: null })
      for (const v of page.videos) {
        const dur = v.durationSec ?? 0
        if (dur < Math.max(minSec, 91)) continue
        if (maxSec > 0 && dur > maxSec) continue
        out.push(ytItemToMedia({ videoId: v.videoId, title: v.title, author: v.author, durationSec: dur, thumbnailUrl: v.thumbnailUrl }))
      }
    }
    return out
  })
}

// ── Podcasts ─────────────────────────────────────────────────────────────────────

export async function podcastPool(aiOnly: boolean): Promise<TvMediaItem[]> {
  return cachedPool(aiOnly ? 'podcasts-ai' : 'podcasts', async () => {
    const rows = await db.select({
      id: podcastEpisodes.id,
      title: podcastEpisodes.title,
      durationSec: podcastEpisodes.durationSec,
      audioRelPath: podcastEpisodes.audioRelPath,
      enclosureUrl: podcastEpisodes.enclosureUrl,
      imageUrl: podcastEpisodes.imageUrl,
      publishedAt: podcastEpisodes.publishedAt,
      showTitle: podcastShows.title,
      showImage: podcastShows.imageUrl,
    })
      .from(podcastEpisodes)
      .innerJoin(podcastShows, eq(podcastEpisodes.showId, podcastShows.id))
      .where(and(eq(podcastEpisodes.status, 'ready')))
      .orderBy(desc(podcastEpisodes.publishedAt))
      .limit(300)
    return rows
      .filter((r) => (aiOnly ? !!r.audioRelPath : !!r.audioRelPath || !!r.enclosureUrl))
      .filter((r) => (r.durationSec ?? 0) >= 120)
      .map((r) => ({
        payload: { src: 'podcast' as const, episodeId: r.id, showTitle: r.showTitle ?? undefined, durationSec: r.durationSec ?? 1800, art: r.imageUrl ?? r.showImage ?? null },
        title: r.showTitle ?? 'Podcast',
        subtitle: r.title,
        art: r.imageUrl ?? r.showImage ?? null,
        durationMs: (r.durationSec ?? 1800) * 1000,
      }))
  })
}

// ── Live radio (household-wide pool: any saved station, played per-user) ─────────

export async function liveRadioStationCount(): Promise<number> {
  const rows = await db.select({ id: musicRadioStations.id }).from(musicRadioStations).limit(1)
  return rows.length
}

// ── Frigate ──────────────────────────────────────────────────────────────────────

export async function frigateCameraList(): Promise<string[]> {
  const cfg = await getFrigateConfig()
  if (!cfg.enabled || !cfg.baseUrl) return []
  try {
    const r = await fetch(`${cfg.baseUrl}/api/config`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return []
    const config = await r.json() as { cameras?: Record<string, unknown> }
    return Object.keys(config.cameras ?? {})
  } catch {
    return []
  }
}
