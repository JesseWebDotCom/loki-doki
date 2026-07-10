// Suggested + pinned YouTube guitar-tutorial videos for a Studio track - Ultimate Guitar's
// "official/user video lessons" idea, but backed entirely by the app's own YouTube search
// (frontend/src/lib/youtube/api.ts `search`) instead of a new discovery backend. Playback
// docks into the shared mini-player (same pattern as pages/music/VideosTab.tsx) so a tutorial
// plays without leaving the Studio page; the mediaCoordinator registration in
// MusicStudioDetailPage.tsx pauses the stems whenever one docks, and vice versa.
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pin, PinOff, Search as SearchIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { fmtDur } from '@/lib/youtube/format'
import { search as ytSearch, ytImageProxy, type SearchResult } from '@/lib/youtube/api'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { listStudioTutorials, pinStudioTutorial, unpinStudioTutorial, type StudioTutorial } from '@/lib/music/studioApi'

function thumbFor(videoId: string): string {
  return ytImageProxy(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`)
}

interface TutorialLike {
  videoId: string; title: string; author: string | null; durationSec: number | null
}

function TutorialCard({ item, thumbnailUrl, pinned, busy, onPlay, onTogglePin }: {
  item: TutorialLike; thumbnailUrl: string; pinned: boolean; busy: boolean
  onPlay: () => void; onTogglePin: () => void
}) {
  return (
    <div className="group relative overflow-hidden rounded-card border border-border transition-all hover:border-brand/40">
      <button type="button" onClick={onPlay} className="block w-full text-left">
        <div className="relative aspect-video overflow-hidden">
          <img src={thumbnailUrl} alt="" className="size-full object-cover transition-transform duration-200 group-hover:scale-105" />
          {item.durationSec != null && (
            <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] font-medium text-white">{fmtDur(item.durationSec)}</span>
          )}
        </div>
        <div className="p-2.5 pr-8">
          <p className="line-clamp-2 text-xs font-semibold leading-snug">{item.title}</p>
          {item.author && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.author}</p>}
        </div>
      </button>
      <button type="button" onClick={onTogglePin} disabled={busy} aria-label={pinned ? 'Unpin tutorial' : 'Pin tutorial'}
        className={cn(
          'absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-full bg-black/70 text-white transition hover:bg-black/90',
          !pinned && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        )}>
        {busy ? <Spinner className="size-3.5 text-current" /> : pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
      </button>
    </div>
  )
}

export function StudioTutorials({ trackId, artist, title }: { trackId: string; artist: string | null; title: string }) {
  const qc = useQueryClient()
  const pb = useYoutubePlayback()
  const seed = `${artist ?? ''} ${title} guitar tutorial`.trim()

  const { data: pinned = [] } = useQuery({ queryKey: ['studio-tutorials', trackId], queryFn: () => listStudioTutorials(trackId) })
  const pinnedIds = new Set(pinned.map((p) => p.videoId))

  const [results, setResults] = useState<SearchResult[]>([])
  const [continuation, setContinuation] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (loadedFor === seed || !seed) return
    setLoading(true)
    ytSearch(seed, null, 'videos')
      .then((r) => { setResults(r.results ?? []); setContinuation(r.continuation ?? null); setLoadedFor(seed) })
      .catch(() => toast.error('Could not load tutorial suggestions'))
      .finally(() => setLoading(false))
  }, [seed, loadedFor])

  async function findMore() {
    if (!continuation) return
    setLoading(true)
    try {
      const r = await ytSearch(seed, continuation, 'videos')
      setResults((prev) => [...prev, ...(r.results ?? [])])
      setContinuation(r.continuation ?? null)
    } catch { toast.error('Could not load more') }
    finally { setLoading(false) }
  }

  function play(item: TutorialLike, thumbnailUrl: string) {
    pb.dock([{ videoId: item.videoId, title: item.title, author: item.author, durationSec: item.durationSec, thumbnail: thumbnailUrl, origin: 'music' }], 0, 0)
  }

  async function togglePin(item: TutorialLike, thumbnailUrl: string) {
    setBusyId(item.videoId)
    try {
      if (pinnedIds.has(item.videoId)) await unpinStudioTutorial(trackId, item.videoId)
      else await pinStudioTutorial(trackId, { videoId: item.videoId, title: item.title, author: item.author, thumbnailUrl, durationSec: item.durationSec })
      await qc.invalidateQueries({ queryKey: ['studio-tutorials', trackId] })
    } catch { toast.error('Could not update pin') }
    finally { setBusyId(null) }
  }

  const suggested = results.filter((r) => !pinnedIds.has(r.videoId))

  return (
    <Card>
      <CardHeader className="p-3 pb-1">
        <CardTitle className="text-sm text-muted-foreground">Guitar tutorials</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-3 pt-1">
        {pinned.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {pinned.map((t: StudioTutorial) => (
              <TutorialCard key={t.videoId} item={t} thumbnailUrl={t.thumbnailUrl ?? thumbFor(t.videoId)} pinned
                busy={busyId === t.videoId} onPlay={() => play(t, t.thumbnailUrl ?? thumbFor(t.videoId))}
                onTogglePin={() => void togglePin(t, t.thumbnailUrl ?? thumbFor(t.videoId))} />
            ))}
          </div>
        )}

        {loading && results.length === 0 ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : suggested.length > 0 ? (
          <>
            <p className="text-xs font-medium text-muted-foreground">Suggested</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {suggested.map((r) => {
                const thumbnailUrl = thumbFor(r.videoId)
                const item: TutorialLike = { videoId: r.videoId, title: r.title, author: r.author ?? null, durationSec: r.durationSec ?? null }
                return (
                  <TutorialCard key={r.videoId} item={item} thumbnailUrl={thumbnailUrl} pinned={false}
                    busy={busyId === r.videoId} onPlay={() => play(item, thumbnailUrl)} onTogglePin={() => void togglePin(item, thumbnailUrl)} />
                )
              })}
            </div>
          </>
        ) : null}

        {continuation && (
          <Button variant="outline" size="sm" onClick={() => void findMore()} disabled={loading} className="w-full text-muted-foreground">
            {loading ? <Spinner className="text-current" /> : <SearchIcon className="size-3.5" />} Find more
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
