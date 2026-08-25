// Persistent client-side store for proxied card art (/api/img, /api/youtube/img).
//
// Why this exists when sw.js already has a cache-first image store: service workers (and
// the Cache API) require a secure context, and phones on the LAN reach the hub over plain
// http://<ip>:3000. So on exactly the devices with the slowest networks the SW never
// installs, and card art depended on the browser's HTTP cache, which iOS evicts
// aggressively for installed PWAs. Thumbnails and channel logos went cold between app
// opens and re-downloaded every session. IndexedDB has no secure-context requirement,
// so this store gives those devices the same "seen once, cached for weeks" behaviour.
//
// Shape: one object store keyed by proxy URL (path + query) holding
// { url, blob, storedAt, lastUsed }. Reads hand back an object URL; writes happen after
// the network <img> finishes loading (re-fetched with cache: 'force-cache', so the bytes
// come out of the HTTP cache, not the wire). When a service worker DOES control the page
// (https/localhost prod), this store stays inert: sw.js already owns image caching and a
// second copy would just double the disk footprint.

import { useEffect, useState } from 'react'

const DB_NAME = 'maipai-home-img'
const STORE = 'images'
/** Entry ceiling, pruned oldest-lastUsed-first. Card art is a few KB to a few tens of KB,
 *  so this is a modest store that still covers many screens of feed. */
const MAX_ENTRIES = 600
const PRUNE_EVERY = 25
/** YouTube thumbnails are immutable per video id; a month matches the server's lifetime. */
const TTL_YT_MS = 30 * 86_400_000
/** Generic proxied art (hub thumbnails, remote avatars) matches /api/img's 7-day lifetime. */
const TTL_GENERIC_MS = 7 * 86_400_000
/** Touch lastUsed at most daily: a touch rewrites the whole record (blob included). */
const TOUCH_MS = 86_400_000

interface StoredImage {
  url: string
  blob: Blob
  storedAt: number
  lastUsed: number
}

// Mirrors sw.js IMG_PATHS: the two read-through proxies whose URLs are stable, long-lived
// keys (pure functions of upstream url + fixed width; see lib/prefetch/cardImageUrls).
const IMG_PATHS = ['/api/img', '/api/youtube/img']

/** Same-origin proxy URL → storage key (path + query), or null when not ours to cache. */
function normalizeKey(url: string): string | null {
  try {
    const u = new URL(url, window.location.origin)
    if (u.origin !== window.location.origin) return null
    if (!IMG_PATHS.includes(u.pathname)) return null
    return u.pathname + u.search
  } catch {
    return null
  }
}

function ttlFor(key: string): number {
  return key.startsWith('/api/youtube/img') ? TTL_YT_MS : TTL_GENERIC_MS
}

function storeAvailable(): boolean {
  if (typeof indexedDB === 'undefined') return false
  // A controlling service worker means sw.js's cache-first image store is doing this job.
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) return false
  return true
}

function reqProm<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

let dbPromise: Promise<IDBDatabase> | null = null
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'url' })
        store.createIndex('lastUsed', 'lastUsed')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    // A failed open (private-mode quirks, storage pressure) should not poison the session:
    // clear the memo so a later call can retry.
    dbPromise.catch(() => { dbPromise = null })
  }
  return dbPromise
}

function putEntry(db: IDBDatabase, entry: StoredImage): Promise<IDBValidKey> {
  return reqProm(db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry))
}

function deleteEntry(db: IDBDatabase, key: string): Promise<undefined> {
  return reqProm(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key))
}

async function prune(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const count = await reqProm(store.count())
  let excess = count - MAX_ENTRIES
  if (excess <= 0) return
  // The lastUsed index cursor walks oldest-first, so this drops the least recently seen.
  await new Promise<void>((resolve) => {
    const cursorReq = store.index('lastUsed').openCursor()
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor || excess <= 0) { resolve(); return }
      cursor.delete()
      excess--
      cursor.continue()
    }
    cursorReq.onerror = () => resolve()
  })
}

