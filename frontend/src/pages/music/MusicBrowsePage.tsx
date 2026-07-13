import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Music2, Play, Search, ArrowDownToLine, HardDrive } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { Spinner } from '@/components/ui/spinner'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { AlbumCover, ArtistAvatar } from '@/components/music/MediaArt'
import { StationCard } from '@/components/music/StationCard'
import { AlbumFilterButton, albumPassesFilters, defaultAlbumFilters, type AlbumFilters } from '@/components/music/AlbumFilterButton'
import { useRadio } from '@/context/RadioContext'
import { useMusicMode } from '@/components/music/MusicLayout'
import { SongTile } from '@/components/music/SongTile'
import { SongArt } from '@/components/music/SongArt'
import { stationGradient } from '@/lib/music/stationColors'
import { proxyImg } from '@/lib/img'
import { toast } from 'sonner'
import { catalogSearch, resolveSong, saveOffline, listOfflineStations, listOffline, listStations, getHistory, getGenreLanding, getArtistId, getAlbumId, matchOwned, type CatalogArtist, type CatalogAlbum, type CatalogSong } from '@/lib/music/catalogApi'

function ArtistChip({ a, onClick }: { a: CatalogArtist; onClick: () => void }) {
  return (
    // design-ok(hand-styled-button): borderless artwork-forward rail tile, not a chrome control
    <button onClick={onClick} className="group flex w-36 shrink-0 flex-col items-center gap-2.5 p-2 text-center">
      <ArtistAvatar name={a.name} mbid={a.mbid}
        className="size-28 rounded-full shadow-md ring-1 ring-white/10 transition duration-200 group-hover:scale-[1.04] group-hover:ring-white/25" />
      <p className="w-full truncate text-sm font-medium">{a.name}</p>
    </button>
  )
}

function AlbumCard({ al, onClick }: { al: CatalogAlbum; onClick: () => void }) {
  return (
    // design-ok(hand-styled-button): borderless artwork-forward rail tile, not a chrome control
    <button onClick={onClick} className="flex w-40 shrink-0 flex-col gap-2 rounded-card p-2 text-left transition hover:bg-accent/50">
      <AlbumCover coverUrl={al.coverUrl} artist={al.artistName} album={al.title} className="aspect-square w-full rounded-control" />
      <div><p className="truncate text-sm font-medium">{al.title}</p><p className="truncate text-[11px] text-muted-foreground">{al.artistName}{al.year ? ` · ${al.year}` : ''}</p></div>
    </button>
  )
}

/** Download control for a catalog (search) song: resolve it to a YouTube id on click, then save
 *  offline. Catalog rows have no videoId up front, so this can't show a persistent "downloaded"
 *  state the way SongDownloadButton does - it just kicks off the save. */
function SongDownloadSearchButton({ song }: { song: CatalogSong }) {
  const [busy, setBusy] = useState(false)
  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      const r = await resolveSong({ mbid: song.mbid, title: song.title, artist: song.artistName, durationSec: song.durationSec })
      if (!r) { toast.error('Could not find that song'); return }
      await saveOffline({ videoId: r.videoId, title: r.title })
      toast.success('Downloading…')
    } catch { toast.error('Could not download') }
    finally { setBusy(false) }
  }
  return (
    // design-ok(hand-styled-button): row-hover reveal icon affordance inside a track row
    <button type="button" onClick={onClick} aria-label="Download for offline" title="Download for offline"
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition hover:bg-accent/60 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100">
      {busy ? <Spinner className="text-current" /> : <ArrowDownToLine className="size-4" />}
    </button>
  )
}



/** Offline browse: no catalog (that's a network call) - just substring-filter the stations and
 *  songs you've downloaded. Mirrors the YouTube offline-search pattern (SearchResults.tsx). */
