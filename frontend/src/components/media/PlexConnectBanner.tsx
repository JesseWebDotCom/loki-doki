import { useState } from 'react'
import { Server, X } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { usePlexServerConfigured, usePlexLinked } from '@/lib/plex/hooks'
import { usePlexLinkFlow } from '@/lib/plex/useLinkFlow'
import { PlexLinkModal } from './PlexLinkModal'

const DISMISS_KEY = 'plex.connectBannerDismissed'

// App-wide prompt to link your own Plex account, rendered once in AppShell directly under the
// breadcrumb row (so it's fixed above the page content on every page). Shows when an admin has
// set up the shared server but this user hasn't linked yet. Sign-in opens a modal with the code.
// Dismissible (sticks via localStorage); dismissal points the user to where to connect later.
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
    toast.info('You can connect Plex anytime from the Shows or Movies settings (the gear icon).')
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-warning/20 bg-warning/10 px-4 py-2.5 sm:px-6">
        <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground/90">
          <Server className="size-4 shrink-0 text-warning" />
          <span className="truncate">Connect your Plex account to sync your watchlist and play your library here.</span>
        </p>
        <Button
          variant="tinted"
          size="sm"
          onClick={begin}
          disabled={linking || !!pin}
          className="shrink-0 gap-1.5 bg-warning/20 text-warning hover:bg-warning/30"
        >
          {linking || pin ? <Spinner className="text-current" /> : <Server className="size-4" />} Sign in with Plex
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={dismiss}
          title="Dismiss"
          aria-label="Dismiss"
          className="shrink-0 text-warning/70 hover:bg-warning/20 hover:text-warning"
        >
          <X className="size-4" />
        </Button>
      </div>
      <PlexLinkModal pin={pin} onClose={cancel} />
    </>
  )
}
