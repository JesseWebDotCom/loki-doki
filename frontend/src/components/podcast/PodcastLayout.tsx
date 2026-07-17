import { createContext, useContext, useMemo, useState } from 'react'
import { Outlet, useMatch, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { PodcastRail } from '@/components/podcast/PodcastRail'
import { NowPlaying } from '@/components/podcast/NowPlaying'
import { ShowEditorDialog } from '@/components/podcast/ShowEditorDialog'
import { getShows, type Show } from '@/lib/podcast/api'

interface PodcastUI {
  openCreate: () => void
  openEdit: (show: Show) => void
}
const PodcastUICtx = createContext<PodcastUI | null>(null)
export function usePodcastUI() {
  const ctx = useContext(PodcastUICtx)
  if (!ctx) throw new Error('usePodcastUI must be inside PodcastLayout')
  return ctx
}

export function PodcastLayout() {
  const { data: shows = [] } = useQuery({ queryKey: ['podcast-shows'], queryFn: getShows })
  const { track } = usePodcastPlayback()
  const navigate = useNavigate()
  const [headerQuery, setHeaderQuery] = useState('')
  const [editing, setEditing] = useState<Show | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  // Show detail page owns its own two-column layout (episode list + transcript),
  // so the global NowPlaying panel would create a third column - hide it there.
  const onShowDetail = !!useMatch('/podcasts/show/:id')

  usePublishUIContext({ label: 'Podcasts', description: 'User is browsing the Podcasts app.' })

  const ui: PodcastUI = {
    openCreate: () => { setEditing(null); setEditorOpen(true) },
    openEdit: show => { setEditing(show); setEditorOpen(true) },
  }

  // Publish the rail for the mobile top bar's drawer (desktop renders it inline at lg+).
  const rail = useMemo(() => <PodcastRail shows={shows} onCreate={() => { setEditing(null); setEditorOpen(true) }} variant="drawer" />, [shows])
  // Breadcrumb search (submit navigates to the transcript search page) + settings gear.
  // The dedicated search page publishes its own live-filtering header, so this only
  // governs every other Podcasts page. The gear opens the per-app settings page, which
  // is where playback preferences (including Skip ads guidance) live.
  useAppHeader({
    query: headerQuery,
    setQuery: setHeaderQuery,
    onSubmit: (submitted?: string) => {
      const t = (submitted ?? headerQuery).trim()
      navigate(t ? `/podcasts/search?q=${encodeURIComponent(t)}` : '/podcasts/search')
    },
    placeholder: 'Search everything you listen to',
    settingsHref: '/podcasts/settings',
    rail,
  })

  return (
    <PodcastUICtx.Provider value={ui}>
      <div className="flex min-h-full bg-background">
        <PodcastRail shows={shows} onCreate={ui.openCreate} />

        <div className="min-w-0 flex-1">
          <Outlet />
        </div>

        {/* Now Playing panel - hidden on show detail page which owns its own transcript column */}
        {track && !onShowDetail && (
          <aside className="hidden w-[340px] shrink-0 border-l border-border/40 xl:block">
            <div className="sticky top-0 h-screen">
              <NowPlaying />
            </div>
          </aside>
        )}
      </div>

      <ShowEditorDialog open={editorOpen} onClose={() => setEditorOpen(false)} initial={editing} />
    </PodcastUICtx.Provider>
  )
}
