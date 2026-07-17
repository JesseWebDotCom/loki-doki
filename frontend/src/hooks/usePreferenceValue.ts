import { useState, useEffect, useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'

// Generic per-user, DB-persisted preference value (string / number / boolean), the
// non-view sibling of useViewPreference. Seeds from the shared preferences query once
// it resolves, then writes changes back under `key` via the standard PATCH +
// patchUserPreferencesCache pattern so the choice sticks across visits and devices.
export function usePreferenceValue<T extends string | number | boolean>(
  key: string,
  fallback: T,
): [T, (next: T) => void] {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const prefsQuery = useUserPreferences()
  const [value, setValueState] = useState<T>(fallback)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    if (prefsQuery.data === undefined && !prefsQuery.isError) return // still loading
    const saved = (prefsQuery.data ?? {})[key]
    if (typeof saved === typeof fallback) setValueState(saved as T)
    loadedRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsQuery.data, prefsQuery.isError, key])

  const setValue = useCallback((next: T) => {
    setValueState(next)
    loadedRef.current = true // a manual change always wins over a late pref load
    const userId = user?.id
    if (!userId) return
    patchUserPreferencesCache(queryClient, userId, { [key]: next })
    void fetch(`/api/users/${userId}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: next }),
    }).catch(() => {})
  }, [user?.id, queryClient, key])

  return [value, setValue]
}
