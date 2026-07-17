// Client for the podcast player-pack endpoints: server-persisted Up Next queue,
// per-show playback settings, bookmarks, smart episode filters, chapters, OPML,
// and the trim-silence time-saved counter.

import type { PodcastChapter, PodcastTrack } from '@/context/PodcastPlaybackContext'

const J = { 'Content-Type': 'application/json' }
const opts: RequestInit = { credentials: 'include' }

async function jsonOrError<T>(r: Response, fallback: string): Promise<T> {
  const d = await r.json().catch(() => null) as (T & { error?: string }) | null
  if (!r.ok) throw new Error(d?.error || fallback)
  return d as T
}

// ── Queue ──────────────────────────────────────────────────────────────────────────

export interface QueueItem {
  episodeId: string
  showId: string
  showName: string
  title: string
  durationSec: number | null
}

export function queueItemToTrack(item: QueueItem): PodcastTrack {
  return {
    episodeId: item.episodeId,
    showId: item.showId,
    showName: item.showName,
    title: item.title,
    durationSec: item.durationSec ?? undefined,
    coverUrl: `/api/podcasts/shows/${item.showId}/cover`,
  }
}

export async function getQueue(): Promise<QueueItem[]> {
  const r = await fetch('/api/podcasts/queue', opts)
  if (!r.ok) throw new Error('queue')
  return (await r.json() as { items: QueueItem[] }).items ?? []
}

export async function addToQueue(episodeId: string, mode: 'next' | 'last'): Promise<QueueItem[]> {
  const r = await fetch('/api/podcasts/queue', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ episodeId, mode }) })
  const d = await jsonOrError<{ items: QueueItem[] }>(r, 'Could not update the queue.')
  return d.items ?? []
}

export async function replaceQueue(episodeIds: string[]): Promise<QueueItem[]> {
  const r = await fetch('/api/podcasts/queue', { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ episodeIds, replace: true }) })
  const d = await jsonOrError<{ items: QueueItem[] }>(r, 'Could not update the queue.')
  return d.items ?? []
}

export async function reorderQueue(episodeIds: string[]): Promise<QueueItem[]> {
  const r = await fetch('/api/podcasts/queue', { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ episodeIds }) })
  const d = await jsonOrError<{ items: QueueItem[] }>(r, 'Could not reorder the queue.')
  return d.items ?? []
}

export async function removeQueueItem(episodeId: string): Promise<QueueItem[]> {
  const r = await fetch(`/api/podcasts/queue/${episodeId}`, { ...opts, method: 'DELETE' })
  const d = await jsonOrError<{ items: QueueItem[] }>(r, 'Could not update the queue.')
  return d.items ?? []
}

export async function clearQueue(): Promise<void> {
  await fetch('/api/podcasts/queue', { ...opts, method: 'DELETE' })
}

// ── Chapters ───────────────────────────────────────────────────────────────────────

