import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

type PrivacyMode = 'hidden' | 'unlocking' | 'revealed' | 'extended'

interface PrivacySettings {
  enabled: boolean
  timeoutSeconds: number
  hasPin: boolean
}

interface PrivacyContextValue {
  enabled: boolean
  mode: PrivacyMode
  /** Adult content is visible when revealed or extended */
  adultVisible: boolean
  /** Seconds remaining in the revealed countdown (null when extended or hidden) */
  secondsLeft: number | null
  pinError: string | null
  startUnlock: () => void
  cancelUnlock: () => void
  submitPin: (pin: string) => Promise<void>
  extend: () => void
  keepOpen: () => void
  hide: () => void
}

const PrivacyContext = createContext<PrivacyContextValue | null>(null)

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PrivacySettings>({ enabled: true, timeoutSeconds: 30, hasPin: false })
  const [mode, setMode] = useState<PrivacyMode>('hidden')
  const [revealedAt, setRevealedAt] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const [pinError, setPinError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load settings on mount
  useEffect(() => {
    fetch('/api/privacy/settings', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((d: PrivacySettings | null) => { if (d) setSettings(d) })
      .catch(() => {})
  }, [])

  // Countdown timer for revealed mode
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    if (mode !== 'revealed' || revealedAt === null) {
      setSecondsLeft(null)
      return
    }

    const tick = () => {
      const elapsed = Math.floor((Date.now() - revealedAt) / 1000)
      const remaining = Math.max(0, settings.timeoutSeconds - elapsed)
      setSecondsLeft(remaining)
      if (remaining <= 0) {
        setMode('hidden')
        setRevealedAt(null)
        setSecondsLeft(null)
        if (timerRef.current) clearInterval(timerRef.current)
        timerRef.current = null
      }
    }

    tick()
    timerRef.current = setInterval(tick, 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [mode, revealedAt, settings.timeoutSeconds])

  const startUnlock = useCallback(() => {
    if (!settings.enabled || !settings.hasPin) return
    setPinError(null)
    setMode('unlocking')
  }, [settings])

  const cancelUnlock = useCallback(() => {
    setPinError(null)
    setMode('hidden')
  }, [])

  const submitPin = useCallback(async (pin: string) => {
    setPinError(null)
    try {
      const res = await fetch('/api/privacy/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
        credentials: 'include',
      })
      const data = await res.json() as { ok: boolean; error?: string }
      if (data.ok) {
        setRevealedAt(Date.now())
        setMode('revealed')
      } else {
        setPinError(data.error ?? 'Incorrect PIN')
      }
    } catch {
      setPinError('Network error')
    }
  }, [])

  const extend = useCallback(() => {
    if (mode === 'revealed') setRevealedAt(prev => prev !== null ? prev + 30_000 : Date.now())
  }, [mode])

  const keepOpen = useCallback(() => {
    setMode('extended')
    setRevealedAt(null)
    setSecondsLeft(null)
  }, [])

  const hide = useCallback(() => {
    setMode('hidden')
    setRevealedAt(null)
    setSecondsLeft(null)
    setPinError(null)
  }, [])

  // Keyboard shortcut: Cmd+Shift+P / Ctrl+Shift+P
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault()
        if (!settings.enabled) return
        if (mode === 'hidden') setMode('unlocking')
        else if (mode === 'unlocking') cancelUnlock()
        else if (mode === 'revealed' || mode === 'extended') hide()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings, mode, cancelUnlock, hide])

  const adultVisible = mode === 'revealed' || mode === 'extended'

  return (
    <PrivacyContext.Provider value={{
      enabled: settings.enabled,
      mode,
      adultVisible,
      secondsLeft,
      pinError,
      startUnlock,
      cancelUnlock,
      submitPin,
      extend,
      keepOpen,
      hide,
    }}>
      {children}
    </PrivacyContext.Provider>
  )
}

export function usePrivacy() {
  const ctx = useContext(PrivacyContext)
  if (!ctx) throw new Error('usePrivacy must be used inside PrivacyProvider')
  return ctx
}
