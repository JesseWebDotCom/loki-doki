import { useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext'

// appMode is the user/admin preference ("do you want internet features?")
// hasNetwork is the device's actual connectivity (navigator.onLine)
// These are intentionally separate — a user can be in local-only mode with a
// working connection, or in standard mode with no signal.
export interface ConnectivityState {
  appMode: 'standard' | 'local'
  forcedByAdmin: boolean
  hasNetwork: boolean
}

function getNetworkState(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true
}

export function useConnectivity(): ConnectivityState | null {
  const { user } = useAuth()
  const [appMode, setAppMode] = useState<'standard' | 'local'>('standard')
  const [forcedByAdmin, setForcedByAdmin] = useState(false)
  const [hasNetwork, setHasNetwork] = useState(getNetworkState)

  // Browser network events
  useEffect(() => {
    const onOnline  = () => setHasNetwork(true)
    const onOffline = () => setHasNetwork(false)
    window.addEventListener('online',  onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online',  onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  // App-level preference (user/admin toggle)
  useEffect(() => {
    if (!user?.id) return
    const load = () => {
      fetch(`/api/users/${user.id}/connectivity`, { credentials: 'include' })
        .then(r => r.ok ? r.json() as Promise<{ effectiveMode: 'online' | 'offline'; forcedByAdmin: boolean }> : null)
        .then(d => {
          if (!d) return
          setAppMode(d.effectiveMode === 'offline' ? 'local' : 'standard')
          setForcedByAdmin(d.forcedByAdmin)
        })
        .catch(() => {})
    }
    load()
    window.addEventListener('connectivity-changed', load)
    return () => window.removeEventListener('connectivity-changed', load)
  }, [user?.id])

  return { appMode, forcedByAdmin, hasNetwork }
}
