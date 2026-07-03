import { useCallback, useEffect, useState } from 'react'

// Shared quick-status state for a user, backed by /api/pod/presence + /api/pod/status.
// Used by both the sidebar's status switcher and Settings → Profile so they show
// (and set) the same value instead of each polling/holding their own copy.
export function usePresenceStatus(userId: string | undefined) {
  const [current, setCurrent] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    if (!userId) return
    fetch('/api/pod/presence', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { status?: { state?: string } | null } | null) => {
        setCurrent(d?.status?.state ?? null)
      })
      .catch(() => { /* ignore */ })
  }, [userId])

  useEffect(() => { refresh() }, [refresh])

  const setStatus = useCallback(async (state: string | null) => {
    if (busy) return
    setBusy(true)
    try {
      if (!state) {
        await fetch('/api/pod/status', { method: 'DELETE', credentials: 'include' })
        setCurrent(null)
      } else {
        await fetch('/api/pod/status', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state }),
        })
        setCurrent(state)
      }
    } catch { /* ignore */ } finally { setBusy(false) }
  }, [busy])

  return { current, setStatus, busy, refresh }
}
