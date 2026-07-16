import type { HomeLayout } from '@/hooks/useHomeLayout'

// Per-user localStorage cache for the home layout so the home paints the last-known layout
// on a cold load instead of flashing DEFAULT_LAYOUT while /api/home-layout is in flight (#13).
// A leaf module (no React / no AuthContext import) so both useHomeLayout and AuthContext can
// use it without a circular import. Keyed by userId and wiped on logout so a profile switch
// can never surface another user's layout.

const HOME_CACHE_PREFIX = 'ld-home:'

export function readCachedLayout(userId: string): HomeLayout | undefined {
  try {
    const raw = localStorage.getItem(HOME_CACHE_PREFIX + userId)
    return raw ? (JSON.parse(raw) as HomeLayout) : undefined
  } catch { return undefined }
}

export function writeCachedLayout(userId: string, layout: HomeLayout): void {
  try { localStorage.setItem(HOME_CACHE_PREFIX + userId, JSON.stringify(layout)) } catch { /* storage full/unavailable */ }
}

export function removeCachedLayout(userId: string): void {
  try { localStorage.removeItem(HOME_CACHE_PREFIX + userId) } catch { /* ignore */ }
}

/** Call on logout so the next profile's first paint can't show a prior user's home layout. */
export function clearCachedHomeLayouts(): void {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i)
    if (k?.startsWith(HOME_CACHE_PREFIX)) localStorage.removeItem(k)
  }
}
