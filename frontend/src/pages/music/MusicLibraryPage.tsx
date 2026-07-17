import { useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Heart, ListMusic, History, Download, Plus, Play, Pause, Trash2, Sparkles, Pencil, Check, X, RadioTower, Square, Library, ChevronRight, Wand2, Filter, Users } from 'lucide-react'
import { cn } from '@/lib/cn'
import { SongArt } from '@/components/music/SongArt'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { listTracks, renameTrack, deleteTrack, trackAudioUrl, type MusicTrack } from '@/lib/music/api'
import { fmtBytes } from '@/lib/youtube/format'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { AppTabBar, type AppTab } from '@/components/shared/AppTabBar'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot } from '@/components/shared/StatusDot'
import { PageContainer } from '@/components/shared/PageContainer'
import { useRadio } from '@/context/RadioContext'
import { useLiveRadio } from '@/context/LiveRadioContext'
import { LiveStationFavicon, stationTagLine } from '@/components/music/LiveStationCard'
import {
  fetchLiveLibrary, removeLiveStation, listRecordings, stopRecording, deleteRecording,
  type LiveLibraryStation, type LiveRecording,
} from '@/lib/music/liveRadioApi'
import { useMusicModeOptional } from '@/components/music/MusicLayout'
import { getCollectionSummary } from '@/lib/music/collectionApi'
import { StationCard } from '@/components/music/StationCard'
import { SongDownloadButton } from '@/components/music/SongDownloadButton'
import { CollectionTab } from '@/components/music/CollectionTab'
import { OpenInYoutubeButton } from '@/components/music/OpenInYoutubeButton'
import { AddToPlaylistButton } from '@/components/music/AddToPlaylistButton'
import { MagicVibeDialog, SmartPlaylistDialog } from '@/components/music/PlaylistCreators'
import { FamilyBlendDialog } from '@/components/music/FamilyBlendDialog'
import { TrackRadioButton } from '@/components/music/TrackRadioButton'
import { Switch } from '@/components/ui/switch'
import { getAutocache, setAutocache } from '@/lib/music/intelApi'
import { useOfflineStations, useOfflineSongs } from '@/lib/music/useOffline'
import {
  getFavorites, getHistory, listPlaylists, createPlaylist,
  listOffline, listOfflineStations, removeOffline, removeOfflineStation,
} from '@/lib/music/catalogApi'
import { OfflineSelectionToolbar } from '@/components/shared/OfflineSelectionToolbar'

/** In offline mode, the set of song videoIds + station ids that are actually downloaded - used to
 *  hide library rows that couldn't play without internet. Returns null (no filtering) when online. */
function useOfflineAvailable() {
  const offline = useMusicModeOptional() === 'offline'
  const { data: off } = useQuery({ queryKey: ['music-offline'], queryFn: listOffline, enabled: offline, refetchInterval: offline ? 5000 : false })
  const { data: offSt } = useQuery({ queryKey: ['music-offline-stations'], queryFn: listOfflineStations, enabled: offline })
  if (!offline) return null
  return {
    songs: new Set((off?.offline ?? []).filter(t => t.status === 'ready').map(t => t.videoId)),
    stations: new Set((offSt?.stations ?? []).map(s => s.id)),
  }
}

type Tab = 'collection' | 'favorites' | 'playlists' | 'history' | 'radio' | 'offline' | 'created'
const TABS: AppTab<Tab>[] = [
  { id: 'collection', label: 'Collection', icon: Library },
  { id: 'favorites', label: 'Favorites', icon: Heart },
  { id: 'playlists', label: 'Playlists', icon: ListMusic },
  { id: 'created', label: 'Created', icon: Sparkles },
  { id: 'history', label: 'History', icon: History },
  { id: 'radio', label: 'Radio', icon: RadioTower },
  { id: 'offline', label: 'Offline', icon: Download },
]

const fmtDur = (s: number | null) => !s ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

