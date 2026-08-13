// React Query cache persistence (IndexedDB). Restores the warmed cache on a fresh load /
// sleep-wake reload so pinned-app content paints instantly, then revalidates in the
// background. Wired in main.tsx via PersistQueryClientProvider.
//
// SCOPE: public/shared content, plus the per-user YouTube home queries. Persisting
// per-user data is safe because the store can never carry across profiles: it is wiped on
// logout (clearPersistedCache, called from AuthContext) AND whenever the authenticated
// user id changes without a logout (AuthContext's cache-owner guard covers the
// session-expired-then-different-profile-signs-in path). Do not add a per-user query root
// here without confirming both wipes still hold.

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
  // Per-user YouTube home data: without these, a reopened phone app rendered Popular and
  // Trending instantly (persisted above) while the subscriptions rail and Latest grid sat
  // on skeletons waiting for the network - the top of the page loading LAST. Guarded by
  // the owner-change wipe (see SCOPE above).
  'yt-feed',
  'yt-subs',
  'yt-downloads',
  'yt-history',
  'yt-recommended',
])

// Bump CACHE_VERSION whenever a persisted query's response SHAPE changes, so old payloads
// are discarded on next load instead of rehydrated into a renderer that expects the new shape.
const CACHE_VERSION = 'v8' // v8: per-user YouTube home queries added (feed/subs/downloads/history/recommended)

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
