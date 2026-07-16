import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '@/context/AuthContext'
import { applyAccent, isAccentKey } from '@/lib/themePresets'

export type ThemeMode = 'light' | 'dark' | 'auto'

interface ThemeContextValue {
  theme: ThemeMode
  effectiveTheme: 'light' | 'dark'
  setTheme: (t: ThemeMode) => void
  /** Accent preset key (#16), e.g. 'default' | 'blue' | 'emerald'. */
  accent: string
  setAccent: (key: string) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function getOsTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function resolveEffective(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'auto' ? getOsTheme() : mode
}

function setCookie(effective: 'light' | 'dark') {
  document.cookie = `ld-theme=${effective}; path=/; max-age=31536000; SameSite=Lax`
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()

  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const t = localStorage.getItem('theme')
    return t === 'light' || t === 'dark' || t === 'auto' ? t : 'dark'
  })

  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(() =>
    resolveEffective(theme),
  )

  const [accent, setAccentState] = useState<string>(() => {
    const a = localStorage.getItem('accent')
    return isAccentKey(a) ? a : 'default'
  })

  // Keep <html data-theme> and the ld-theme cookie in sync
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme)
    setCookie(effectiveTheme)
  }, [effectiveTheme])

  // Apply the accent token overrides whenever the accent or the effective mode changes
  // (the light/dark override values differ per mode).
  useEffect(() => {
    applyAccent(accent, effectiveTheme)
  }, [accent, effectiveTheme])

  // Load persisted preference from user_preferences on login
  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then(r => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null))
      .then(data => {
        if (!data) return
        const t = data['appearance.theme']
        if (t === 'light' || t === 'dark' || t === 'auto') {
          setThemeState(t)
          localStorage.setItem('theme', t)
          setEffectiveTheme(resolveEffective(t))
        }
        const a = data['appearance.accent']
        if (isAccentKey(a)) {
          setAccentState(a)
          localStorage.setItem('accent', a)
        }
      })
      .catch(() => {})
  }, [user?.id])

  // Re-resolve effective theme when OS preference changes (auto mode)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      setThemeState(prev => {
        if (prev === 'auto') setEffectiveTheme(getOsTheme())
        return prev
      })
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const setTheme = useCallback(
    (t: ThemeMode) => {
      const eff = resolveEffective(t)
      setThemeState(t)
      setEffectiveTheme(eff)
      localStorage.setItem('theme', t)
      if (user?.id) {
        fetch(`/api/users/${user.id}/preferences`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 'appearance.theme': t }),
        }).catch(() => {})
      }
    },
    [user?.id],
  )

  const setAccent = useCallback(
    (key: string) => {
      setAccentState(key)
      localStorage.setItem('accent', key)
      if (user?.id) {
        fetch(`/api/users/${user.id}/preferences`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 'appearance.accent': key }),
        }).catch(() => {})
      }
    },
    [user?.id],
  )

  return (
    <ThemeContext.Provider value={{ theme, effectiveTheme, setTheme, accent, setAccent }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