function TrackRow({ track, onChanged }: { track: MusicTrack; onChanged: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(track.title)
  const [confirmDel, setConfirmDel] = useState(false)
  const toggle = () => { const el = audioRef.current; if (!el) return; if (playing) el.pause(); else el.play().catch(() => setPlaying(false)) }
  const rename = async () => {
    setEditing(false); const t = name.trim()
    if (!t || t === track.title) { setName(track.title); return }
    try { await renameTrack(track.id, t); onChanged() } catch { toast.error('Rename failed'); setName(track.title) }
  }
  const del = async () => { try { await deleteTrack(track.id); toast.success('Deleted'); onChanged() } catch { toast.error('Delete failed') } }
  const sub = [track.kind !== 'track' ? track.kind : null, track.styleId, track.bpm ? `${track.bpm} BPM` : null, track.keyName, fmtDur(track.durationSec)].filter(Boolean).join(' · ')
  return (
    <div className="flex items-center gap-3 rounded-control border border-border bg-card px-3 py-2.5">
      <audio ref={audioRef} src={trackAudioUrl(track.id)} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      <Button type="button" size="icon" onClick={toggle} className="shrink-0" aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause className="size-4" /> : <Play className="size-4" />}</Button>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input value={name} onChange={e => setName(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') { setEditing(false); setName(track.title) } }} className="h-7 py-0 text-sm" />
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => void rename()} className="text-brand" aria-label="Save name"><Check className="size-4" /></Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => { setEditing(false); setName(track.title) }} className="text-muted-foreground" aria-label="Cancel rename"><X className="size-4" /></Button>
          </div>
        ) : (
          <><div className="truncate text-sm font-medium">{track.title}</div><div className="truncate text-xs capitalize text-muted-foreground">{sub}</div></>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditing(true)} className="text-muted-foreground hover:text-foreground" aria-label="Rename"><Pencil className="size-4" /></Button>
          <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground">
            <a href={trackAudioUrl(track.id)} download={`${track.title}.wav`} aria-label="Download"><Download className="size-4" /></a>
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => setConfirmDel(true)} className="text-muted-foreground hover:text-destructive" aria-label="Delete"><Trash2 className="size-4" /></Button>
        </div>
      )}
      <ConfirmDialog open={confirmDel} onOpenChange={setConfirmDel} title="Delete track?" description={`“${track.title}” will be permanently removed.`} destructive confirmLabel="Delete" onConfirm={() => void del()} />
    </div>
  )
}

function CreatedTab() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['music-tracks'], queryFn: () => listTracks() })
  const tracks = data ?? []
  if (isLoading) return <div className="flex justify-center py-12"><Spinner size="lg" /></div>
  if (!tracks.length) return <Empty icon={Sparkles} text="Tracks you generate or remix are saved here." />
  return <div className="space-y-2">{tracks.map(t => <TrackRow key={t.id} track={t} onChanged={() => qc.invalidateQueries({ queryKey: ['music-tracks'] })} />)}</div>
}

function Empty({ icon: Icon, text }: { icon: typeof Heart; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
      <Icon className="size-8 opacity-40" /><p className="text-sm">{text}</p>
    </div>
  )
}

// Square album thumbnail for a song row - real album art with a music-note fallback.
function SongThumb({ videoId, title, artist }: { videoId: string; title?: string | null; artist?: string | null }) {
  return <SongArt trackRef={videoId} title={title} artist={artist} className="size-10" rounded="rounded-control" />
}

