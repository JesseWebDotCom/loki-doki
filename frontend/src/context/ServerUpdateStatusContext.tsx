import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext'

// App-wide "is a server update available" signal for admins. A single poller hits the
// cheap admin status endpoint (already kept warm by the backend's own background
// update-check poller) so the sidebar badge and the Admin > Server panel agree on the
// same number without each mounting their own poller. Mirrors GpuHealthContext.

export interface ServerUpdateStatus {
  gitCheckout: boolean
  version: { shortHash: string; subject: string; date: string; branch: string } | null
  behind: number | null
  lastCheckedAt: number | null
  phase: 'idle' | 'checking' | 'updating' | 'restarting'
  settings: { mode: 'off' | 'notify' | 'auto'; intervalHours: number }
  devMode: boolean
}

interface ServerUpdateStatusCtx {
  status: ServerUpdateStatus | null
  refresh: () => void
}

const Ctx = createContext<ServerUpdateStatusCtx>({ status: null, refresh: () => {} })
export const useServerUpdateStatus = () => useContext(Ctx)

const POLL_MS = 30_000

export function ServerUpdateStatusProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [status, setStatus] = useState<ServerUpdateStatus | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/server/status', { credentials: 'include' })
      if (r.ok) setStatus(await r.json() as ServerUpdateStatus)
    } catch { /* offline, keep last value */ }
  }, [])

  const refresh = useCallback(() => { void fetchStatus() }, [fetchStatus])

  useEffect(() => {
    if (!isAdmin) { setStatus(null); return }
    void fetchStatus()
    const timer = setInterval(() => {
      if (!document.hidden) void fetchStatus()
    }, POLL_MS)
    const onVisible = () => { if (!document.hidden) void fetchStatus() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [isAdmin, fetchStatus])

  return <Ctx.Provider value={{ status, refresh }}>{children}</Ctx.Provider>
}
