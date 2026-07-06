// Shared view-model for cards/shelves across the YouTube app, plus adapters from the
// various API row shapes into it.

import type { FeedVideo, SavedRow, SearchResult, ItVideo, HistoryRow } from './api'

export interface VideoItem {
  videoId: string
  title: string
  author?: string | null
  channelId?: string | null
  channelThumb?: string | null
  publishedAt?: number | null
  ageLabel?: string               // pre-formatted relative age (e.g. search's "11 months ago")
  views?: string | null           // raw view-count text (formatted for display via fmtViews)
  durationSec?: number | null
  watch?: { positionSec: number; completed: boolean } | null
  localKind?: 'audio' | 'video'   // present ⇒ available offline (play local file)
  qualityBadge?: string           // offline only
  enhance?: 'enhancing' | 'enhanced' | null   // offline video: background enhancement state
}

export const SHORT_MAX_SEC = 60
export const isShort = (i: VideoItem) =>
  i.durationSec != null && i.durationSec > 0 && i.durationSec <= SHORT_MAX_SEC

/** Watch progress 0..1 for the card's red bar (0 when none / finished). */
export const watchProgress = (i: VideoItem) =>
  i.watch && !i.watch.completed && i.durationSec ? Math.min(1, i.watch.positionSec / i.durationSec) : 0

export const channelKey = (author: string | null | undefined) => (author?.trim() || 'Unknown')

export function feedToItem(v: FeedVideo, durationFallback?: number | null): VideoItem {
  return {
    videoId: v.videoId, title: v.title, author: v.author, channelId: v.channelId,
    channelThumb: v.channelThumb, publishedAt: v.publishedAt,
    durationSec: v.durationSec ?? durationFallback ?? null,
    views: v.views,
    watch: v.watchState,
  }
}

export function savedToItem(r: SavedRow, qualityBadge: string): VideoItem {
  return {
    videoId: r.videoId, title: r.title || r.videoId, author: r.author, channelId: r.channelId,
    channelThumb: r.channelThumb ?? null,
    publishedAt: r.publishedAt, durationSec: r.durationSec ?? null, views: r.views,
    watch: r.positionSec != null ? { positionSec: r.positionSec, completed: !!r.completed } : null,
    localKind: r.kind, qualityBadge, enhance: r.enhance,
  }
}

/** Watch-history row → card view-model (carries resume progress). */
export function historyToItem(h: HistoryRow): VideoItem {
  return {
    videoId: h.videoId, title: h.title, author: h.author, channelId: h.channelId,
    channelThumb: h.channelThumb, durationSec: h.durationSec, views: h.views,
    watch: { positionSec: h.positionSec, completed: h.completed },
  }
}

/** InnerTube video (trending / channel / related) → card view-model. */
export function itToItem(v: ItVideo): VideoItem {
  return {
    videoId: v.videoId,
    title: v.title,
    author: v.author ?? null,
    channelId: v.channelId ?? null,
    channelThumb: v.channelThumb ?? null,
    durationSec: v.durationSec ?? null,
    ageLabel: v.publishedText ?? undefined,
    views: v.views ?? null,
  }
}

export function searchToItem(v: SearchResult): VideoItem {
  return {
    videoId: v.videoId,
    title: v.title,
    author: v.author ?? null,
    channelId: v.channelId ?? null,
    channelThumb: v.channelThumb ?? null,
    durationSec: v.durationSec ?? null,
    ageLabel: v.publishedText ?? undefined,
    views: v.views ?? null,
  }
}
