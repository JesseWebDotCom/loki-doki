import { Loader2, CheckCircle2, Server, LogOut } from 'lucide-react'
import { usePlexLinkFlow } from '@/lib/plex/useLinkFlow'
import { PlexLinkModal } from './PlexLinkModal'

const btnCls = 'inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50'

// Lets the CURRENT user link their own Plex account via the plex.tv PIN flow (code shown in a
// modal). Used in Settings → Plex and the Movies settings page. `compact` trims copy.
export function PlexConnectCard({ compact }: { compact?: boolean }) {
  const { me, pin, linking, begin, unlink, cancel } = usePlexLinkFlow()

  if (me?.linked) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <span className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="size-4 text-emerald-400" />
          {me.serverName ? `Connected to ${me.serverName}` : 'Your Plex account is connected'}
        </span>
        <button onClick={unlink} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          <LogOut className="size-3.5" /> Disconnect
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card px-4 py-3">
      {!compact && <p className="text-sm font-medium">Connect your Plex account</p>}
      <p className="text-xs text-muted-foreground">Sign in with Plex so your watchlist and progress sync to your own account.</p>
      <button onClick={begin} disabled={linking || !!pin} className={`${btnCls} bg-amber-500/15 text-amber-300 hover:bg-amber-500/25`}>
        {linking || pin ? <Loader2 className="size-4 animate-spin" /> : <Server className="size-4" />} Sign in with Plex
      </button>
      <PlexLinkModal pin={pin} onClose={cancel} />
    </div>
  )
}
