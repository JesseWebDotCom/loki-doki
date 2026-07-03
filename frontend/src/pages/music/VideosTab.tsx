import { useCallback, useEffect, useState } from 'react'
import { Search, Music, Film, Tv, ExternalLink, ChevronRight, ListMusic } from 'lucide-react'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ListRow } from '@/components/shared/ListRow'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { toast } from '@/lib/toast'
import { fetchArtistInfo, fetchTrackAppearances, type ArtistInfo, type SoundtrackAppearance } from '@/lib/music/musicInfo'
import { search as ytSearch, ytImageProxy } from '@/lib/youtube/api'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'

interface VideoResult {
  videoId: string
  title: string
  author: string | null
  thumbnail: string
  durationSec: number | null
}

function fmtDur(sec: number | null): string {
  if (!sec) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = String(Math.round(sec % 60)).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function ArtistCard({ info }: { info: ArtistInfo }) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-card">
      {info.image && (
        <div className="relative aspect-video w-full overflow-hidden">
          <img src={proxyImg(info.image)} alt={info.title} className="size-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
          <p className="absolute bottom-0 left-0 right-0 p-4 text-xl font-bold text-white leading-tight">{info.title}</p>
        </div>
      )}
      {!info.image && (
        <div className="flex items-center gap-3 border-b border-border/50 bg-muted/30 px-4 py-3">
          <div className="flex size-10 items-center justify-center rounded-control bg-brand/10">
            <Music className="size-5 text-brand" />
          </div>
          <p className="font-bold">{info.title}</p>
        </div>
      )}
      <div className="p-4">
        <p className="line-clamp-5 text-sm leading-relaxed text-muted-foreground">{info.extract}</p>
        {info.url && (
          <a href={info.url} target="_blank" rel="noreferrer"
            className="mt-3 flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-hover transition-colors">
            <ExternalLink className="size-3" /> Read on Wikipedia
          </a>
        )}
      </div>
    </div>
  )
}

function AppearanceCard({ a, onClick }: { a: SoundtrackAppearance; onClick: () => void }) {
  return (
    <ListRow
      onClick={onClick}
      leading={
        <span className="flex size-8 items-center justify-center rounded-control bg-muted text-muted-foreground">
          {a.type === 'show' ? <Tv className="size-3.5" /> : <Film className="size-3.5" />}
        </span>
      }
      title={a.title}
      meta={a.year ? `${a.year} · ${a.type === 'show' ? 'TV Show' : 'Film'}` : undefined}
      trailing={<ChevronRight className="size-3.5 text-muted-foreground" />}
    />
  )
}

