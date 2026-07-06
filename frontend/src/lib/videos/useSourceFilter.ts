import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'
import type { VideoSource } from '@/lib/videos/api'

// Per-user, DB-persisted source pill selection for mixed hub surfaces (Home, search,
// Library). Empty selection means "all sources". Mirrors useViewPreference's
// read-seed-then-PATCH pattern under the `videos.sources` key.
const PREF_KEY = 'videos.sources'

export function useSourceFilter() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const prefsQuery = useUserPreferences()
  const [selected, setSelectedState] = useState<VideoSource[]>([])
  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    if (prefsQuery.data === undefined && !prefsQuery.isError) return // still loading
    const saved = (prefsQuery.data ?? {})[PREF_KEY]
    if (Array.isArray(saved)) setSelectedState(saved.filter((s): s is VideoSource => typeof s === 'string') as VideoSource[])
    loadedRef.current = true
  }, [prefsQuery.data, prefsQuery.isError])

  const setSelected = useCallback((next: VideoSource[]) => {
    setSelectedState(next)
    const userId = user?.id
    if (!userId) return
    patchUserPreferencesCache(queryClient, userId, { [PREF_KEY]: next })
    void fetch(`/api/users/${userId}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [PREF_KEY]: next }),
    })
  }, [user?.id, queryClient])

  const toggle = useCallback((source: VideoSource, all: VideoSource[]) => {
    // Selecting from "all on" narrows to just that source; toggling the last one
    // off returns to "all on" (empty = all) so the feed can never go blank.
    const effective = selected.length === 0 ? all : selected
    const next = effective.includes(source)
      ? effective.filter((s) => s !== source)
      : [...effective, source]
    setSelected(next.length === 0 || next.length === all.length ? [] : next)
  }, [selected, setSelected])

  return { selected, toggle, setSelected }
}