function OfflineBrowse({ q }: { q: string }) {
  const navigate = useNavigate()
  const radio = useRadio()
  const [term, setTerm] = useState(q)
  useEffect(() => { setTerm(q) }, [q])
  // Poll only while a save is actually in progress (matches useOffline.ts); the pages used to
  // hit these ~4-query-per-station endpoints every 5s for the whole time they were open.
  const { data: stationData } = useQuery({ queryKey: ['music-offline-stations'], queryFn: listOfflineStations, refetchInterval: q => (q.state.data?.stations.some(s => s.offline.status === 'pending' || s.offline.status === 'partial') ? 4000 : false) })
  const { data: offlineData } = useQuery({ queryKey: ['music-offline'], queryFn: listOffline, refetchInterval: q => (q.state.data?.offline.some(t => t.status === 'pending' || t.status === 'downloading') ? 4000 : false) })

  const needle = q.toLowerCase()
  const stations = (stationData?.stations ?? []).filter(s => s.name.toLowerCase().includes(needle))
  const songs = (offlineData?.offline ?? []).filter(t => t.status === 'ready' && t.title.toLowerCase().includes(needle))

  const search = (value: string) => { const t = value.trim(); navigate(t ? `/music/browse?q=${encodeURIComponent(t)}` : '/music/browse') }
  const SearchBar = (
    <form onSubmit={e => { e.preventDefault(); search(term) }} className="mb-5 flex gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={term} onChange={e => setTerm(e.target.value)} autoFocus placeholder="Search your offline stations…" className="pl-9" />
      </div>
      <Button type="submit">Search</Button>
    </form>
  )

  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain
        title={q ? `“${q}”` : 'Browse offline'} subtitle={q ? undefined : 'Everything you’ve saved for offline play.'} />
      {SearchBar}

      {stations.length > 0 && (
        <section className="mt-2"><SectionHeader title="Stations" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {stations.map(st => <StationCard key={st.id} station={st} />)}
          </div>
        </section>
      )}

      {songs.length > 0 && (
        <section className="mt-6 mb-4"><SectionHeader title="Songs" />
          <div className="divide-y divide-border/50 rounded-card border border-border/60">
            {songs.map(s => (
              <button key={s.videoId} onClick={() => radio.playTrack({ videoId: s.videoId, title: s.title })}
                className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-accent/40">
                <Music2 className="size-4 shrink-0 text-muted-foreground group-hover:hidden" />
                <Play className="hidden size-4 shrink-0 fill-current text-brand group-hover:block" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{s.title}</p></div>
              </button>
            ))}
          </div>
        </section>
      )}

      {!stations.length && !songs.length && (
        <p className="mt-4 text-sm text-muted-foreground">{q ? `Nothing offline matches “${q}”.` : 'No offline content yet. Save a station to play it without internet.'}</p>
      )}
    </PageContainer>
  )
}

/** Search-result song rows, with an "In your library" badge on songs the family owns
 *  (batched /catalog/match lookup - the badge means it will PLAY the owned copy). */
function SongResults({ songs, onPlay }: { songs: CatalogSong[]; onPlay: (s: CatalogSong) => void }) {
  const { data: owned } = useQuery({
    // Deezer results have no MBID, so key the owned-lookup on artist~title (else every search
    // would collide on the same all-empty-mbid cache key).
    queryKey: ['music-owned', songs.map(s => `${s.artistName}~${s.title}`).join(',')],
    queryFn: () => matchOwned(songs.map(s => ({ title: s.title, artist: s.artistName, mbid: s.mbid, durationSec: s.durationSec }))),
    staleTime: 5 * 60 * 1000,
  })
  const ownedIdx = new Map((owned?.matches ?? []).map(m => [m.index, m]))
  return (
    <div className="divide-y divide-border/50 rounded-card border border-border/60">
      {songs.map((s, i) => {
        const own = ownedIdx.get(i)
        return (
          <div key={s.mbid || `${s.artistName}-${s.title}-${i}`} className="group flex w-full items-center gap-2 px-3 py-2.5 transition hover:bg-accent/40">
            <button onClick={() => onPlay(s)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <Music2 className="size-4 shrink-0 text-muted-foreground group-hover:hidden" />
              <Play className="hidden size-4 shrink-0 fill-current text-brand group-hover:block" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.title}</p>
                <p className="truncate text-xs text-muted-foreground">{s.artistName}{s.albumTitle ? ` · ${s.albumTitle}` : ''}</p>
              </div>
            </button>
            {own && (
              <span title={`Plays your ${own.source === 'plex' ? 'Plex' : 'local'} copy${own.codec ? ` (${own.codec.toUpperCase()})` : ''}`}
                className="flex shrink-0 items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
                <HardDrive className="size-3" /> Yours
              </span>
            )}
            <SongDownloadSearchButton song={s} />
          </div>
        )
      })}
    </div>
  )
}

/** /music/browse?artist=<name>: instant landing that resolves the name to THE MusicBrainz
 *  artist and replaces itself with the real artist page - a text search only when no
 *  identity exists. Suggestion picks and name-only chips route here so "clicking an
 *  artist" never dead-ends on a keyword search. */
