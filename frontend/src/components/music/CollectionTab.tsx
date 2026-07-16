// Library → Collection: the household's owned music (local folders + uploads; Plex music
// joins in a later phase). Moosic-style compact browsing - Artists / Albums / Songs
// sub-views with inline drill-in, per-row codec badges, and browser upload (button + drop
// target). Everything plays through the shared radio engine via `local:` refs.

import { useCallback, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronLeft, Disc3, FolderPlus, ListMusic, Mic2, Music4, Play, Search, Upload } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { useRadio } from '@/context/RadioContext'
import type { QueuedTrack } from '@/lib/music/radioEngine'
import { AddToPlaylistButton } from '@/components/music/AddToPlaylistButton'
import {
  getCollectionSummary, getCollectionArtists, getCollectionAlbums, getCollectionAlbum,
  getCollectionSongs, uploadCollectionFile, type CollectionTrack, type CollectionAlbum,
} from '@/lib/music/collectionApi'

type SubView = 'artists' | 'albums' | 'songs'

const fmtDur = (s: number | null) => !s ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

/** "FLAC 44.1/16" / "MP3 320" pill - the lossless story at a glance. */
function CodecBadge({ t }: { t: CollectionTrack }) {
  if (!t.codec) return null
  const codec = t.codec.replace(/MPEG.*Layer 3/i, 'MP3').replace(/MPEG-4\s*/i, '').toUpperCase().slice(0, 10)
  const lossless = /FLAC|ALAC|PCM|WAV|AIFF/i.test(t.codec)
  const detail = lossless && t.sampleRate
    ? `${(t.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')}${t.bitDepth ? `/${t.bitDepth}` : ''}`
    : t.bitrate ? String(t.bitrate) : ''
  return (
    <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
      lossless ? 'bg-brand/15 text-brand' : 'bg-muted text-muted-foreground')}>
      {codec}{detail ? ` ${detail}` : ''}
    </span>
  )
}

const toQueued = (t: CollectionTrack): QueuedTrack => ({
  videoId: t.ref, title: t.title, author: t.artist, thumbnail: t.artUrl ?? '',
})

function ArtBox({ url, icon: Icon, className }: { url: string | null; icon: typeof Disc3; className?: string }) {
  return (
    <div className={cn('relative grid shrink-0 place-items-center overflow-hidden rounded-control bg-gradient-to-br from-brand/30 to-brand/10', className)}>
      <Icon className="absolute size-4 text-brand/60" />
      {url && <img src={url} alt="" loading="lazy" className="relative size-full object-cover"
        onError={e => { e.currentTarget.style.visibility = 'hidden' }} />}
    </div>
  )
}

function SongRow({ t, onPlay }: { t: CollectionTrack; onPlay: () => void }) {
  return (
    <div className={cn('group flex w-full items-center gap-2 px-3 py-2 transition hover:bg-accent/40', !t.browserPlayable && 'opacity-50')}>
      <button onClick={onPlay} disabled={!t.browserPlayable} className="flex min-w-0 flex-1 items-center gap-3 text-left"
        title={t.browserPlayable ? undefined : `${t.codec ?? 'This format'} can't play in the browser yet`}>
        <ArtBox url={t.artUrl} icon={Music4} className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{t.title}</p>
          <p className="truncate text-xs text-muted-foreground">{[t.artist, t.album].filter(Boolean).join(' · ')}</p>
        </div>
      </button>
      <CodecBadge t={t} />
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{fmtDur(t.durationSec)}</span>
      {t.browserPlayable && <AddToPlaylistButton song={{ videoId: t.ref, title: t.title, artist: t.artist ?? undefined }} />}
    </div>
  )
}

function UploadControl({ onDone }: { onDone: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const list = [...files]
    if (!list.length) return
    setBusy(true)
    let ok = 0
    for (let i = 0; i < list.length; i++) {
      setProgress(list.length > 1 ? `${i + 1}/${list.length}` : null)
      try { await uploadCollectionFile(list[i]!); ok++ }
      catch (err) { toast.error(err instanceof Error ? err.message : `Could not upload ${list[i]!.name}`) }
    }
    setBusy(false)
    setProgress(null)
    if (ok) { toast.success(ok === 1 ? 'Added to your collection' : `Added ${ok} songs to your collection`); onDone() }
  }, [onDone])

  return (
    <>
      <input ref={inputRef} type="file" multiple accept="audio/*,.flac,.m4a,.ogg,.opus,.aiff" className="hidden"
        onChange={e => { if (e.target.files) void handleFiles(e.target.files); e.target.value = '' }} />
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? <Spinner className="size-4" /> : <Upload className="size-4" />} Upload{progress ? ` ${progress}` : ''}
      </Button>
    </>
  )
}

