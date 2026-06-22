import { Loader2, ServerOff } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { useServerHealth } from '@/context/ServerHealthContext'

// App-wide strip shown when the backend can't be reached. Hidden on /setup, which has
// its own inline indicator (driven by the same useServerHealth signal).
export function ServerHealthBanner() {
  const { reachable } = useServerHealth()
  const { pathname } = useLocation()

  if (reachable || pathname.startsWith('/setup')) return null

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[200] flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-center text-sm font-medium text-amber-950 shadow-lg animate-in slide-in-from-top-2"
    >
      <ServerOff className="size-4 shrink-0" />
      <span>Can't reach the server. Make sure the backend is running.</span>
      <Loader2 className="size-3.5 shrink-0 animate-spin opacity-80" />
      <span className="opacity-70">reconnecting…</span>
    </div>
  )
}
