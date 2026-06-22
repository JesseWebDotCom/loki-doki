import { createContext, useContext, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { usePublishUIContext } from '@/context/UIContextProvider'
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
  const [editing, setEditing] = useState<Show | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)

  usePublishUIContext({ label: 'Podcasts', description: 'User is browsing the Podcasts app.' })

  const ui: PodcastUI = {
    openCreate: () => { setEditing(null); setEditorOpen(true) },
    openEdit: show => { setEditing(show); setEditorOpen(true) },
  }

  return (
    <PodcastUICtx.Provider value={ui}>
      <div className="flex min-h-full bg-background">
        <PodcastRail shows={shows} onCreate={ui.openCreate} />

        <div className="min-w-0 flex-1">
          <Outlet />
        </div>

        {/* Now Playing panel — appears once something is loaded */}
        {track && (
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