// Session memo of already-materialized object URLs: a re-mounted card paints its cached
// art on the FIRST render (no async flash), and 40 cards sharing one channel logo share
// one blob URL instead of minting 40.
const objectUrls = new Map<string, string>()
const MEMO_MAX = 500
const pending = new Map<string, Promise<string | null>>()
/** Keys whose persist fetch was already kicked off this session (dedupe, not a cache). */
const persisted = new Set<string>()
let putsSincePrune = 0

function memoize(key: string, objUrl: string): void {
  if (objectUrls.size >= MEMO_MAX) {
    // FIFO-evict the oldest memo. Revoking is safe for already-painted <img>s (the decoded
    // bitmap survives); a later re-mount that trips on the dead URL recovers via the
    // hook's recover() fallback to the network.
    const oldest = objectUrls.keys().next().value
    if (oldest !== undefined) {
      URL.revokeObjectURL(objectUrls.get(oldest)!)
      objectUrls.delete(oldest)
    }
  }
  objectUrls.set(key, objUrl)
}

async function lookup(key: string): Promise<string | null> {
  try {
    const db = await openDb()
    const entry = await reqProm<StoredImage | undefined>(db.transaction(STORE).objectStore(STORE).get(key))
    if (!entry) return null
    const now = Date.now()
    if (now - entry.storedAt > ttlFor(key)) {
      // Expired: drop it and let the network path store a fresh copy after it loads.
      void deleteEntry(db, key).catch(() => {})
      return null
    }
    if (now - entry.lastUsed > TOUCH_MS) {
      void putEntry(db, { ...entry, lastUsed: now }).catch(() => {})
    }
    const objUrl = URL.createObjectURL(entry.blob)
    memoize(key, objUrl)
    return objUrl
  } catch {
    return null
  }
}

/** Bulk-load the most recently used stored images into the session memo at boot. Without
 *  this, every image on the first screen pays its own async IndexedDB round trip before
 *  `useCachedImg` can hand back a src - cards briefly rendered art-less and popped in one
 *  by one. Primed entries resolve SYNCHRONOUSLY on the first render instead. Call once,
 *  early (AppShell mount); no-ops when a service worker owns image caching. */
const PRIME_LIMIT = 200
let primed = false
export function primeImageStore(): void {
  if (primed || !storeAvailable()) return
  primed = true
  void (async () => {
    try {
      const db = await openDb()
      await new Promise<void>((resolve) => {
        let loaded = 0
        // lastUsed index walked newest-first: the art most likely to be on screen again.
        const cursorReq = db.transaction(STORE).objectStore(STORE).index('lastUsed').openCursor(null, 'prev')
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor || loaded >= PRIME_LIMIT) { resolve(); return }
          const entry = cursor.value as StoredImage
          if (!objectUrls.has(entry.url) && Date.now() - entry.storedAt <= ttlFor(entry.url)) {
            memoize(entry.url, URL.createObjectURL(entry.blob))
            loaded++
          }
          cursor.continue()
        }
        cursorReq.onerror = () => resolve()
      })
    } catch { /* store unavailable - lookups fall back to per-image reads */ }
  })()
}

/** Object URL for a stored copy of this proxied image, or null (miss/expired/inactive). */
export function getStoredImageUrl(url: string): Promise<string | null> {
  const key = normalizeKey(url)
  if (!key || !storeAvailable()) return Promise.resolve(null)
  const memo = objectUrls.get(key)
  if (memo) return Promise.resolve(memo)
  let p = pending.get(key)
  if (!p) {
    p = lookup(key).finally(() => pending.delete(key))
    pending.set(key, p)
  }
  return p
}

/** True when a fresh stored copy exists - lets the scroll-ahead warmer skip URLs that
 *  will paint from IndexedDB anyway instead of spending slow-network bandwidth on them. */
