// A tiny module-level store of "what's in my library, keyed by source:sourceRef",
// so any storefront tile/card can render the right Save/Download/Offline state
// (and mutate it) without threading props through every shelf. Loaded once on
// first use and shared across all subscribers; mutators update it optimistically
// and notify so every tile for the same item stays in sync.

import { useSyncExternalStore } from 'react'
import {
  saveBook, downloadBook, downloadBookOffline, listLibraryIndex,
  type BookSearchResult, type BookLibraryStatus,
} from './api'

export interface LibraryEntry { bookId: string; status: BookLibraryStatus }

const entries = new Map<string, LibraryEntry>()
const listeners = new Set<() => void>()
let loadState: 'idle' | 'loading' | 'loaded' = 'idle'

function keyFor(source: string, sourceRef: string): string {
  return `${source}:${sourceRef}`
}

function emit() {
  for (const l of listeners) l()
}

async function ensureLoaded(): Promise<void> {
  if (loadState !== 'idle') return
  loadState = 'loading'
  try {
    const list = await listLibraryIndex()
    for (const e of list) entries.set(keyFor(e.source, e.sourceRef), { bookId: e.bookId, status: e.status })
    loadState = 'loaded'
    emit()
  } catch {
    loadState = 'idle' // allow a retry on the next mount
  }
}

/** Force a re-fetch of the index (e.g. after the Library page mutates state). */
export async function refreshLibraryIndex(): Promise<void> {
  loadState = 'idle'
  await ensureLoaded()
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

export async function saveResult(result: BookSearchResult): Promise<void> {
  const key = keyFor(result.source, result.sourceRef)
  const { bookId } = await saveBook(result)
  entries.set(key, { bookId, status: 'saved' })
  emit()
}

/** Download offline directly from a search hit (Save + Download in one). */
export async function downloadResult(result: BookSearchResult): Promise<void> {
  const key = keyFor(result.source, result.sourceRef)
  const { bookId } = await downloadBook(result)
  entries.set(key, { bookId, status: 'pending' })
  emit()
}

/** Download offline an item that's already saved (we know its bookId). */
export async function downloadSaved(source: string, sourceRef: string, bookId: string): Promise<void> {
  const key = keyFor(source, sourceRef)
  await downloadBookOffline(bookId)
  entries.set(key, { bookId, status: 'pending' })
  emit()
}
