// A tiny module-level store of "what's in my library, keyed by source:sourceRef",
// so any storefront tile/card can render the right Save/Save-offline/Offline state
// (and mutate it) without threading props through every shelf. Loaded once on
// first use and shared across all subscribers; mutators update it optimistically
// and notify so every tile for the same item stays in sync. While anything is
// pending/downloading the index re-polls every 4s (same convention as Videos'
// useYtDownloads / Music's useOfflineStations) so spinners resolve to
// ready/failed and mid-download entries carry a byte-progress fraction.

import { useSyncExternalStore } from 'react'
import {
  saveBook, downloadBook, downloadBookOffline, listLibraryIndex,
  type BookSearchResult, type BookLibraryStatus,
} from './api'

export interface LibraryEntry { bookId: string; status: BookLibraryStatus; progress?: number | null }

const POLL_MS = 4000

const entries = new Map<string, LibraryEntry>()
const listeners = new Set<() => void>()
let loadState: 'idle' | 'loading' | 'loaded' = 'idle'
let mustRequest = false
let pollTimer: ReturnType<typeof setTimeout> | null = null

function keyFor(source: string, sourceRef: string): string {
  return `${source}:${sourceRef}`
}

function emit() {
  for (const l of listeners) l()
}

function hasActiveDownload(): boolean {
  for (const e of entries.values()) if (e.status === 'pending' || e.status === 'downloading') return true
  return false
}

function schedulePoll() {
  if (pollTimer || !hasActiveDownload()) return
  pollTimer = setTimeout(() => {
    pollTimer = null
    void refreshLibraryIndex()
  }, POLL_MS)
}

async function ensureLoaded(): Promise<void> {
  if (loadState !== 'idle') return
  loadState = 'loading'
  try {
    const { entries: list, mustRequest: mr } = await listLibraryIndex()
    for (const e of list) entries.set(keyFor(e.source, e.sourceRef), { bookId: e.bookId, status: e.status, progress: e.progress })
    mustRequest = mr
    loadState = 'loaded'
    emit()
    schedulePoll()
  } catch {
    loadState = 'idle' // allow a retry on the next mount
  }
}

/** Force a re-fetch of the index (e.g. after the Library page mutates state). */
export async function refreshLibraryIndex(): Promise<void> {
  try {
    const { entries: list, mustRequest: mr } = await listLibraryIndex()
    entries.clear()
    for (const e of list) entries.set(keyFor(e.source, e.sourceRef), { bookId: e.bookId, status: e.status, progress: e.progress })
    mustRequest = mr
    loadState = 'loaded'
    emit()
  } catch { /* transient failures just retry on the next poll */ }
  schedulePoll()
}

/** Subscribe a tile/card to the library state for one search result. Returns the
 *  current entry (or undefined if not in the library). */
export function useLibraryEntry(source: string, sourceRef: string): LibraryEntry | undefined {
  const key = keyFor(source, sourceRef)
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      void ensureLoaded()
      return () => listeners.delete(cb)
    },
    () => entries.get(key),
    () => entries.get(key),
  )
}

/** Whether this profile's downloads become admin-approval requests (kid-safe).
 *  Used to hide the "Download to this device" action, which can't be approved. */
export function useMustRequestDownloads(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      void ensureLoaded()
      return () => listeners.delete(cb)
    },
    () => mustRequest,
    () => mustRequest,
  )
}

export async function saveResult(result: BookSearchResult): Promise<void> {
  const key = keyFor(result.source, result.sourceRef)
  const { bookId } = await saveBook(result)
  entries.set(key, { bookId, status: 'saved' })
  emit()
}

/** Save offline directly from a search hit (Save + download in one). Returns
 *  whether it became an approval request (kid-safe profile) instead of a download. */
export async function downloadResult(result: BookSearchResult): Promise<{ requested: boolean }> {
  const key = keyFor(result.source, result.sourceRef)
  const { bookId, requested } = await downloadBook(result)
  entries.set(key, { bookId, status: requested ? 'requested' : 'pending' })
  emit()
  schedulePoll()
  return { requested: Boolean(requested) }
}

/** Save offline an item that's already saved (we know its bookId). Returns
 *  whether it became an approval request instead. */
export async function downloadSaved(source: string, sourceRef: string, bookId: string): Promise<{ requested: boolean }> {
  const key = keyFor(source, sourceRef)
  const { requested } = await downloadBookOffline(bookId)
  entries.set(key, { bookId, status: requested ? 'requested' : 'pending' })
  emit()
  schedulePoll()
  return { requested: Boolean(requested) }
}
