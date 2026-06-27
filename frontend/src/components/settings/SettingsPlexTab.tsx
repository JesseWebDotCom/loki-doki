import { MonitorPlay } from 'lucide-react'
import { PlexConnectCard } from '@/components/media/PlexConnectCard'

// Per-user Plex linking. The shared server is configured by an admin (Admin → Plex); here each
// user connects their own Plex account so their Watchlist and watched-state are personal.
export function SettingsPlexTab() {
  return (
    <div className="mx-auto max-w-xl space-y-5 py-2">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <MonitorPlay className="size-5 text-amber-400" /> Plex
        </h1>
        <p className="text-sm text-muted-foreground">
          Link your Plex account to sync your watchlist and progress, and play your library in the Shows and Movies apps.
        </p>
      </header>
      <PlexConnectCard />
      <p className="text-xs text-muted-foreground">
        Adding or removing a title in your watchlist here also updates it on your Plex account, and marking episodes
        watched scrobbles them to Plex. Your library, On-Deck and recommendations show up on the Shows and Movies home.
      </p>
    </div>
  )
}
