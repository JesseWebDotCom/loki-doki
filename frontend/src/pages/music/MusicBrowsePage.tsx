import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Music2, Play, Search, ArrowDownToLine } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { Spinner } from '@/components/ui/spinner'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { AlbumCover, ArtistAvatar } from '@/components/music/MediaArt'
import { StationCard } from '@/components/music/StationCard'
import { useRadio } from '@/context/RadioContext'
import { useMusicMode } from '@/components/music/MusicLayout'
import { toast } from 'sonner'
import { catalogSearch, resolveSong, saveOffline, listOfflineStations, listOffline, type CatalogArtist, type CatalogAlbum, type CatalogSong } from '@/lib/music/catalogApi'

function ArtistChip({ a, onClick }: { a: CatalogArtist; onClick: () => void }) {
  return (
    // design-ok(hand-styled-button): borderless artwork-forward rail tile, not a chrome control
    <button onClick={onClick} className="flex w-32 shrink-0 flex-col items-center gap-2 rounded-card p-2 text-center transition hover:bg-accent/50">
      <ArtistAvatar name={a.name} mbid={a.mbid} className="size-24 rounded-full" />
      <div><p className="truncate text-sm font-medium">{a.name}</p>{a.disambiguation && <p className="truncate text-[11px] text-muted-foreground">{a.disambiguation}</p>}</div>
    </button>
  )
}

function AlbumCard({ al, onClick }: { al: CatalogAlbum; onClick: () => void }) {
  return (
    // design-ok(hand-styled-button): borderless artwork-forward rail tile, not a chrome control
    <button onClick={onClick} className="flex w-40 shrink-0 flex-col gap-2 rounded-card p-2 text-left transition hover:bg-accent/50">
      <AlbumCover coverUrl={al.coverUrl} className="aspect-square w-full rounded-control" />
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

const GENRES = ['Pop', 'Rock', 'Hip-Hop', 'Jazz', 'Electronic', 'Country', 'R&B', 'Metal', 'Classical', 'Indie', 'Reggae', 'Soul']

/** Offline browse: no catalog (that's a network call) - just substring-filter the stations and
 *  songs you've downloaded. Mirrors the YouTube offline-search pattern (SearchResults.tsx). */
function OfflineBrowse({ q }: { q: string }) {
  const navigate = useNavigate()
  const radio = useRadio()
  const [term, setTerm] = useState(q)
  useEffect(() => { setTerm(q) }, [q])
  const { data: stationData } = useQuery({ queryKey: ['music-offline-stations'], queryFn: listOfflineStations, refetchInterval: 5000 })
  const { data: offlineData } = useQuery({ queryKey: ['music-offline'], queryFn: listOffline, refetchInterval: 5000 })

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
      <PageHeader eyebrow={q ? 'Offline · Search' : 'Music · Offline'}
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

export function MusicBrowsePage() {
  const navigate = useNavigate()
  const radio = useRadio()
  const { mode } = useMusicMode()
  const [params] = useSearchParams()
  const q = params.get('q')?.trim() ?? ''
  const [term, setTerm] = useState(q)
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

  if (!q) return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader eyebrow="Music" title="Browse" subtitle="Search the catalog for any artist, album, or song." />
      {SearchBar}
      <p className="mb-2 text-overline text-muted-foreground/60">Browse by genre</p>
      <div className="flex flex-wrap gap-2">
        {GENRES.map(g => (
          <button key={g} onClick={() => search(g)} className="rounded-full bg-foreground/8 px-4 py-2 text-sm font-medium transition hover:bg-foreground/15">{g}</button>
        ))}
      </div>
    </PageContainer>
  )

  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader eyebrow="Search" title={`“${q}”`} />
      {SearchBar}
      {isLoading && <p className="text-sm text-muted-foreground">Searching…</p>}

      {(data?.artists.length ?? 0) > 0 && (
        <section className="mt-2"><SectionHeader title="Artists" />
          <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
            {data!.artists.map(a => <ArtistChip key={a.mbid} a={a} onClick={() => navigate(`/music/artist/${a.mbid}`)} />)}
          </div>
        </section>
      )}

      {(data?.albums.length ?? 0) > 0 && (
        <section className="mt-6"><SectionHeader title="Albums" />
          <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
            {data!.albums.map(al => <AlbumCard key={al.mbid} al={al} onClick={() => navigate(`/music/album/${al.mbid}`)} />)}
          </div>
        </section>
      )}

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
          <div className="divide-y divide-border/50 rounded-card border border-border/60">
            {data!.songs.map(s => (
              <div key={s.mbid} className="group flex w-full items-center gap-2 px-3 py-2.5 transition hover:bg-accent/40">
                <button onClick={() => playSong(s)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <Music2 className="size-4 shrink-0 text-muted-foreground group-hover:hidden" />
                  <Play className="hidden size-4 shrink-0 fill-current text-brand group-hover:block" />
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{s.title}</p><p className="truncate text-xs text-muted-foreground">{s.artistName}{s.albumTitle ? ` · ${s.albumTitle}` : ''}</p></div>
                </button>
                <SongDownloadSearchButton song={s} />
              </div>
            ))}
          </div>
        </section>
      )}

      {data && !data.artists.length && !data.albums.length && !data.songs.length && !data.stations.length && !isLoading && (
        <p className="mt-4 text-sm text-muted-foreground">No results for “{q}”.</p>
      )}
    </PageContainer>
  )
}
