import { useState } from 'react'
import { Loader2, Server, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { usePlexServerConfigured, usePlexLinked } from '@/lib/plex/hooks'
import { usePlexLinkFlow } from '@/lib/plex/useLinkFlow'
import { PlexLinkModal } from './PlexLinkModal'

const DISMISS_KEY = 'plex.connectBannerDismissed'

// App-wide prompt to link your own Plex account, rendered once in AppShell directly under the
// breadcrumb row (so it's fixed above the page content on every page). Shows when an admin has
// set up the shared server but this user hasn't linked yet. Sign-in opens a modal with the code.
// Dismissible (sticks via localStorage) — dismissal points the user to where to connect later.
export function PlexConnectBanner() {
  const serverConfigured = usePlexServerConfigured()
  const linked = usePlexLinked()
  const { pin, linking, begin, cancel } = usePlexLinkFlow()
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1')

  if (!serverConfigured || linked || dismissed) {
    // Keep the modal mountable even if the banner itself is hidden mid-flow.
    return <PlexLinkModal pin={pin} onClose={cancel} />
  }

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
    toast.info('You can connect Plex anytime in Settings → Plex, or the gear in Movies.')
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2.5 backdrop-blur-md sm:px-6">
        <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-amber-100/90">
          <Server className="size-4 shrink-0 text-amber-300" />
          <span className="truncate">Connect your Plex account to sync your watchlist and play your library here.</span>
        </p>
        <button
          onClick={begin}
          disabled={linking || !!pin}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-500/20 px-3 py-1.5 text-sm font-medium text-amber-100 transition-colors hover:bg-amber-500/30 disabled:opacity-50"
        >
          {linking || pin ? <Loader2 className="size-4 animate-spin" /> : <Server className="size-4" />} Sign in with Plex
        </button>
        <button
          onClick={dismiss}
          title="Dismiss"
          className="shrink-0 rounded-md p-1 text-amber-100/60 transition-colors hover:bg-amber-500/20 hover:text-amber-100"
        >
          <X className="size-4" />
        </button>
      </div>
      <PlexLinkModal pin={pin} onClose={cancel} />
    </>
  )
}
