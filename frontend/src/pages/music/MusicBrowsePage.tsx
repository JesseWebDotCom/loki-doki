import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Music2, Play, Search } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { AlbumCover, ArtistAvatar } from '@/components/music/MediaArt'
import { useRadio } from '@/context/RadioContext'
import { toast } from 'sonner'
import { catalogSearch, resolveSong, type CatalogArtist, type CatalogAlbum, type CatalogSong } from '@/lib/music/catalogApi'

function ArtistChip({ a, onClick }: { a: CatalogArtist; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-32 shrink-0 flex-col items-center gap-2 rounded-xl p-2 text-center transition hover:bg-accent/50">
      <ArtistAvatar name={a.name} className="size-24 rounded-full" />
      <div><p className="truncate text-sm font-medium">{a.name}</p>{a.disambiguation && <p className="truncate text-[11px] text-muted-foreground">{a.disambiguation}</p>}</div>
    </button>
  )
}

function AlbumCard({ al, onClick }: { al: CatalogAlbum; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-40 shrink-0 flex-col gap-2 rounded-xl p-2 text-left transition hover:bg-accent/50">
      <AlbumCover coverUrl={al.coverUrl} className="aspect-square w-full rounded-lg" />
      <div><p className="truncate text-sm font-medium">{al.title}</p><p className="truncate text-[11px] text-muted-foreground">{al.artistName}{al.year ? ` · ${al.year}` : ''}</p></div>
    </button>
  )
}

const GENRES = ['Pop', 'Rock', 'Hip-Hop', 'Jazz', 'Electronic', 'Country', 'R&B', 'Metal', 'Classical', 'Indie', 'Reggae', 'Soul']

export function MusicBrowsePage() {
  const navigate = useNavigate()
  const radio = useRadio()
  const [params] = useSearchParams()
  const q = params.get('q')?.trim() ?? ''
  const [term, setTerm] = useState(q)
  useEffect(() => { setTerm(q) }, [q])
  const { data, isLoading } = useQuery({
    queryKey: ['music-search', q], queryFn: () => catalogSearch(q), enabled: q.length > 0,
  })

  const search = (value: string) => { const t = value.trim(); if (t) navigate(`/music/browse?q=${encodeURIComponent(t)}`) }
  const playSong = async (s: CatalogSong) => {
    // Browse songs are catalog entries (no videoId yet) — resolve to a playable id, then play
    // it directly for instant, YouTube-like playback.
    const r = await resolveSong({ mbid: s.mbid, title: s.title, artist: s.artistName, durationSec: s.durationSec })
    if (r) radio.playTrack({ videoId: r.videoId, title: r.title, author: r.artist })
    else toast.error('Could not find that song')
  }

  const SearchBar = (
    <form onSubmit={e => { e.preventDefault(); search(term) }} className="mb-5 flex gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={term} onChange={e => setTerm(e.target.value)} autoFocus placeholder="Search artists, albums, songs…" className="pl-9" />
      </div>
      <Button type="submit">Search</Button>
    </form>
  )

  if (!q) return (
    <div className="px-5 pt-6">
      <PageHeader variant="plain" className="!px-0 !pt-0 !pb-5" eyebrow="Music" title="Browse" subtitle="Search the catalog for any artist, album, or song." />
      {SearchBar}
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground/60">Browse by genre</p>
      <div className="flex flex-wrap gap-2">
        {GENRES.map(g => (
          <button key={g} onClick={() => search(g)} className="rounded-full bg-foreground/8 px-4 py-2 text-sm font-medium transition hover:bg-foreground/15">{g}</button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="px-5 pt-6">
      <PageHeader variant="plain" className="!px-0 !pt-0 !pb-5" eyebrow="Search" title={`“${q}”`} />
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

      {(data?.songs.length ?? 0) > 0 && (
        <section className="mt-6 mb-4"><SectionHeader title="Songs" />
          <div className="divide-y divide-border/50 rounded-xl border border-border/60">
            {data!.songs.map(s => (
              <button key={s.mbid} onClick={() => playSong(s)}
                className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-accent/40">
                <Music2 className="size-4 shrink-0 text-muted-foreground group-hover:hidden" />
                <Play className="hidden size-4 shrink-0 fill-current text-brand group-hover:block" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{s.title}</p><p className="truncate text-xs text-muted-foreground">{s.artistName}{s.albumTitle ? ` · ${s.albumTitle}` : ''}</p></div>
              </button>
            ))}
          </div>
        </section>
      )}

      {data && !data.artists.length && !data.albums.length && !data.songs.length && !isLoading && (
        <p className="mt-4 text-sm text-muted-foreground">No results for “{q}”.</p>
      )}
    </div>
  )
}