function ArtistRedirect({ name }: { name: string }) {
  const navigate = useNavigate()
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { mbid } = await getArtistId(name)
        if (cancelled) return
        if (mbid) { navigate(`/music/artist/${mbid}`, { replace: true }); return }
      } catch { /* fall through to search */ }
      if (!cancelled) navigate(`/music/browse?q=${encodeURIComponent(name)}`, { replace: true })
    })()
    return () => { cancelled = true }
  }, [name, navigate])
  return (
    <PageContainer width="wide" className="flex items-center gap-3 pt-16 text-muted-foreground">
      <Spinner /> <span className="text-sm">Opening {name}…</span>
    </PageContainer>
  )
}

/** /music/browse?album=<title>&aartist=<artist>: resolve a Deezer album (no MBID) to THE
 *  release-group and replace with the real album page; falls back to a text search. */
function AlbumRedirect({ title, artist }: { title: string; artist: string }) {
  const navigate = useNavigate()
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { mbid } = await getAlbumId(title, artist)
        if (cancelled) return
        if (mbid) { navigate(`/music/album/${mbid}`, { replace: true }); return }
      } catch { /* fall through to search */ }
      if (!cancelled) navigate(`/music/browse?q=${encodeURIComponent(title)}`, { replace: true })
    })()
    return () => { cancelled = true }
  }, [title, artist, navigate])
  return (
    <PageContainer width="wide" className="flex items-center gap-3 pt-16 text-muted-foreground">
      <Spinner /> <span className="text-sm">Opening {title}…</span>
    </PageContainer>
  )
}

// Genre → gradient accent, mirroring the station-art palette so Browse feels native.
const GENRE_TILES: Array<{ name: string; accent: string }> = [
  { name: 'Pop', accent: 'fuchsia' }, { name: 'Rock', accent: 'rose' },
  { name: 'Hip-Hop', accent: 'violet' }, { name: 'Jazz', accent: 'amber' },
  { name: 'Electronic', accent: 'cyan' }, { name: 'Country', accent: 'amber' },
  { name: 'R&B', accent: 'rose' }, { name: 'Metal', accent: 'slate' },
  { name: 'Classical', accent: 'blue' }, { name: 'Indie', accent: 'emerald' },
  { name: 'Reggae', accent: 'emerald' }, { name: 'Soul', accent: 'violet' },
]

// A genre-chart artist chip: Deezer CDN photo (instant, near-complete coverage) with the
// ArtistAvatar lookup as fallback. Clicking routes through Browse's ?artist= resolver -
// the one canonical "name → artist page" path (text search only when no identity exists).
function GenreArtistChip({ name, picture }: { name: string; picture: string | null }) {
  const navigate = useNavigate()
  return (
    // design-ok(hand-styled-button): borderless artwork-forward rail tile, not a chrome control
    <button onClick={() => navigate(`/music/browse?artist=${encodeURIComponent(name)}`)}
      className="group flex w-32 shrink-0 flex-col items-center gap-2 p-2 text-center">
      {picture ? (
        <img src={proxyImg(picture)} alt="" loading="lazy"
          className="size-24 rounded-full object-cover shadow-md ring-1 ring-white/10 transition duration-200 group-hover:scale-[1.04] group-hover:ring-white/25" />
      ) : (
        <ArtistAvatar name={name} className="size-24 rounded-full shadow-md ring-1 ring-white/10 transition duration-200 group-hover:scale-[1.04] group-hover:ring-white/25" />
      )}
      <p className="w-full truncate text-sm font-medium">{name}</p>
    </button>
  )
}