export function VideosTab() {
  const navigate = useNavigate()
  const pb = useYoutubePlayback()
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') ?? '')
  const [videos, setVideos] = useState<VideoResult[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [artistInfo, setArtistInfo] = useState<ArtistInfo | null>(null)
  const [appearances, setAppearances] = useState<SoundtrackAppearance[]>([])
  const [infoLoading, setInfoLoading] = useState(false)

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) return
    setLoading(true); setVideos([]); setArtistInfo(null); setAppearances([]); setSelectedId(null)
    try {
      const data = await ytSearch(`${q} music`, null, 'videos')
      const vids: VideoResult[] = (data.results ?? []).slice(0, 12).map(v => ({
        videoId: v.videoId,
        title: v.title,
        author: v.author ?? null,
        thumbnail: ytImageProxy(`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`),
        durationSec: v.durationSec ?? null,
      }))
      setVideos(vids)
    } catch { toast.error('Search failed') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const q = searchParams.get('q')
    const vid = searchParams.get('videoId')
    if (q) { setQuery(q); void doSearch(q) }
    if (vid) setSelectedId(vid)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadArtistInfo(video: VideoResult) {
    if (!video.author) return
    setInfoLoading(true); setArtistInfo(null); setAppearances([])
    try {
      const cleanTitle = video.title.replace(/\s*\(.*?\)\s*/g, '').replace(/\s*-\s*Official.*$/i, '').trim()
      const [info, appr] = await Promise.all([
        fetchArtistInfo(video.author),
        fetchTrackAppearances(video.author, cleanTitle),
      ])
      setArtistInfo(info.found ? info : null)
      setAppearances(appr)
    } catch { /* best-effort */ }
    finally { setInfoLoading(false) }
  }

  function selectVideo(v: VideoResult) {
    setSelectedId(v.videoId)
    void loadArtistInfo(v)
    // Dock the full result set as a queue starting at this video.
    const idx = videos.indexOf(v)
    pb.dock(
      videos.map(vid => ({
        videoId: vid.videoId,
        title: vid.title,
        author: vid.author,
        durationSec: vid.durationSec,
      })),
      Math.max(0, idx),
      0,
    )
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!query.trim()) return
    void doSearch(query.trim())
  }

  function navigateToMedia(a: SoundtrackAppearance) {
    navigate(a.type === 'show'
      ? `/tv-shows?q=${encodeURIComponent(a.title)}`
      : `/where-to-watch?q=${encodeURIComponent(a.title)}`)
  }

  // Keep selected in sync with mini player navigation (prev/next).
  const activeVideoId = pb.track?.videoId ?? selectedId

  const showInfo = !!(artistInfo || appearances.length > 0 || infoLoading)

  return (
    <div className="space-y-5">
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search artist, song, or album…" className="pl-9" />
        </div>
        <Button type="submit" variant="outline" disabled={loading} className="text-muted-foreground hover:text-foreground">
          {loading ? <Spinner className="text-current" /> : 'Search'}
        </Button>
      </form>

      {videos.length === 0 && !loading && (
        <EmptyAppState
          icon={Music}
          // design-ok(hex-in-tsx): app identity gradient (registry value)
          gradient="linear-gradient(135deg,#f97316,#fb923c)"
          title="Music videos with artist context"
          tagline="Search any artist or song, and play the video while the app pulls up a Wikipedia bio and shows you where their music has appeared in films and TV shows."
          features={[
            { icon: Search, title: 'Any artist or song', desc: 'Search by name, song title, or album to find official music videos.' },
            { icon: Film, title: 'Soundtrack links', desc: 'See which movies and shows a song appeared in - tap to jump there.' },
            { icon: ExternalLink, title: 'Artist bio', desc: 'Wikipedia artist panel loads automatically alongside the video.' },
            { icon: ListMusic, title: 'Queue playback', desc: 'All search results queue up - press next to keep the music going.' },
          ]}
        />
      )}

      {loading && <div className="flex justify-center py-16"><Spinner size="lg" /></div>}

      {videos.length > 0 && (
        <div className={cn('grid gap-6', showInfo && 'lg:grid-cols-[1fr_300px]')}>
          {/* Video grid */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {videos.map((v) => {
              const isActive = activeVideoId === v.videoId
              return (
                <button key={v.videoId} type="button" onClick={() => selectVideo(v)}
                  className={cn(
                    'group overflow-hidden rounded-card border text-left transition-all hover:border-brand/40',
                    isActive ? 'border-brand/50 shadow-md shadow-brand/10' : 'border-border',
                  )}>
                  <div className="relative aspect-video overflow-hidden">
                    <img src={ytImageProxy(v.thumbnail)} alt={v.title}
                      className="size-full object-cover transition-transform duration-200 group-hover:scale-105" />
                    {isActive && (
                      <div className="absolute inset-0 flex items-center justify-center bg-brand/20">
                        <div className="rounded-full bg-brand/90 p-2">
                          <div className="flex items-end gap-[2px]">
                            {[3, 5, 4].map((h, i) => (
                              <div key={i} className="w-[2px] rounded-full bg-white"
                                style={{ height: `${h * 2}px`, animation: `wave 0.8s ease-in-out ${i * 0.12}s infinite alternate` }} />
                            ))}
                            <style>{`@keyframes wave{from{transform:scaleY(0.3)}to{transform:scaleY(1)}}`}</style>
                          </div>
                        </div>
                      </div>
                    )}
                    {v.durationSec && (
                      <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        {fmtDur(v.durationSec)}
                      </span>
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="line-clamp-2 text-xs font-semibold leading-snug">{v.title}</p>
                    {v.author && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{v.author}</p>}
                  </div>
                </button>
              )
            })}
          </div>

          {/* Info panel - slides in when artist info is available */}
          {showInfo && (
            <div className="space-y-4">
              {infoLoading && (
                <div className="flex items-center justify-center rounded-card border border-dashed border-border/50 py-12">
                  <Spinner size="lg" />
                </div>
              )}

              {!infoLoading && artistInfo && <ArtistCard info={artistInfo} />}

              {!infoLoading && appearances.length > 0 && (
                <div className="overflow-hidden rounded-card border border-border bg-card">
                  <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3">
                    <Film className="size-4 text-muted-foreground" />
                    <p className="text-sm font-semibold">Featured In</p>
                    <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{appearances.length}</span>
                  </div>
                  <div className="space-y-1.5 p-3">
                    {appearances.map((a, i) => (
                      <AppearanceCard key={i} a={a} onClick={() => navigateToMedia(a)} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
