import { useCallback, useEffect, useState } from 'react'
import { Search, Radio, ChevronLeft } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot } from '@/components/shared/StatusDot'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { searchStations, fetchGenres, type RadioStation, type RadioGenre } from '@/lib/music/radio'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'

const GENRE_COLORS: Record<string, [string, string]> = {
  'pop':       ['#ec4899', '#db2777'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'rock':      ['#f97316', '#dc2626'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'hip-hop':   ['#a855f7', '#7c3aed'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'jazz':      ['#3b82f6', '#1d4ed8'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'classical': ['#94a3b8', '#475569'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'electronic':['#06b6d4', '#0284c7'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'country':   ['#84cc16', '#16a34a'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'r&b':       ['#f43f5e', '#be123c'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'metal':     ['#374151', '#111827'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'reggae':    ['#eab308', '#16a34a'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'blues':     ['#6366f1', '#4338ca'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'indie':     ['#14b8a6', '#0d9488'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'latin':     ['#f59e0b', '#b45309'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'ambient':   ['#818cf8', '#6366f1'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'news':      ['#64748b', '#334155'],   // design-ok(hex-in-tsx): genre tile art palette (data)
  'sports':    ['#10b981', '#059669'],   // design-ok(hex-in-tsx): genre tile art palette (data)
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
        <img src={proxyImg(favicon)} alt="" className="absolute inset-0 size-full object-cover rounded-control"
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
            <Button type="submit" variant="outline" className="text-muted-foreground hover:text-foreground">
              Search
            </Button>
          </form>

          <div>
            <p className="mb-3 text-section">Browse by Genre</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {genres.map((g) => {
                const [c1, c2] = GENRE_COLORS[g.id] ?? ['#6b7280', '#374151']   // design-ok(hex-in-tsx): genre tile art palette (data)
                return (
                  <button key={g.id} type="button" onClick={() => selectGenre(g)}
                    className="relative flex aspect-[2/1] items-end overflow-hidden rounded-card p-3 transition-transform hover:scale-[1.03] active:scale-[0.98]"
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
              <Button type="submit" variant="outline" size="sm" className="text-muted-foreground hover:text-foreground">
                Go
              </Button>
            </form>
          </div>

          {loading && <div className="flex justify-center py-16"><Spinner size="lg" /></div>}

          {!loading && stations.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-border/60 py-12 text-center text-sm text-muted-foreground">
              <Radio className="mb-2 size-8 opacity-30" />
              No stations found. Try a different search.
            </div>
          )}

          {!loading && stations.length > 0 && (
            <div className="space-y-1.5">
              {stations.map((station) => {
                const isActive = activeId === station.id
                const [c1, c2] = GENRE_COLORS[selectedGenre ?? ''] ?? ['#f97316', '#ea580c']   // design-ok(hex-in-tsx): genre tint art palette (data)
                return (
                  <button key={station.id} type="button" onClick={() => playStation(station)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-control border px-3 py-3 text-left transition-all',
                      isActive
                        ? 'border-transparent shadow-sm'
                        : 'border-border hover:border-border/80 hover:bg-muted/20',
                    )}
                    style={isActive ? { background: `linear-gradient(135deg, ${c1}18, ${c2}10)`, borderColor: `${c1}40` } : {}}>
                    <div className="size-12 shrink-0 overflow-hidden rounded-control bg-muted">
                      <StationArt favicon={station.favicon} fallbackEmoji={GENRE_ICONS[selectedGenre ?? ''] ?? '📻'} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={cn('truncate text-sm font-semibold', isActive && 'text-brand')}>{station.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[station.country, station.codec, station.bitrate ? `${station.bitrate}k` : null].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <div className="shrink-0 w-5 flex justify-center">
                      {isActive
                        ? <StatusDot status="error" pulse className="size-2" />
                        : <div className="size-4 rounded-full border border-border/60 flex items-center justify-center">
                            <StatusDot status="off" />
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