// A real genre landing: the live genre chart (top songs + the artists behind them) plus
// our stations that match the genre - NOT a text search for the genre word in titles.
function GenreView({ genre }: { genre: string }) {
  const radio = useRadio()
  const { data, isLoading } = useQuery({
    queryKey: ['music-genre', genre], queryFn: () => getGenreLanding(genre), staleTime: 60 * 60 * 1000,
  })
  const { data: buckets } = useQuery({ queryKey: ['music-stations'], queryFn: listStations })
  const needle = genre.toLowerCase()
  const stations = [...(buckets?.builtin ?? []), ...(buckets?.mine ?? []), ...(buckets?.shared ?? [])]
    .filter(s => `${s.name} ${s.description ?? ''} ${s.category ?? ''}`.toLowerCase().includes(needle))
    .slice(0, 8)
  const [busyIdx, setBusyIdx] = useState<number | null>(null)
  const play = async (t: { title: string; artist: string }, i: number) => {
    setBusyIdx(i)
    try {
      const r = await resolveSong({ title: t.title, artist: t.artist })
      if (r) radio.playTrack({ videoId: r.videoId, title: r.title, author: r.artist })
      else toast.error('Could not find that song')
    } finally { setBusyIdx(null) }
  }

  return (
    <>
      {(data?.artists.length ?? 0) > 0 && (
        <section className="mt-2">
          <SectionHeader title={`${genre} artists`} />
          <div className="mt-3 flex gap-2 overflow-x-auto pb-2 no-scrollbar">
            {data!.artists.map(a => (
              <GenreArtistChip key={a.name} name={a.name} picture={a.picture} />
            ))}
          </div>
        </section>
      )}

      {stations.length > 0 && (
        <section className="mt-6">
          <SectionHeader title={`${genre} stations`} />
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {stations.map(s => <StationCard key={s.id} station={s} />)}
          </div>
        </section>
      )}

      <section className="mt-6">
        <SectionHeader title={`Top ${genre} songs`} />
        {isLoading && <p className="mt-3 text-sm text-muted-foreground">Loading the chart…</p>}
        {!isLoading && !(data?.tracks.length ?? 0) && (
          <p className="mt-3 text-sm text-muted-foreground">No chart available for this genre right now.</p>
        )}
        <div className="mt-3 grid gap-1 lg:grid-cols-2">
          {(data?.tracks ?? []).map((t, i) => (
            <button key={`${t.artist}-${t.title}`} onClick={() => void play(t, i)}
              className="group flex items-center gap-3 rounded-card px-2 py-1.5 text-left transition hover:bg-white/[0.06]">
              <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted-foreground/60">{i + 1}</span>
              <SongArt trackRef={null} title={t.title} artist={t.artist} className="size-11" rounded="rounded-control" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t.title}</p>
                <p className="truncate text-xs text-muted-foreground">{t.artist}</p>
              </div>
              {busyIdx === i ? <Spinner size="sm" className="mr-1" /> : (
                <Play className="mr-1 size-4 shrink-0 fill-current opacity-0 transition group-hover:opacity-100" />
              )}
            </button>
          ))}
        </div>
      </section>
    </>
  )
}

// The Apple-Music-style Browse landing: big gradient genre tiles + living shelves
// (recently played + featured stations) instead of a dead wall under the search box.
function BrowseIdle({ onGenre }: { onGenre: (g: string) => void }) {
  const radio = useRadio()
  const { data: buckets } = useQuery({ queryKey: ['music-stations'], queryFn: listStations })
  const { data: hist } = useQuery({ queryKey: ['music-history'], queryFn: () => getHistory(10) })
  const recent = hist?.history ?? []
  const featured = (buckets?.builtin ?? []).slice(8, 16) // a different slice than Listen's grid

  return (
    <>
      <SectionHeader title="Browse by genre" />
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {GENRE_TILES.map(g => (
          <button key={g.name} onClick={() => onGenre(g.name)}
            className="group relative aspect-[16/9] overflow-hidden rounded-card text-left shadow-md transition duration-200 hover:scale-[1.03] hover:shadow-xl"
            style={{ background: stationGradient(g.accent) }}>
            <Music2 aria-hidden className="pointer-events-none absolute -bottom-3 -right-2 size-16 rotate-12 text-white/15" />
            {/* design-ok(font-black): genre tile wordmark, part of the tile art itself */}
            <span className="absolute bottom-2.5 left-3 text-lg font-black tracking-tight text-white [text-shadow:0_1px_4px_rgba(0,0,0,0.35)]">{g.name}</span>
          </button>
        ))}
      </div>

      {recent.length > 0 && (
        <section className="mt-8">
          <SectionHeader title="Jump back in" />
          <div className="mt-3 flex gap-4 overflow-x-auto pb-3 pt-1 no-scrollbar">
            {recent.map(h => (
              <SongTile key={h.id} trackRef={h.videoId} title={h.title} artist={h.artist} size="w-40"
                onClick={() => radio.playTrack({ videoId: h.videoId, title: h.title, author: h.artist })} />
            ))}
          </div>
        </section>
      )}

      {featured.length > 0 && (
        <section className="mt-8">
          <SectionHeader title="Stations to explore" to="/music/stations" />
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {featured.map(s => <StationCard key={s.id} station={s} />)}
          </div>
        </section>
      )}
    </>
  )
}

