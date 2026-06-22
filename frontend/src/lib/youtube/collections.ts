// Video collections (Watch Later, Liked). The server is the source of truth (so they
// sync across devices), but we mirror them into localStorage for instant, synchronous
// rendering and optimistic toggles. On load we hydrate from the server; every mutation
// updates localStorage immediately and pushes to the server in the background.

import { getCollections, putCollection, removeCollection } from './api'

export interface SavedVideoMeta {
  videoId: string
  title: string
  author?: string | null
  channelId?: string | null
  durationSec?: number | null
  addedAt: number
}

export type CollectionKey = 'watch-later' | 'liked'

const storageKey = (k: CollectionKey) => `yt.collection.${k}`
const EVENT = 'yt-collection-change'

function read(k: CollectionKey): SavedVideoMeta[] {
  try {
    const raw = localStorage.getItem(storageKey(k))
    return raw ? (JSON.parse(raw) as SavedVideoMeta[]) : []
  } catch { return [] }
}

function write(k: CollectionKey, items: SavedVideoMeta[]) {
  try { localStorage.setItem(storageKey(k), JSON.stringify(items)) } catch { /* quota */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { key: k } }))
}

export function getCollection(k: CollectionKey): SavedVideoMeta[] {
  return read(k).sort((a, b) => b.addedAt - a.addedAt)
}

export function inCollection(k: CollectionKey, videoId: string): boolean {
  return read(k).some(v => v.videoId === videoId)
}

export function toggleCollection(k: CollectionKey, meta: Omit<SavedVideoMeta, 'addedAt'>): boolean {
  const items = read(k)
  const idx = items.findIndex(v => v.videoId === meta.videoId)
  if (idx >= 0) {
    items.splice(idx, 1); write(k, items)
    void removeCollection(k, meta.videoId)
    return false
  }
  items.push({ ...meta, addedAt: Date.now() })
  write(k, items)
  void putCollection(k, meta.videoId, { title: meta.title, author: meta.author, channelId: meta.channelId, durationSec: meta.durationSec })
  return true
}

export function removeFromCollection(k: CollectionKey, videoId: string) {
  write(k, read(k).filter(v => v.videoId !== videoId))
  void removeCollection(k, videoId)
}

// Pull server state into localStorage (server wins). Called once on app load; the
// resulting writes fire the change event so any mounted hooks re-render.
let _hydrated = false
export async function hydrateCollections(): Promise<void> {
  if (_hydrated) return
  _hydrated = true
  try {
    const server = await getCollections()
    for (const k of ['watch-later', 'liked'] as CollectionKey[]) {
      const rows = server[k] ?? []
      write(k, rows.map(r => ({
        videoId: r.videoId, title: r.title, author: r.author, channelId: r.channelId,
        durationSec: r.durationSec, addedAt: r.addedAt || Date.now(),
      })))
    }
  } catch { _hydrated = false /* allow retry */ }
}

export { EVENT as COLLECTION_EVENT }

// ── React binding ────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'

/** Subscribe a component to a collection; re-renders on add/remove (any source). */
export function useCollection(k: CollectionKey): SavedVideoMeta[] {
  const [items, setItems] = useState<SavedVideoMeta[]>(() => getCollection(k))
  useEffect(() => {
    const refresh = () => setItems(getCollection(k))
    const onChange = (e: Event) => { if ((e as CustomEvent).detail?.key === k) refresh() }
    window.addEventListener(EVENT, onChange)
    window.addEventListener('storage', refresh)
    refresh()
    return () => { window.removeEventListener(EVENT, onChange); window.removeEventListener('storage', refresh) }
  }, [k])
  return items
}

