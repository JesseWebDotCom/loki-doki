import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, MonitorPlay, ExternalLink } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAuth } from '@/context/AuthContext'
import { PlexConnectCard } from '@/components/media/PlexConnectCard'

export function MoviesSettingsPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  usePublishUIContext({ label: 'Movies Settings', description: 'User is on the Movies settings page.' })

  return (
    <PageShell>
      <PageContainer width="narrow" className="space-y-6 pb-12 pt-5">
        <button
          onClick={() => navigate('/movies')}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to Movies
        </button>

        <PageHeader
          title="Movies Settings"
          subtitle="Connect your Plex account to play your library and sync your watchlist."
          className="pt-0 pb-0"
        />

        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <MonitorPlay className="size-4 text-warning" /> Plex
          </h2>
          <PlexConnectCard />
          <p className="text-xs text-muted-foreground">
            Your watchlist changes and watched-state sync to your own Plex account. The shared Plex server is set up by an admin.
          </p>
        </section>

        {user?.role === 'admin' && (
          <section className="space-y-2 border-t border-border pt-5">
            <h2 className="text-sm font-semibold">Admin</h2>
            <Link to="/admin/plex" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
              Plex server configuration <ExternalLink className="size-3.5" />
            </Link>
            <br />
            <Link to="/admin/features?tool=showtimes" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
              Showtimes &amp; movie data settings <ExternalLink className="size-3.5" />
            </Link>
          </section>
        )}
      </PageContainer>
    </PageShell>
  )
}
