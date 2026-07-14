import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'

export type NewsReaderMode = 'reader' | 'external'

const PREF_KEY = 'news.reader_mode'

// Per-user, DB-persisted choice for what clicking a feed item does: open the in-app
// cached reader ('reader', the default) or jump straight to the original site in a
// new tab ('external'). Reads straight off the shared useUserPreferences query (rather
// than mirroring it into local state, as useViewPreference does) because this hook has
// multiple simultaneous consumers (the News settings menu and the feed list) that must
// all see a toggle flip immediately, not just the instance that made the change.
export function useNewsReaderMode() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const prefsQuery = useUserPreferences()
  const saved = prefsQuery.data?.[PREF_KEY]
  const mode: NewsReaderMode = saved === 'external' ? 'external' : 'reader'

  const setMode = useCallback((next: NewsReaderMode) => {
    const userId = user?.id
    if (!userId) return
    patchUserPreferencesCache(queryClient, userId, { [PREF_KEY]: next })
    fetch(`/api/users/${userId}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [PREF_KEY]: next }),
    })
  }, [user?.id, queryClient])

  return [mode, setMode] as const
}
