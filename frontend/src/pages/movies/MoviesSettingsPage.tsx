import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Clapperboard, ExternalLink, MapPin, MonitorPlay, ShieldCheck } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { PlexConnectCard } from '@/components/media/PlexConnectCard'
import { MediaIntegrationsAdminCard } from '@/components/media/MediaIntegrations'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getMovieZip, setMovieZip } from '@/lib/movies/api'
import { getAppByPath } from '@/lib/appCategories'

const MOVIES_GRADIENT = getAppByPath('/movies')!.gradient

// ZIP used for local showtimes ("In Theaters Near You" + per-movie showtimes). Defaults to the
// household location (geocoded) until the user sets an explicit one here.
function ShowtimesZipSetting() {
  const { data, isLoading, refetch } = useQuery({ queryKey: ['movie-zip'], queryFn: getMovieZip, staleTime: 60 * 1000 })
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (data) setDraft(data.saved || '')
  }, [data])

  const usingLocation = !data?.saved && data?.source === 'location' && data?.zip
  const save = async () => {
    await setMovieZip(draft.trim())
    setSaved(true)
    await refetch()
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Set the ZIP code used to find local movie showtimes. Leave blank to use your saved location automatically.
      </p>
      <div className="flex items-center gap-2">
        <div className="relative">
          <MapPin className="absolute left-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            placeholder={data?.zip ? `${data.zip} (from location)` : 'e.g. 06460'}
            inputMode="numeric"
            className="w-44 pl-8"
          />
        </div>
        <Button type="button" variant="secondary" onClick={() => void save()} disabled={isLoading}>
          {saved ? 'Saved' : 'Save'}
        </Button>
      </div>
      {usingLocation && (
        <p className="text-xs text-muted-foreground">
          Currently using <span className="font-medium text-foreground">{data?.zip}</span> from your saved location.
        </p>
      )}
    </section>
  )
}

const SECTIONS: AppSettingsSection[] = [
  {
    id: 'showtimes',
    label: 'Showtimes',
    icon: MapPin,
    content: <ShowtimesZipSetting />,
  },
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
      <section className="space-y-6">
        <MediaIntegrationsAdminCard />
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
