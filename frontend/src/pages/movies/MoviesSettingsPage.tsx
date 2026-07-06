import { Link } from 'react-router-dom'
import { Clapperboard, ExternalLink, MonitorPlay, ShieldCheck } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { PlexConnectCard } from '@/components/media/PlexConnectCard'
import { getAppByPath } from '@/lib/appCategories'

const MOVIES_GRADIENT = getAppByPath('/movies')!.gradient

const SECTIONS: AppSettingsSection[] = [
  {
    id: 'plex',
    label: 'Plex',
    icon: MonitorPlay,
    content: (
      <section className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Connect your Plex account to play your library and sync your watchlist.
        </p>
        <PlexConnectCard />
        <p className="text-xs text-muted-foreground">
          Your watchlist changes and watched-state sync to your own Plex account. The shared Plex server is set up by an admin.
        </p>
      </section>
    ),
  },
  {
    id: 'admin',
    label: 'Admin',
    icon: ShieldCheck,
    adminOnly: true,
    content: (
      <section className="space-y-2">
        <Link to="/admin/plex" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
          Plex server configuration <ExternalLink className="size-3.5" />
        </Link>
        <br />
        <Link to="/admin/features?tool=showtimes" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
          Showtimes &amp; movie data settings <ExternalLink className="size-3.5" />
        </Link>
      </section>
    ),
  },
]

export function MoviesSettingsPage() {
  usePublishUIContext({ label: 'Movies Settings', description: 'User is on the Movies settings page.' })

  return (
    <AppSettingsShell
      appId="movies"
      icon={Clapperboard}
      gradient={MOVIES_GRADIENT}
      sections={SECTIONS}
    />
  )
}