function FavoritesTab() {
  const radio = useRadio()
  const avail = useOfflineAvailable()
  const { data } = useQuery({ queryKey: ['music-favorites'], queryFn: () => getFavorites() })
  let favs = data?.favorites ?? []
  if (avail) favs = favs.filter(f => f.kind === 'song' ? avail.songs.has(f.refId) : f.kind === 'station' ? avail.stations.has(f.refId) : false)
  if (!favs.length) return <Empty icon={Heart} text={avail ? 'None of your favorites are saved offline yet.' : 'Songs and stations you heart will show up here.'} />
  return (
    <div className="divide-y divide-border/50 rounded-card border border-border/60">
      {favs.map(f => (
        <div key={f.id} className="group flex w-full items-center gap-2 px-3 py-2 transition hover:bg-accent/40">
          <button onClick={() => f.kind === 'song' && radio.playTrack({ videoId: f.refId, title: f.title ?? '', author: f.artist })}
            className="flex min-w-0 flex-1 items-center gap-3 text-left">
            {f.kind === 'song' ? <SongThumb videoId={f.refId} title={f.title} artist={f.artist} /> : <Heart className="size-4 shrink-0 fill-current text-brand" />}
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{f.title ?? f.refId}</p>{f.artist && <p className="truncate text-xs text-muted-foreground">{f.artist}</p>}</div>
          </button>
          {f.kind === 'song' && (
            <>
              <TrackRadioButton videoId={f.refId} title={f.title ?? ''} artist={f.artist} />
              <AddToPlaylistButton song={{ videoId: f.refId, title: f.title ?? '', artist: f.artist ?? undefined }} />
              <OpenInYoutubeButton videoId={f.refId} title={f.title ?? ''} />
              <SongDownloadButton videoId={f.refId} title={f.title ?? ''} />
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function PlaylistsTab() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['music-playlists'], queryFn: listPlaylists })
  const [creating, setCreating] = useState(false)
  const [magicOpen, setMagicOpen] = useState(false)
  const [smartOpen, setSmartOpen] = useState(false)
  const [blendOpen, setBlendOpen] = useState(false)
  const [name, setName] = useState('')
  const create = async () => {
    const n = name.trim()
    if (!n) return
    try { await createPlaylist({ name: n }); await qc.invalidateQueries({ queryKey: ['music-playlists'] }); toast.success('Playlist created'); setCreating(false); setName('') }
    catch { toast.error('Could not create playlist') }
  }
  const all = [...(data?.mine ?? []), ...(data?.shared ?? [])]
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => { setName(''); setCreating(true) }}><Plus className="size-4" /> New playlist</Button>
        <Button size="sm" variant="secondary" onClick={() => setMagicOpen(true)}><Wand2 className="size-4" /> Magic mix</Button>
        <Button size="sm" variant="secondary" onClick={() => setSmartOpen(true)}><Filter className="size-4" /> Smart playlist</Button>
        <Button size="sm" variant="secondary" onClick={() => setBlendOpen(true)}><Users className="size-4" /> Family blend</Button>
      </div>
      <MagicVibeDialog open={magicOpen} onOpenChange={v => { setMagicOpen(v); if (!v) void qc.invalidateQueries({ queryKey: ['music-playlists'] }) }} />
      <SmartPlaylistDialog open={smartOpen} onOpenChange={v => { setSmartOpen(v); if (!v) void qc.invalidateQueries({ queryKey: ['music-playlists'] }) }} />
      <FamilyBlendDialog open={blendOpen} onOpenChange={v => { setBlendOpen(v); if (!v) void qc.invalidateQueries({ queryKey: ['music-playlists'] }) }} />
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>New playlist</DialogTitle></DialogHeader>
          <Input value={name} autoFocus placeholder="Playlist name" onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void create() }} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={create} disabled={!name.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!all.length ? <Empty icon={ListMusic} text="Create a playlist to collect your favorite tracks." /> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {all.map(p => (
            <Card key={p.id} variant="interactive" className="p-3" onClick={() => navigate(`/music/playlist/${p.id}`)}>
              <div className="relative mb-2 flex aspect-square items-center justify-center rounded-control bg-gradient-to-br from-brand/30 to-brand/10">
                {p.kind === 'magic' ? <Wand2 className="size-8 text-brand" /> : p.kind === 'smart' ? <Filter className="size-8 text-brand" /> : p.kind === 'blend' ? <Users className="size-8 text-brand" /> : <ListMusic className="size-8 text-brand" />}
                {p.kind !== 'manual' && (
                  <span className="absolute right-1.5 top-1.5 rounded-full bg-brand/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
                    {p.kind === 'magic' ? 'Magic' : p.kind === 'blend' ? 'Blend' : 'Smart'}
                  </span>
                )}
              </div>
              <p className="truncate text-sm font-semibold">{p.name}</p>
              <p className="text-xs text-muted-foreground">{p.kind === 'smart' ? 'Live rules' : `${p.trackCount} track${p.trackCount === 1 ? '' : 's'}`}{p.ownerName ? ` · by ${p.ownerName}` : ''}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function HistoryTab() {
  const radio = useRadio()
  const avail = useOfflineAvailable()
  const { data } = useQuery({ queryKey: ['music-history-full'], queryFn: () => getHistory(60) })
  let hist = data?.history ?? []
  if (avail) hist = hist.filter(h => avail.songs.has(h.videoId))
  if (!hist.length) return <Empty icon={History} text={avail ? 'None of your recently played songs are saved offline.' : 'Your recently played songs will show up here.'} />
  return (
    <div className="divide-y divide-border/50 rounded-card border border-border/60">
      {hist.map(h => (
        <div key={h.id} className="group flex w-full items-center gap-2 px-3 py-2 transition hover:bg-accent/40">
          <button onClick={() => radio.playTrack({ videoId: h.videoId, title: h.title, author: h.artist })}
            className="flex min-w-0 flex-1 items-center gap-3 text-left">
            <SongThumb videoId={h.videoId} title={h.title} artist={h.artist} />
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{h.title}</p>{h.artist && <p className="truncate text-xs text-muted-foreground">{h.artist}</p>}</div>
          </button>
          <TrackRadioButton videoId={h.videoId} title={h.title} artist={h.artist} />
          <AddToPlaylistButton song={{ videoId: h.videoId, title: h.title, artist: h.artist ?? undefined }} />
          <OpenInYoutubeButton videoId={h.videoId} title={h.title} />
          <SongDownloadButton videoId={h.videoId} title={h.title} />
        </div>
      ))}
    </div>
  )
}

// Offline mix auto-cache: a per-user toggle that keeps the listener's top N most-played
// and favorited tracks downloaded via the normal offline pipeline. The downloads land in
// the Songs list below like any other save; this card owns the toggle, size, and status.
function AutocacheCard() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['music-autocache'], queryFn: getAutocache,
    refetchInterval: q => ((q.state.data?.inProgress ?? 0) > 0 ? 5000 : false),
  })
  const mutate = async (patch: { enabled?: boolean; count?: number }) => {
    try {
      const next = await setAutocache(patch)
      qc.setQueryData(['music-autocache'], next)
      void qc.invalidateQueries({ queryKey: ['music-offline'] })
      if (patch.enabled === true) toast.success('Keeping your top songs downloaded')
      if (patch.enabled === false) toast.success('Auto-download off. Downloads are kept.')
    } catch { toast.error('Could not update the setting') }
  }
  const status = data?.enabled
    ? `${data.ready} of ${data.total} ready${data.inProgress ? ` · ${data.inProgress} downloading` : ''}`
    : 'Your most-played and favorited songs, always ready offline.'
  return (
    <div className="max-w-3xl rounded-card border border-border/60 bg-card/30 p-4">
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-sm font-semibold">Keep my favorites downloaded</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{isLoading ? 'Checking…' : status}</span>
        </span>
        <Switch checked={data?.enabled ?? false} disabled={isLoading}
          onCheckedChange={v => void mutate({ enabled: v === true })} />
      </label>
      {data?.enabled && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span>Songs to keep</span>
          {[25, 50, 100].map(n => (
            // design-ok(hand-styled-button): preset chip, not a chrome control
            <button key={n} type="button" onClick={() => void mutate({ count: n })}
              className={cn('rounded-full px-2.5 py-1 font-medium transition',
                data.count === n ? 'bg-brand text-brand-foreground' : 'bg-foreground/8 hover:bg-foreground/15')}>
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Station-first offline view: your downloaded stations as cards (open into the full station page),
// then à-la-carte song downloads (songs not part of any saved station).
function OfflineTab() {
  const radio = useRadio()
  const qc = useQueryClient()
  const { data: stationData } = useOfflineStations()
  const { data } = useOfflineSongs()
  const stations = stationData?.stations ?? []
  const stationSongIds = new Set(data?.stationVideoIds ?? [])
  const songs = (data?.offline ?? []).filter(t => !stationSongIds.has(t.videoId))

  const [selStations, setSelStations] = useState<Set<string>>(new Set())
  const [selSongs, setSelSongs] = useState<Set<string>>(new Set())
  const [busyStations, setBusyStations] = useState(false)
  const [busySongs, setBusySongs] = useState(false)

  const toggleStation = (id: string) => setSelStations(s => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  const toggleSong = (id: string) => setSelSongs(s => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })

  const del = async (videoId: string) => {
    try { await removeOffline(videoId); await qc.invalidateQueries({ queryKey: ['music-offline'] }); toast.success('Removed') }
    catch { toast.error('Could not remove') }
  }
  const clearStations = async (ids: string[]) => {
    setBusyStations(true)
    try {
      await Promise.all(ids.map(id => removeOfflineStation(id)))
      setSelStations(new Set())
      await qc.invalidateQueries({ queryKey: ['music-offline-stations'] })
      toast.success(ids.length === 1 ? 'Station removed from offline' : `${ids.length} stations removed from offline`)
    } catch {
      toast.error('Could not remove all stations')
    } finally {
      setBusyStations(false)
    }
  }
  const clearSongs = async (ids: string[]) => {
    setBusySongs(true)
    try {
      await Promise.all(ids.map(id => removeOffline(id)))
      setSelSongs(new Set())
      await qc.invalidateQueries({ queryKey: ['music-offline'] })
      toast.success(ids.length === 1 ? 'Song removed from offline' : `${ids.length} songs removed from offline`)
    } catch {
      toast.error('Could not remove all songs')
    } finally {
      setBusySongs(false)
    }
  }

  if (!stations.length && !songs.length) {
    return (
      <div className="space-y-6">
        <AutocacheCard />
        <Empty icon={Download} text="Save a station or a song for offline play. They'll show up here, ready without internet." />
      </div>
    )
  }
  // Total storage used by offline audio (every downloaded track, station or à-la-carte).
  const readyAll = (data?.offline ?? []).filter(t => t.status === 'ready')
  const totalBytes = readyAll.reduce((n, t) => n + (t.sizeBytes ?? 0), 0)
  const summary = [
    stations.length ? `${stations.length} station${stations.length === 1 ? '' : 's'}` : '',
    readyAll.length ? `${readyAll.length} song${readyAll.length === 1 ? '' : 's'}` : '',
    totalBytes ? fmtBytes(totalBytes) : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className="space-y-8">
      {summary && <p className="-mt-1 text-xs text-muted-foreground">{summary} downloaded</p>}
      <AutocacheCard />
      {stations.length > 0 && (
        <section>
          <SectionHeader title="Stations" />
          <div className="mb-3">
            <OfflineSelectionToolbar
              totalCount={stations.length}
              selectedCount={selStations.size}
              allSelected={stations.length > 0 && selStations.size === stations.length}
              busy={busyStations}
              itemLabel="station"
              onToggleSelectAll={() => setSelStations(selStations.size === stations.length ? new Set() : new Set(stations.map(s => s.id)))}
              onClearSelected={() => clearStations([...selStations])}
              onClearAll={() => clearStations(stations.map(s => s.id))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {stations.map(s => (
              <div key={s.id} className="group relative">
                <button
                  type="button"
                  onClick={() => toggleStation(s.id)}
                  className={cn('absolute left-2 top-2 z-10 flex size-6 items-center justify-center rounded-full border-2 transition-colors',
                    selStations.has(s.id) ? 'border-brand bg-brand' : 'border-white/70 bg-black/40 opacity-0 group-hover:opacity-100')}
                  aria-label={selStations.has(s.id) ? 'Deselect' : 'Select'}
                >
                  {selStations.has(s.id) && <span className="size-2 rounded-full bg-white" />}
                </button>
                <StationCard station={s} />
              </div>
            ))}
          </div>
        </section>
      )}

      {songs.length > 0 && (
        <section>
          <SectionHeader title="Songs" />
          <div className="mb-3 max-w-3xl">
            <OfflineSelectionToolbar
              totalCount={songs.length}
              selectedCount={selSongs.size}
              allSelected={songs.length > 0 && selSongs.size === songs.length}
              busy={busySongs}
              itemLabel="song"
              onToggleSelectAll={() => setSelSongs(selSongs.size === songs.length ? new Set() : new Set(songs.map(t => t.videoId)))}
              onClearSelected={() => clearSongs([...selSongs])}
              onClearAll={() => clearSongs(songs.map(t => t.videoId))}
            />
          </div>
          <div className="max-w-3xl divide-y divide-border/50 overflow-hidden rounded-card border border-border/60 bg-card/30">
            {songs.map(t => (
              <div key={t.videoId} className="group flex items-center gap-3 px-2.5 py-2 transition hover:bg-accent/40">
                <button
                  type="button"
                  onClick={() => toggleSong(t.videoId)}
                  className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                    selSongs.has(t.videoId) ? 'border-brand bg-brand' : 'border-border')}
                  aria-label={selSongs.has(t.videoId) ? 'Deselect' : 'Select'}
                >
                  {selSongs.has(t.videoId) && <span className="size-1.5 rounded-full bg-white" />}
                </button>
                {t.status === 'ready' ? (
                  <button onClick={() => radio.playTrack({ videoId: t.videoId, title: t.title })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <div className="relative shrink-0">
                      <SongThumb videoId={t.videoId} title={t.title} />
                      <span className="absolute inset-0 grid place-items-center rounded-control bg-black/45 opacity-0 transition group-hover:opacity-100">
                        <Play className="size-4 fill-white text-white" />
                      </span>
                    </div>
                    <p className="truncate text-sm font-medium">{t.title}</p>
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-control bg-muted">
                      {t.status === 'failed'
                        ? <Trash2 className="size-4 text-destructive" />
                        : <Spinner />}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-muted-foreground">{t.title}</p>
                      <p className="text-caption text-muted-foreground/70">{t.status === 'failed' ? 'Download failed' : 'Downloading…'}</p>
                    </div>
                  </div>
                )}
                {t.status === 'ready' && <AddToPlaylistButton song={{ videoId: t.videoId, title: t.title }} />}
                <OpenInYoutubeButton videoId={t.videoId} title={t.title} />
                <button onClick={() => del(t.videoId)} aria-label="Remove download"
                  className="shrink-0 rounded-full p-2 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100">
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// ── Live radio: saved stations + recordings ─────────────────────────────────

function LiveStationRow({ st }: { st: LiveLibraryStation }) {
  const live = useLiveRadio()
  const qc = useQueryClient()
  const [confirmDel, setConfirmDel] = useState(false)
  const del = async () => {
    try { await removeLiveStation(st.id); await qc.invalidateQueries({ queryKey: ['live-radio-library'] }); toast.success('Station removed') }
    catch { toast.error('Could not remove station') }
  }
  return (
    <div className="group flex w-full items-center gap-2 px-3 py-2 transition hover:bg-accent/40">
      <button onClick={() => live.playLive({ id: st.id, name: st.name, favicon: st.favicon })}
        className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <LiveStationFavicon favicon={st.favicon} className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{st.name}</p>
          <p className="truncate text-xs text-muted-foreground">{stationTagLine(st.tags, st.country) || (st.source === 'manual' ? 'Custom stream' : '')}</p>
        </div>
      </button>
      <button onClick={() => setConfirmDel(true)} aria-label="Remove station"
        className="shrink-0 rounded-full p-2 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100">
        <Trash2 className="size-4" />
      </button>
      <ConfirmDialog open={confirmDel} onOpenChange={setConfirmDel} title="Remove station?"
        description={`“${st.name}” will be removed from your stations. Recordings are kept.`}
        destructive confirmLabel="Remove" onConfirm={() => void del()} />
    </div>
  )
}

function RecordingRow({ rec }: { rec: LiveRecording }) {
  const live = useLiveRadio()
  const qc = useQueryClient()
  const [confirmDel, setConfirmDel] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const inProgress = rec.status === 'pending' || rec.status === 'recording'
  const del = async () => {
    try { await deleteRecording(rec.id); await qc.invalidateQueries({ queryKey: ['live-radio-recordings'] }); toast.success('Recording deleted') }
    catch { toast.error('Could not delete recording') }
  }
  const stop = async () => {
    try { await stopRecording(rec.id); await qc.invalidateQueries({ queryKey: ['live-radio-recordings'] }); toast.success('Recording saved') }
    catch { toast.error('Could not stop recording') }
  }
  const meta = [
    new Date(rec.createdAt).toLocaleDateString(),
    rec.durationSec ? fmtDur(rec.durationSec) : null,
    rec.sizeBytes ? fmtBytes(rec.sizeBytes) : null,
  ].filter(Boolean).join(' · ')
  return (
    <div className="group flex w-full items-center gap-2 px-3 py-2 transition hover:bg-accent/40">
      {rec.status === 'ready' ? (
        <button onClick={() => live.playRecording({ id: rec.id, title: rec.title, stationName: rec.stationName })}
          className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <div className="grid size-10 shrink-0 place-items-center rounded-control bg-gradient-to-br from-warning/25 to-warning/15">
            <Play className="size-4 fill-current text-warning" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{rec.title}</p>
            <p className="truncate text-xs text-muted-foreground">{[rec.stationName, meta].filter(Boolean).join(' · ')}</p>
          </div>
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-control bg-muted">
            {rec.status === 'failed'
              ? <X className="size-4 text-destructive" />
              : <Spinner />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-muted-foreground">{rec.title}</p>
            <p className="truncate text-caption text-muted-foreground/70">
              {rec.status === 'failed'
                ? (rec.error ?? 'Recording failed')
                : <span className="inline-flex items-center gap-1.5"><StatusDot status="error" pulse />Recording…</span>}
            </p>
          </div>
        </div>
      )}
      <span className={cnBadge(rec.status)}>{rec.status}</span>
      {inProgress && (
        <button onClick={() => setConfirmStop(true)} aria-label="Stop recording" title="Stop and keep"
          className="shrink-0 rounded-full p-2 text-destructive transition hover:bg-destructive/10">
          <Square className="size-4 fill-current" />
        </button>
      )}
      <button onClick={() => setConfirmDel(true)} aria-label="Delete recording"
        className="shrink-0 rounded-full p-2 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100">
        <Trash2 className="size-4" />
      </button>
      <ConfirmDialog open={confirmStop} onOpenChange={setConfirmStop} title="Stop and keep recording?"
        description="The recording ends now and everything captured so far is saved."
        confirmLabel="Stop and keep" onConfirm={() => void stop()} />
      <ConfirmDialog open={confirmDel} onOpenChange={setConfirmDel} title="Delete recording?"
        description={`“${rec.title}” will be permanently removed.`}
        destructive confirmLabel="Delete" onConfirm={() => void del()} />
    </div>
  )
}

/** Status pill for a recording row. */
function cnBadge(status: LiveRecording['status']): string {
  const base = 'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide'
  if (status === 'ready') return `${base} bg-success/15 text-success`
  if (status === 'failed') return `${base} bg-destructive/15 text-destructive`
  return `${base} bg-destructive/15 text-destructive`
}

function RadioTab() {
  const { data: stations } = useQuery({ queryKey: ['live-radio-library'], queryFn: fetchLiveLibrary })
  const { data: recordings } = useQuery({
    queryKey: ['live-radio-recordings'], queryFn: listRecordings,
    refetchInterval: (query) =>
      (query.state.data ?? []).some(r => r.status === 'pending' || r.status === 'recording') ? 5000 : false,
  })
  const sts = stations ?? []
  const recs = recordings ?? []
  if (!sts.length && !recs.length) {
    return <Empty icon={RadioTower} text="Save live radio stations (and record them) from Music → Live Radio." />
  }
  return (
    <div className="space-y-8">
      {sts.length > 0 && (
        <section>
          <SectionHeader title="Stations" />
          <div className="mt-3 max-w-3xl divide-y divide-border/50 overflow-hidden rounded-card border border-border/60 bg-card/30">
            {sts.map(st => <LiveStationRow key={st.id} st={st} />)}
          </div>
        </section>
      )}
      {recs.length > 0 && (
        <section>
          <SectionHeader title="Recordings" />
          <div className="mt-3 max-w-3xl divide-y divide-border/50 overflow-hidden rounded-card border border-border/60 bg-card/30">
            {recs.map(r => <RecordingRow key={r.id} rec={r} />)}
          </div>
        </section>
      )}
    </div>
  )
}

// Moosic-style Library landing: a compact index card (icon rows with counts + chevrons)
// instead of a wall of tab chips. Picking a row deep-links to that section (?tab=), where
// the tab bar takes over for quick switching.
function LibraryIndex({ onPick }: { onPick: (t: Tab) => void }) {
  const { data: summary } = useQuery({ queryKey: ['music-collection-summary'], queryFn: getCollectionSummary })
  const { data: favs } = useQuery({ queryKey: ['music-favorites'], queryFn: () => getFavorites() })
  const { data: playlists } = useQuery({ queryKey: ['music-playlists'], queryFn: listPlaylists })

  const playlistCount = (playlists?.mine?.length ?? 0) + (playlists?.shared?.length ?? 0)
  const rows: Array<{ tab: Tab; label: string; icon: typeof Heart; count: number | null }> = [
    { tab: 'collection', label: 'Collection', icon: Library, count: summary?.total ?? null },
    { tab: 'playlists', label: 'Playlists', icon: ListMusic, count: playlistCount || null },
    { tab: 'favorites', label: 'Favorites', icon: Heart, count: favs?.favorites?.length ?? null },
    { tab: 'created', label: 'Created', icon: Sparkles, count: null },
    { tab: 'history', label: 'History', icon: History, count: null },
    { tab: 'radio', label: 'Radio', icon: RadioTower, count: null },
    { tab: 'offline', label: 'Downloaded', icon: Download, count: null },
  ]

  return (
    // design-ok(glass-on-plain-bg): elevated list on the Music app's true-black surface
    <div className="max-w-2xl overflow-hidden rounded-sheet bg-white/[0.06]">
      {rows.map((r, i) => (
        <button key={r.tab} onClick={() => onPick(r.tab)}
          className={cn('flex w-full items-center gap-4 px-4 py-3.5 text-left transition hover:bg-white/[0.06]',
            i > 0 && 'border-t border-white/[0.07]')}>
          <r.icon className="size-6 shrink-0 text-brand" />
          <span className="min-w-0 flex-1 truncate text-[17px] font-medium">{r.label}</span>
          {r.count != null && <span className="text-sm tabular-nums text-muted-foreground">{r.count.toLocaleString()}</span>}
          <ChevronRight className="size-5 shrink-0 text-muted-foreground/40" />
        </button>
      ))}
    </div>
  )
}

// "Made For You"-style shelf under the index: pick-up-where-you-left-off cards from history.
function LibraryContinueShelf() {
  const radio = useRadio()
  const { data } = useQuery({ queryKey: ['music-history'], queryFn: () => getHistory() })
  const recent = (data?.history ?? []).slice(0, 12)
  if (!recent.length) return null
  return (
    <section className="mt-8">
      <SectionHeader title="Jump back in" />
      <div className="mt-3 flex gap-4 overflow-x-auto pb-3 pt-1 no-scrollbar">
        {recent.map(h => (
          <button key={h.id} onClick={() => radio.playTrack({ videoId: h.videoId, title: h.title, author: h.artist })}
            className="group w-40 shrink-0 text-left">
            <div className="relative overflow-hidden rounded-card shadow-md transition duration-200 group-hover:scale-[1.03] group-hover:shadow-xl">
              <SongArt trackRef={h.videoId} title={h.title} artist={h.artist} className="aspect-square w-full" />
              <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
              <div className="absolute inset-x-0 bottom-0 p-2.5">
                <p className="truncate text-[13px] font-semibold text-white">{h.title}</p>
                {h.artist && <p className="truncate text-[11px] text-white/60">{h.artist}</p>}
              </div>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

export function MusicLibraryPage() {
  const [params, setParams] = useSearchParams()
  const offline = useMusicModeOptional() === 'offline'
  // No ?tab= → the Moosic-style index landing (offline mode still jumps straight to Offline).
  const rawTab = params.get('tab') as Tab | null
  const tab = rawTab ?? (offline ? 'offline' : null)
  const setTab = (t: Tab) => setParams(p => { p.set('tab', t); return p }, { replace: true })

  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain title="Library" />
      {tab === null ? (
        <>
          <LibraryIndex onPick={setTab} />
          <LibraryContinueShelf />
        </>
      ) : (
        <>
          <AppTabBar tabs={TABS} value={tab} onChange={setTab} className="mb-4" />
          {tab === 'collection' && <CollectionTab />}
          {tab === 'favorites' && <FavoritesTab />}
          {tab === 'playlists' && <PlaylistsTab />}
          {tab === 'created' && <CreatedTab />}
          {tab === 'history' && <HistoryTab />}
          {tab === 'radio' && <RadioTab />}
          {tab === 'offline' && <OfflineTab />}
        </>
      )}
    </PageContainer>
  )
}