export async function hasStoredImage(url: string): Promise<boolean> {
  const key = normalizeKey(url)
  if (!key || !storeAvailable()) return false
  if (objectUrls.has(key) || persisted.has(key)) return true
  try {
    const db = await openDb()
    const entry = await reqProm<StoredImage | undefined>(db.transaction(STORE).objectStore(STORE).get(key))
    return !!entry && Date.now() - entry.storedAt <= ttlFor(key)
  } catch {
    return false
  }
}

/** Store a copy of an image the page just rendered. Fire-and-forget; called from the
 *  <img>'s onLoad, so the force-cache re-fetch is served from the HTTP cache. */
export function persistImage(url: string): void {
  const key = normalizeKey(url)
  if (!key || !storeAvailable()) return
  if (persisted.has(key) || objectUrls.has(key)) return
  persisted.add(key)
  void (async () => {
    try {
      const res = await fetch(key, { cache: 'force-cache' })
      // Only full 200 image bodies: a 401/404/error page must never get pinned as art.
      if (!res.ok || res.status !== 200) return
      if (!(res.headers.get('content-type') ?? '').startsWith('image/')) return
      const blob = await res.blob()
      if (!blob.size) return
      const db = await openDb()
      const now = Date.now()
      await putEntry(db, { url: key, blob, storedAt: now, lastUsed: now })
      if (++putsSincePrune >= PRUNE_EVERY) {
        putsSincePrune = 0
        await prune(db)
      }
    } catch {
      persisted.delete(key)
    }
  })()
}

/** Render a proxied image through the persistent store.
 *
 *  Returns the src to render (a stored object URL on a hit, the network URL on a miss,
 *  undefined while the very first lookup is in flight), an onLoad that persists
 *  network-loaded bytes, and recover() for the <img>'s onError: it drops a bad stored
 *  copy and falls back to the network, returning true when it did (callers only run
 *  their own fallback UI when it returns false).
 *
 *  On a src change the previous entry keeps rendering until the new lookup resolves,
 *  preserving the flash-free navigation contract (no key={src} remounts here). */
export function useCachedImg(rawUrl: string | null | undefined): {
  src: string | undefined
  onLoad: (() => void) | undefined
  recover: () => boolean
} {
  const url = rawUrl || null
  const cacheable = url != null && normalizeKey(url) != null && storeAvailable()
  const [entry, setEntry] = useState<{ url: string; src: string } | null>(() => {
    if (!cacheable) return null
    const memo = objectUrls.get(normalizeKey(url)!)
    return memo ? { url, src: memo } : null
  })

  useEffect(() => {
    if (!cacheable || !url) return
    const memo = objectUrls.get(normalizeKey(url)!)
    if (memo) {
      setEntry((cur) => (cur && cur.url === url && cur.src === memo ? cur : { url, src: memo }))
      return
    }
    let dead = false
    void getStoredImageUrl(url).then((stored) => {
      if (!dead) setEntry({ url, src: stored ?? url })
    })
    return () => { dead = true }
  }, [url, cacheable])

  if (!cacheable) return { src: url ?? undefined, onLoad: undefined, recover: () => false }
  const isNetwork = entry != null && entry.url === url && entry.src === url
  return {
    src: entry?.src,
    onLoad: isNetwork ? () => persistImage(url) : undefined,
    recover: () => {
      if (!entry || entry.url !== url || entry.src === url) return false
      // The stored object URL failed to render (revoked memo, corrupt blob): drop the
      // stored copy and retry over the network.
      const key = normalizeKey(url)
      if (key) {
        const memo = objectUrls.get(key)
        if (memo) {
          URL.revokeObjectURL(memo)
          objectUrls.delete(key)
        }
        persisted.delete(key)
        void openDb().then((db) => deleteEntry(db, key)).catch(() => {})
      }
      setEntry({ url, src: url })
      return true
    },
  }
}
