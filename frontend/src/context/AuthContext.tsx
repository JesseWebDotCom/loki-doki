import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { clearPersistedCache } from '@/lib/prefetch/persist'
import { clearCachedUserPreferences } from '@/hooks/useUserPreferences'
import { clearCachedHomeLayouts } from '@/lib/homeLayoutCache'

export interface AuthUser {
  id: string
  firstName: string
  lastName: string
  nickname: string
  role: 'admin' | 'user'
  avatarUrl: string | null
  dicebearStyle: string | null
  dicebearSeed: string | null
  dicebearConfig: Record<string, unknown> | null
  hasPin: boolean
}

interface AuthContextValue {
  user: AuthUser | null
  configured: boolean | null       // null = still loading
  firstRunComplete: boolean | null // null = still loading
  welcomeComplete: boolean | null  // null = still loading; offline-content wizard seen
  loading: boolean
  refetch: () => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]                       = useState<AuthUser | null>(null)
  const [configured, setConfigured]           = useState<boolean | null>(null)
  const [firstRunComplete, setFirstRunComplete] = useState<boolean | null>(null)
  const [welcomeComplete, setWelcomeComplete] = useState<boolean | null>(null)
  const [loading, setLoading]                 = useState(true)

  const refetch = useCallback(async () => {
    // Retry up to 10 times with 500ms delay — backend may not be bound yet when
    // the browser opens (Vite and the API server race on cold start).
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const [setupRes, meRes] = await Promise.all([
          fetch('/api/setup/status'),
          fetch('/api/auth/me'),
        ])
        const { configured: isConfigured, firstRunComplete: frc, welcomeComplete: wc } =
          await setupRes.json() as { configured: boolean; firstRunComplete: boolean; welcomeComplete?: boolean }

        setConfigured(isConfigured)
        setFirstRunComplete(frc ?? false)
        setWelcomeComplete(wc ?? false)

        if (meRes.ok) {
          setUser(await meRes.json() as AuthUser)
        } else {
          setUser(null)
        }
        setLoading(false)
        return
      } catch {
        if (attempt < 9) {
          await new Promise<void>(r => setTimeout(r, 500))
        }
      }
    }
    // All retries exhausted — backend unreachable. Keep loading and schedule another
    // attempt; the ServerHealthBanner surfaces "server offline" while the spinner
    // blocks route guards from redirecting to /setup.
    setTimeout(() => { void refetch() }, 3_000)
  }, [])

  const queryClient = useQueryClient()
  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    setUser(null)
    // Drop all cached query data so the next profile doesn't briefly see the previous
    // user's data (query keys aren't user-scoped) — both in-memory and the persisted
    // (IndexedDB) copy that PersistQueryClientProvider would otherwise rehydrate.
    queryClient.clear()
    void clearPersistedCache()
    clearCachedUserPreferences()
    clearCachedHomeLayouts()
  }, [queryClient])

  useEffect(() => { refetch() }, [refetch])

  return (
    <AuthContext.Provider value={{ user, configured, firstRunComplete, welcomeComplete, loading, refetch, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
