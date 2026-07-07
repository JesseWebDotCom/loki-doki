import { useState, useEffect, useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'
import type { CardListView } from '@/components/shared/ViewToggle'

// Per-user, DB-persisted card/list view toggle for a page. Seeds from the shared
// preferences query once it resolves, then writes the choice back under `key`
// (e.g. "youtube.channel_view") so it sticks across visits and devices. Mirrors
// the useNavPreferences read-seed-then-PATCH pattern; no debounce since the user
// only clicks a toggle occasionally.
export function useViewPreference(key: string, fallback: CardListView = 'grid') {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const prefsQuery = useUserPreferences()
  const [view, setViewState] = useState<CardListView>(fallback)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    if (prefsQuery.data === undefined && !prefsQuery.isError) return // still loading
    const saved = (prefsQuery.data ?? {})[key]
    if (saved === 'grid' || saved === 'list' || saved === 'big') setViewState(saved)
    loadedRef.current = true
  }, [prefsQuery.data, prefsQuery.isError, key])

  const setView = useCallback((next: CardListView) => {
    setViewState(next)
    const userId = user?.id
    if (!userId) return
    patchUserPreferencesCache(queryClient, userId, { [key]: next })
    fetch(`/api/users/${userId}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: next }),
    })
  }, [user?.id, queryClient, key])

  return [view, setView] as const
}