export function MusicBrowsePage() {
  const navigate = useNavigate()
  const radio = useRadio()
  const { mode } = useMusicMode()
  const [params] = useSearchParams()
  const q = params.get('q')?.trim() ?? ''
  const [term, setTerm] = useState(q)
  const [albumFilters, setAlbumFilters] = useState<AlbumFilters>(defaultAlbumFilters)
  useEffect(() => { setTerm(q) }, [q])
  const { data, isLoading } = useQuery({
    queryKey: ['music-search', q], queryFn: () => catalogSearch(q), enabled: mode === 'online' && q.length > 0,
  })

  const search = (value: string) => { const t = value.trim(); if (t) navigate(`/music/browse?q=${encodeURIComponent(t)}`) }
  const playSong = async (s: CatalogSong) => {
    // Browse songs are catalog entries (no videoId yet) - resolve to a playable id, then play
    // it directly for instant, YouTube-like playback.
    const r = await resolveSong({ mbid: s.mbid, title: s.title, artist: s.artistName, durationSec: s.durationSec })
    if (r) radio.playTrack({ videoId: r.videoId, title: r.title, author: r.artist })
    else toast.error('Could not find that song')
  }

  const SearchBar = (
    <form onSubmit={e => { e.preventDefault(); search(term) }} className="mb-5 flex gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={term} onChange={e => setTerm(e.target.value)} autoFocus placeholder="Search artists, albums, songs, stations…" className="pl-9" />
      </div>
      <Button type="submit">Search</Button>
    </form>
  )

  if (mode === 'offline') return <OfflineBrowse q={q} />

  const artistName = params.get('artist')?.trim() ?? ''
  if (artistName) return <ArtistRedirect name={artistName} />

  const albumTitle = params.get('album')?.trim() ?? ''
  if (albumTitle) return <AlbumRedirect title={albumTitle} artist={params.get('aartist')?.trim() ?? ''} />

  const genre = params.get('genre')?.trim() ?? ''
  if (!q && genre) return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain title={genre} subtitle={`The best of ${genre}, right now.`} />
      {SearchBar}
      <GenreView genre={genre} />
    </PageContainer>
  )

  if (!q) return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain title="Browse" subtitle="Search the catalog for any artist, album, or song." />
      {SearchBar}
      <BrowseIdle onGenre={g => navigate(`/music/browse?genre=${encodeURIComponent(g)}`)} />
    </PageContainer>
  )

  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain title={`“${q}”`} />
      {SearchBar}
      {isLoading && <p className="text-sm text-muted-foreground">Searching…</p>}

      {(data?.artists.length ?? 0) > 0 && (
        <section className="mt-2"><SectionHeader title="Artists" />
          <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
            {data!.artists.map((a, i) => <ArtistChip key={a.mbid || `${a.name}-${i}`} a={a}
              onClick={() => navigate(a.mbid ? `/music/artist/${a.mbid}` : `/music/browse?artist=${encodeURIComponent(a.name)}`)} />)}
          </div>
        </section>
      )}

      {(data?.albums.length ?? 0) > 0 && (() => {
        const visibleAlbums = data!.albums.filter(a => albumPassesFilters(a, albumFilters))
        return (
          <section className="mt-6">
            <SectionHeader title="Albums" count={visibleAlbums.length}
              action={<AlbumFilterButton albums={data!.albums} filters={albumFilters} onChange={setAlbumFilters} />} />
            <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
              {visibleAlbums.map((al, i) => <AlbumCard key={al.mbid || `${al.title}-${i}`} al={al}
                onClick={() => navigate(al.mbid ? `/music/album/${al.mbid}` : `/music/browse?album=${encodeURIComponent(al.title)}&aartist=${encodeURIComponent(al.artistName)}`)} />)}
            </div>
          </section>
        )
      })()}

      {(data?.stations.length ?? 0) > 0 && (
        <section className="mt-6"><SectionHeader title="Stations" />
          <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
            {data!.stations.map(st => (
              <div key={st.id} className="w-56 shrink-0">
                <StationCard station={st} />
              </div>
            ))}
          </div>
        </section>
      )}

      {(data?.songs.length ?? 0) > 0 && (
        <section className="mt-6 mb-4"><SectionHeader title="Songs" />
          <SongResults songs={data!.songs} onPlay={playSong} />
        </section>
      )}

      {data && !data.artists.length && !data.albums.length && !data.songs.length && !data.stations.length && !isLoading && (
        <p className="mt-4 text-sm text-muted-foreground">No results for “{q}”.</p>
      )}
    </PageContainer>
  )
}