export function CollectionTab() {
  const radio = useRadio()
  const navigate = useNavigate()
  const { user } = useAuth()
  const qc = useQueryClient()
  const [view, setView] = useState<SubView>('artists')
  const [q, setQ] = useState('')
  const [artist, setArtist] = useState<string | null>(null)      // artist drill-in
  const [album, setAlbum] = useState<CollectionAlbum | null>(null) // album drill-in
  const [source, setSource] = useState<'local' | 'plex' | null>(null) // All when null
  const [dragOver, setDragOver] = useState(false)

  const { data: summary } = useQuery({ queryKey: ['music-collection-summary'], queryFn: getCollectionSummary })
  const empty = (summary?.total ?? 0) === 0
  // Source chips only matter once BOTH sources contribute tracks.
  const multiSource = (summary?.local.tracks ?? 0) > 0 && (summary?.plex.tracks ?? 0) > 0

  const { data: artists, isLoading: artistsLoading } = useQuery({
    queryKey: ['music-collection-artists', q, source],
    queryFn: () => getCollectionArtists({ q: q || undefined, source: source ?? undefined }),
    enabled: view === 'artists' && !artist && !empty,
  })
  const { data: albums, isLoading: albumsLoading } = useQuery({
    queryKey: ['music-collection-albums', artist, view === 'albums' ? q : '', source],
    queryFn: () => getCollectionAlbums({ artist: artist ?? undefined, q: !artist && view === 'albums' ? q || undefined : undefined, source: source ?? undefined }),
    enabled: (view === 'albums' || !!artist) && !album && !empty,
  })
  const { data: albumTracks, isLoading: albumLoading } = useQuery({
    queryKey: ['music-collection-album', album?.albumArtist, album?.album],
    queryFn: () => getCollectionAlbum(album!.albumArtist, album!.album),
    enabled: !!album,
  })
  const { data: songs, isLoading: songsLoading } = useQuery({
    queryKey: ['music-collection-songs', q, source],
    queryFn: () => getCollectionSongs({ q: q || undefined, source: source ?? undefined }),
    enabled: view === 'songs' && !artist && !album && !empty,
  })

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['music-collection-summary'] })
    void qc.invalidateQueries({ queryKey: ['music-collection-artists'] })
    void qc.invalidateQueries({ queryKey: ['music-collection-albums'] })
    void qc.invalidateQueries({ queryKey: ['music-collection-songs'] })
  }, [qc])

  const playAll = useCallback((tracks: CollectionTrack[], startIndex: number, name: string) => {
    const playable = tracks.filter(t => t.browserPlayable)
    if (!playable.length) return
    const idx = Math.max(0, playable.findIndex(t => t.ref === tracks[startIndex]?.ref))
    radio.playPlaylist(playable.map(toQueued), idx, { name })
  }, [radio])

  const subTabs = useMemo(() => ([
    { id: 'artists' as const, label: 'Artists', icon: Mic2 },
    { id: 'albums' as const, label: 'Albums', icon: Disc3 },
    { id: 'songs' as const, label: 'Songs', icon: Music4 },
  ]), [])

  if (empty) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <ListMusic className="size-8 text-muted-foreground opacity-40" />
        <p className="max-w-sm text-sm text-muted-foreground">
          Your collection is empty. Upload songs here, {user?.role === 'admin' ? 'or add a music folder in Music Settings → Sources, ' : ''}
          and everything plays at its original quality - FLAC included.
        </p>
        <div className="flex items-center gap-2">
          <UploadControl onDone={refresh} />
          {user?.role === 'admin' && (
            <Button size="sm" variant="ghost" onClick={() => navigate('/apps/music/settings/sources')}>
              <FolderPlus className="size-4" /> Add a folder
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn('rounded-card transition', dragOver && 'outline-2 outline-dashed outline-brand/60')}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault(); setDragOver(false)
        const files = [...e.dataTransfer.files].filter(f => /audio|flac|ogg/.test(f.type) || /\.(mp3|flac|m4a|aac|ogg|opus|wav|aiff?)$/i.test(f.name))
        if (files.length) {
          void (async () => {
            let ok = 0
            for (const f of files) { try { await uploadCollectionFile(f); ok++ } catch { toast.error(`Could not upload ${f.name}`) } }
            if (ok) { toast.success(`Added ${ok} song${ok === 1 ? '' : 's'}`); refresh() }
          })()
        }
      }}>
      {/* Controls row */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-control bg-muted p-0.5">
          {subTabs.map(t => (
            <button key={t.id}
              onClick={() => { setView(t.id); setArtist(null); setAlbum(null); setQ('') }}
              className={cn('flex items-center gap-1.5 rounded-control px-3 py-1.5 text-xs font-medium transition',
                view === t.id && !artist && !album ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              <t.icon className="size-3.5" /> {t.label}
            </button>
          ))}
        </div>
        {multiSource && (
          <div className="flex rounded-control bg-muted p-0.5">
            {([null, 'local', 'plex'] as const).map(s => (
              <button key={s ?? 'all'}
                onClick={() => setSource(s)}
                className={cn('rounded-control px-2.5 py-1.5 text-xs font-medium transition',
                  source === s ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                {s === null ? 'All' : s === 'local' ? 'Local' : 'Plex'}
              </button>
            ))}
          </div>
        )}
        <div className="relative min-w-40 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search your collection"
            className="h-8 pl-8 text-sm" disabled={!!artist || !!album} />
        </div>
        <UploadControl onDone={refresh} />
      </div>

      {/* Drill-in breadcrumb */}
      {(artist || album) && (
        <button onClick={() => album ? setAlbum(null) : setArtist(null)}
          className="mb-2 flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground">
          <ChevronLeft className="size-3.5" /> {album ? (artist ?? 'Albums') : 'Artists'}
        </button>
      )}

      {/* Album detail */}
      {album ? (
        <div>
          <div className="mb-3 flex items-center gap-3">
            <ArtBox url={album.artUrl} icon={Disc3} className="size-16" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold">{album.album}</p>
              <p className="truncate text-sm text-muted-foreground">
                {album.albumArtist}{album.year ? ` · ${album.year}` : ''} · {album.trackCount} tracks
              </p>
            </div>
            <Button size="sm" onClick={() => albumTracks && playAll(albumTracks.tracks, 0, album.album)} disabled={!albumTracks?.tracks.length}>
              <Play className="size-4" /> Play
            </Button>
          </div>
          {albumLoading ? <div className="flex justify-center py-10"><Spinner size="lg" /></div> : (
            <div className="divide-y divide-border/50 rounded-card border border-border/60">
              {(albumTracks?.tracks ?? []).map((t, i) => (
                <SongRow key={t.ref} t={t} onPlay={() => playAll(albumTracks!.tracks, i, album.album)} />
              ))}
            </div>
          )}
        </div>
      ) : artist || view === 'albums' ? (
        /* Albums grid (all albums, or one artist's) */
        albumsLoading ? <div className="flex justify-center py-10"><Spinner size="lg" /></div> : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {(albums?.albums ?? []).map(a => (
              <button key={`${a.albumArtist}|${a.album}`} onClick={() => setAlbum(a)}
                className="rounded-card border border-border/60 bg-card p-2.5 text-left transition hover:border-brand/40">
                <ArtBox url={a.artUrl} icon={Disc3} className="mb-2 aspect-square w-full" />
                <p className="truncate text-sm font-semibold">{a.album}</p>
                <p className="truncate text-xs text-muted-foreground">{a.albumArtist}{a.year ? ` · ${a.year}` : ''}</p>
              </button>
            ))}
          </div>
        )
      ) : view === 'artists' ? (
        artistsLoading ? <div className="flex justify-center py-10"><Spinner size="lg" /></div> : (
          <div className="divide-y divide-border/50 rounded-card border border-border/60">
            {(artists?.artists ?? []).map(a => (
              <button key={a.name} onClick={() => setArtist(a.name)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-accent/40">
                <ArtBox url={a.artUrl} icon={Mic2} className="size-10 rounded-full" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.albumCount} album{a.albumCount === 1 ? '' : 's'} · {a.trackCount} song{a.trackCount === 1 ? '' : 's'}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )
      ) : (
        /* Songs flat list */
        songsLoading ? <div className="flex justify-center py-10"><Spinner size="lg" /></div> : (
          <div className="divide-y divide-border/50 rounded-card border border-border/60">
            {(songs?.songs ?? []).map((t, i) => (
              <SongRow key={t.ref} t={t} onPlay={() => playAll(songs!.songs, i, 'Collection')} />
            ))}
          </div>
        )
      )}
    </div>
  )
}
