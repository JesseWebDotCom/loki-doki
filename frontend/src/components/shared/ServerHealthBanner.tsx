import { Loader2, ServerOff } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { useServerHealth } from '@/context/ServerHealthContext'

// App-wide strip shown when the backend can't be reached. Hidden on /setup, which has
// its own inline indicator (driven by the same useServerHealth signal).
export function ServerHealthBanner() {
  const { reachable } = useServerHealth()
  const { pathname } = useLocation()

  if (reachable || pathname.startsWith('/setup')) return null

  // On the device's ambient display (/display) this is read from across a room, so use
  // a short, large message instead of the small full-sentence app banner.
  const onDisplay = pathname.startsWith('/display')

  return (
    <div
      role="status"
      className={`fixed inset-x-0 top-0 z-[200] flex items-center justify-center bg-amber-500 text-center text-amber-950 shadow-lg animate-in slide-in-from-top-2 ${
        onDisplay ? 'gap-4 px-6 py-6 text-4xl font-bold' : 'gap-2 px-4 py-2 text-sm font-medium'
      }`}
    >
      <ServerOff className={onDisplay ? 'size-9 shrink-0' : 'size-4 shrink-0'} />
      <span>{onDisplay ? 'Server offline' : "Can't reach the server. Make sure the backend is running."}</span>
      <Loader2 className={`${onDisplay ? 'size-8' : 'size-3.5'} shrink-0 animate-spin opacity-80`} />
      {!onDisplay && <span className="opacity-70">reconnecting…</span>}
    </div>
  )
}
