import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '@/context/AuthContext'

export type ThemeMode = 'light' | 'dark' | 'auto'

interface ThemeContextValue {
  theme: ThemeMode
  effectiveTheme: 'light' | 'dark'
  setTheme: (t: ThemeMode) => void
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

  // Keep <html data-theme> and the ld-theme cookie in sync
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme)
    setCookie(effectiveTheme)
  }, [effectiveTheme])

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

  return (
    <ThemeContext.Provider value={{ theme, effectiveTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
