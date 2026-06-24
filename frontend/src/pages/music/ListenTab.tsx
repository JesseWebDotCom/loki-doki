import { useCallback, useEffect, useState } from 'react'
import { Search, Radio, Loader2, ChevronLeft } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import { searchStations, fetchGenres, type RadioStation, type RadioGenre } from '@/lib/music/radio'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'

const GENRE_COLORS: Record<string, [string, string]> = {
  'pop':       ['#ec4899', '#db2777'],
  'rock':      ['#f97316', '#dc2626'],
  'hip-hop':   ['#a855f7', '#7c3aed'],
  'jazz':      ['#3b82f6', '#1d4ed8'],
  'classical': ['#94a3b8', '#475569'],
  'electronic':['#06b6d4', '#0284c7'],
  'country':   ['#84cc16', '#16a34a'],
  'r&b':       ['#f43f5e', '#be123c'],
  'metal':     ['#374151', '#111827'],
  'reggae':    ['#eab308', '#16a34a'],
  'blues':     ['#6366f1', '#4338ca'],
  'indie':     ['#14b8a6', '#0d9488'],
  'latin':     ['#f59e0b', '#b45309'],
  'ambient':   ['#818cf8', '#6366f1'],
  'news':      ['#64748b', '#334155'],
  'sports':    ['#10b981', '#059669'],
}

const GENRE_ICONS: Record<string, string> = {
  'pop': '🎤', 'rock': '🎸', 'hip-hop': '🎧', 'jazz': '🎷', 'classical': '🎻',
  'electronic': '🎛️', 'country': '🤠', 'r&b': '🎵', 'metal': '⚡', 'reggae': '🌴',
  'blues': '🎺', 'indie': '🌱', 'latin': '💃', 'ambient': '🌊', 'news': '📰', 'sports': '🏈',
}

function StationArt({ favicon, fallbackEmoji }: { favicon: string | null; fallbackEmoji: string }) {
  const [err, setErr] = useState(false)
  return (
    <div className="relative size-full flex items-center justify-center text-2xl">
      <span>{fallbackEmoji}</span>
      {favicon && !err && (
        <img src={favicon} alt="" className="absolute inset-0 size-full object-cover rounded-xl"
          onError={() => setErr(true)} />
      )}
    </div>
  )
}

export function ListenTab() {
  const pb = useYoutubePlayback()
  const [genres, setGenres] = useState<RadioGenre[]>([])
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null)
  const [selectedGenreLabel, setSelectedGenreLabel] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [stations, setStations] = useState<RadioStation[]>([])
  const [loading, setLoading] = useState(false)
  const [inStations, setInStations] = useState(false)

  useEffect(() => { fetchGenres().then(setGenres).catch(() => {}) }, [])

  const loadStations = useCallback(async (genre?: string, name?: string) => {
    setLoading(true); setStations([]); setInStations(true)
    try { setStations(await searchStations({ genre, name, limit: 30 })) }
    catch { setStations([]) }
    finally { setLoading(false) }
  }, [])

  function selectGenre(g: RadioGenre) {
    setSelectedGenre(g.id); setSelectedGenreLabel(g.label); setSearchQuery('')
    void loadStations(g.id)
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!searchQuery.trim()) return
    setSelectedGenre(null); setSelectedGenreLabel(searchQuery.trim())
    void loadStations(undefined, searchQuery.trim())
  }

  function playStation(station: RadioStation) {
    pb.dock([{
      videoId: station.id,
      title: station.name,
      author: [station.country, station.codec, station.bitrate ? `${station.bitrate}k` : null].filter(Boolean).join(' · ') || null,
      streamUrl: station.url,
      thumbnail: station.favicon || undefined,
      icon: GENRE_ICONS[selectedGenre ?? ''] ?? '📻',
    }], 0, 0)
  }

  const activeId = pb.track?.streamUrl ? pb.track.videoId : null

  return (
    <div className="space-y-5">
      {/* Browse: genre tiles */}
      {!inStations && (
        <>
          <form onSubmit={handleSearch} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search stations by name…" className="pl-9" />
            </div>
            <button type="submit"
              className="rounded-xl border border-border px-4 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Search
            </button>
          </form>

          <div>
            <p className="mb-3 text-sm font-semibold tracking-tight">Browse by Genre</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {genres.map((g) => {
                const [c1, c2] = GENRE_COLORS[g.id] ?? ['#6b7280', '#374151']
                return (
                  <button key={g.id} type="button" onClick={() => selectGenre(g)}
                    className="relative flex aspect-[2/1] items-end overflow-hidden rounded-2xl p-3 transition-transform hover:scale-[1.03] active:scale-[0.98]"
                    style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
                    <span className="absolute right-3 top-2 text-3xl leading-none drop-shadow">
                      {GENRE_ICONS[g.id] ?? '🎵'}
                    </span>
                    <span className="font-bold text-white text-sm drop-shadow">{g.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}

      {/* Stations view */}
      {inStations && (
        <>
          <div className="flex items-center gap-2">
            <button type="button"
              onClick={() => { setInStations(false); setSelectedGenre(null); setStations([]) }}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <ChevronLeft className="size-4" /> Browse
            </button>
            {selectedGenreLabel && (
              <>
                <span className="text-border">/</span>
                <div className="flex items-center gap-1.5 text-sm font-semibold">
                  {selectedGenre && <span>{GENRE_ICONS[selectedGenre]}</span>}
                  {selectedGenreLabel}
                </div>
              </>
            )}
            <form onSubmit={handleSearch} className="ml-auto flex gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search…" className="h-8 w-40 pl-8 text-sm" />
              </div>
              <button type="submit"
                className="h-8 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
                Go
              </button>
            </form>
          </div>

          {loading && <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>}

          {!loading && stations.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 py-12 text-center text-sm text-muted-foreground">
              <Radio className="mb-2 size-8 opacity-30" />
              No stations found — try a different search.
            </div>
          )}

          {!loading && stations.length > 0 && (
            <div className="space-y-1.5">
              {stations.map((station) => {
                const isActive = activeId === station.id
                const [c1, c2] = GENRE_COLORS[selectedGenre ?? ''] ?? ['#f97316', '#ea580c']
                return (
                  <button key={station.id} type="button" onClick={() => playStation(station)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-all',
                      isActive
                        ? 'border-transparent shadow-sm'
                        : 'border-border hover:border-border/80 hover:bg-muted/20',
                    )}
                    style={isActive ? { background: `linear-gradient(135deg, ${c1}18, ${c2}10)`, borderColor: `${c1}40` } : {}}>
                    <div className="size-12 shrink-0 overflow-hidden rounded-xl bg-muted">
                      <StationArt favicon={station.favicon} fallbackEmoji={GENRE_ICONS[selectedGenre ?? ''] ?? '📻'} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={cn('truncate text-sm font-semibold', isActive && 'text-orange-400')}>{station.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[station.country, station.codec, station.bitrate ? `${station.bitrate}k` : null].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <div className="shrink-0 w-5 flex justify-center">
                      {isActive
                        ? <span className="inline-flex size-2 animate-pulse rounded-full bg-orange-500" />
                        : <div className="size-4 rounded-full border border-border/60 flex items-center justify-center">
                            <div className="size-1.5 rounded-full bg-muted-foreground/40" />
                          </div>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