export async function getChapters(episodeId: string): Promise<PodcastChapter[]> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/chapters`, opts)
  if (!r.ok) return []
  return (await r.json() as { chapters?: PodcastChapter[] }).chapters ?? []
}

// ── Per-show playback settings ─────────────────────────────────────────────────────

export interface ShowPlaybackSettings {
  speed: number | null
  skipIntroSec: number
  skipOutroSec: number
  trimSilence: boolean | null   // null = follow the global toggle
  voiceBoost: boolean | null
}

export const DEFAULT_SHOW_SETTINGS: ShowPlaybackSettings = {
  speed: null, skipIntroSec: 0, skipOutroSec: 0, trimSilence: null, voiceBoost: null,
}

export async function getShowSettings(showId: string): Promise<ShowPlaybackSettings> {
  const r = await fetch(`/api/podcasts/shows/${showId}/settings`, opts)
  if (!r.ok) return { ...DEFAULT_SHOW_SETTINGS }
  const d = await r.json() as { settings?: ShowPlaybackSettings | null }
  return d.settings ?? { ...DEFAULT_SHOW_SETTINGS }
}

export async function saveShowSettings(showId: string, settings: ShowPlaybackSettings): Promise<void> {
  const r = await fetch(`/api/podcasts/shows/${showId}/settings`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify(settings) })
  await jsonOrError(r, 'Could not save playback settings.')
}

// ── Bookmarks ──────────────────────────────────────────────────────────────────────

export interface PodcastBookmark {
  id: string
  episodeId: string
  positionSec: number
  note: string | null
  createdAt: string | number
  episodeTitle: string
  durationSec: number | null
  showId: string
  showName: string
}

export async function getBookmarks(filter?: { showId?: string; episodeId?: string }): Promise<PodcastBookmark[]> {
  const params = new URLSearchParams()
  if (filter?.showId) params.set('showId', filter.showId)
  if (filter?.episodeId) params.set('episodeId', filter.episodeId)
  const qs = params.toString()
  const r = await fetch(`/api/podcasts/bookmarks${qs ? `?${qs}` : ''}`, opts)
  if (!r.ok) throw new Error('bookmarks')
  return (await r.json() as { bookmarks: PodcastBookmark[] }).bookmarks ?? []
}

export async function createBookmark(episodeId: string, positionSec: number, note?: string): Promise<void> {
  const r = await fetch('/api/podcasts/bookmarks', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ episodeId, positionSec, note }) })
  await jsonOrError(r, 'Could not save the bookmark.')
}

export async function updateBookmarkNote(id: string, note: string | null): Promise<void> {
  const r = await fetch(`/api/podcasts/bookmarks/${id}`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ note }) })
  await jsonOrError(r, 'Could not update the bookmark.')
}

export async function deleteBookmark(id: string): Promise<void> {
  const r = await fetch(`/api/podcasts/bookmarks/${id}`, { ...opts, method: 'DELETE' })
  await jsonOrError(r, 'Could not delete the bookmark.')
}

// ── Smart episode filters ──────────────────────────────────────────────────────────

export interface FilterRule {
  field: 'unplayed' | 'inProgress' | 'downloaded' | 'duration' | 'show' | 'releasedWithin'
  op?: 'lt' | 'gt' | 'in' | 'is'
  value?: number | string[]
}

export interface FilterRules {
  match: 'all' | 'any'
  rules: FilterRule[]
}

export interface SavedFilter {
  id: string
  name: string
  rules: FilterRules
}

export interface FilterEpisodeResult {
  id: string
  showId: string
  showName: string
  title: string
  description: string | null
  durationSec: number | null
  publishedAt: string | number | null
  generatedAt: string | number | null
  watchState: { positionSec: number; completed: boolean } | null
  download: { status: string; auto: boolean } | null
}

export async function getFilters(): Promise<SavedFilter[]> {
  const r = await fetch('/api/podcasts/filters', opts)
  if (!r.ok) throw new Error('filters')
  return (await r.json() as { filters: SavedFilter[] }).filters ?? []
}

export async function createFilter(name: string, rules: FilterRules): Promise<SavedFilter> {
  const r = await fetch('/api/podcasts/filters', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ name, rules }) })
  const d = await jsonOrError<{ filter: SavedFilter }>(r, 'Could not save the filter.')
  return d.filter
}

export async function updateFilter(id: string, name: string, rules: FilterRules): Promise<void> {
  const r = await fetch(`/api/podcasts/filters/${id}`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ name, rules }) })
  await jsonOrError(r, 'Could not save the filter.')
}

export async function deleteFilter(id: string): Promise<void> {
  const r = await fetch(`/api/podcasts/filters/${id}`, { ...opts, method: 'DELETE' })
  await jsonOrError(r, 'Could not delete the filter.')
}

export async function getFilterEpisodes(id: string): Promise<FilterEpisodeResult[]> {
  const r = await fetch(`/api/podcasts/filters/${id}/episodes`, opts)
  if (!r.ok) throw new Error('filter-episodes')
  return (await r.json() as { episodes: FilterEpisodeResult[] }).episodes ?? []
}

// ── Time saved + OPML ──────────────────────────────────────────────────────────────

export async function getPlayerStats(): Promise<{ timeSavedSec: number }> {
  const r = await fetch('/api/podcasts/player/stats', opts)
  if (!r.ok) return { timeSavedSec: 0 }
  return await r.json() as { timeSavedSec: number }
}

export function reportTimeSaved(seconds: number): void {
  if (seconds < 1) return
  void fetch('/api/podcasts/player/time-saved', {
    ...opts, method: 'POST', headers: J, body: JSON.stringify({ seconds: Math.round(seconds) }),
  }).catch(() => {})
}

export const opmlExportUrl = '/api/podcasts/opml.export'

export interface OpmlImportResult {
  added: string[]
  skipped: string[]
  failed: Array<{ title: string; url: string; error: string }>
}

export async function importOpml(opml: string): Promise<OpmlImportResult> {
  const r = await fetch('/api/podcasts/opml/import', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ opml }) })
  return jsonOrError<OpmlImportResult>(r, 'Could not import the OPML file.')
}
