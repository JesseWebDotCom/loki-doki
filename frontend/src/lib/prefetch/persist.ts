// React Query cache persistence (IndexedDB). Restores the warmed cache on a fresh load /
// sleep-wake reload so pinned-app content paints instantly, then revalidates in the
// background. Wired in main.tsx via PersistQueryClientProvider.
//
// SCOPE: only PUBLIC / shared content is persisted — never user-specific data
// (subscriptions, history, watchlist, preferences). This keeps the store tiny AND means a
// profile switch can never surface another user's private data from disk. We also wipe the
// store on logout (clearPersistedCache, called from AuthContext).

import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client'
import { get, set, del } from 'idb-keyval'

const IDB_KEY = 'lokidoki-query-cache'

// First-segment of the query keys we persist. Anything not listed here stays in-memory only.
const PERSIST_KEY_ROOTS = new Set<string>([
  'news-categories',
  'news',
  'shows-home',
  'yt-popular',
  'yt-trending',
  'where-to-watch',
])

// Bump CACHE_VERSION whenever a persisted query's response SHAPE changes, so old payloads
// are discarded on next load instead of rehydrated into a renderer that expects the new shape.
const CACHE_VERSION = 'v7' // v7: og:image enrichment falls back to the page's largest <img> when no og:image/twitter:image meta exists at all

const persister = createAsyncStoragePersister({
  key: IDB_KEY,
  throttleTime: 1000,
  storage: {
    getItem: async (k) => (await get<string>(k)) ?? null,
    setItem: (k, v) => set(k, v),
    removeItem: (k) => del(k),
  },
})

// `query` is inferred from the expected type (via `satisfies`) so we don't import the
// `Query` type — the persist packages resolve a different query-core copy than
// @tanstack/react-query, and naming the type directly trips a spurious skew error.
export const persistOptions = {
  persister,
  maxAge: 24 * 60 * 60_000, // 24h
  buster: CACHE_VERSION,
  dehydrateOptions: {
    shouldDehydrateQuery: (query) => {
      if (query.state.status !== 'success') return false
      const root = query.queryKey[0]
      return typeof root === 'string' && PERSIST_KEY_ROOTS.has(root)
    },
  },
} satisfies Omit<PersistQueryClientOptions, 'queryClient'>

/** Wipe the persisted cache from disk — call on logout / profile switch. */
export async function clearPersistedCache(): Promise<void> {
  try {
    await del(IDB_KEY)
  } catch {
    /* best-effort */
  }
}
