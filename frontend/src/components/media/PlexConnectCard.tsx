import { CheckCircle2, Server, LogOut } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { usePlexLinkFlow } from '@/lib/plex/useLinkFlow'
import { PlexLinkModal } from './PlexLinkModal'

// Lets the CURRENT user link their own Plex account via the plex.tv PIN flow (code shown in a
// modal). Used in the Shows and Movies settings pages. `compact` trims copy.
export function PlexConnectCard({ compact }: { compact?: boolean }) {
  const { me, pin, linking, begin, unlink, cancel } = usePlexLinkFlow()

  if (me?.linked) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-card border border-border bg-card px-4 py-3">
        <span className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="size-4 text-success" />
          {me.serverName ? `Connected to ${me.serverName}` : 'Your Plex account is connected'}
        </span>
        <Button variant="ghost" size="sm" onClick={unlink} className="gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <LogOut className="size-3.5" /> Disconnect
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-card border border-border bg-card px-4 py-3">
      {!compact && <p className="text-sm font-medium">Connect your Plex account</p>}
      <p className="text-xs text-muted-foreground">Sign in with Plex so your watchlist and progress sync to your own account.</p>
      <Button variant="tinted" onClick={begin} disabled={linking || !!pin} className="gap-2 bg-warning/15 text-warning hover:bg-warning/25">
        {linking || pin ? <Spinner className="text-current" /> : <Server className="size-4" />} Sign in with Plex
      </Button>
      <PlexLinkModal pin={pin} onClose={cancel} />
    </div>
  )
}
