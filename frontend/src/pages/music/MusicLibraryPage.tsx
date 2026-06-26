import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Heart, ListMusic, History, Download, Plus, Play, Pause, Trash2, Loader2, Sparkles, Pencil, Check, X } from 'lucide-react'
import { proxyImg } from '@/lib/img'
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
import { useRadio } from '@/context/RadioContext'
import { useMusicModeOptional } from '@/components/music/MusicLayout'
import { StationCard } from '@/components/music/StationCard'
import { SongDownloadButton } from '@/components/music/SongDownloadButton'
import { OpenInYoutubeButton } from '@/components/music/OpenInYoutubeButton'
import { useOfflineStations, useOfflineSongs } from '@/lib/music/useOffline'
import {
  getFavorites, getHistory, listPlaylists, createPlaylist,
  listOffline, listOfflineStations, removeOffline,
} from '@/lib/music/catalogApi'

/** In offline mode, the set of song videoIds + station ids that are actually downloaded — used to
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

type Tab = 'favorites' | 'playlists' | 'history' | 'offline' | 'created'
const TABS: AppTab<Tab>[] = [
  { id: 'favorites', label: 'Favorites', icon: Heart },
  { id: 'playlists', label: 'Playlists', icon: ListMusic },
  { id: 'created', label: 'Created', icon: Sparkles },
  { id: 'history', label: 'History', icon: History },
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
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card/40 px-3 py-2.5">
      <audio ref={audioRef} src={trackAudioUrl(track.id)} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      <button type="button" onClick={toggle} className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground" aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause className="size-4" /> : <Play className="size-4" />}</button>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input value={name} onChange={e => setName(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') { setEditing(false); setName(track.title) } }} className="h-7 py-0 text-sm" />
            <button type="button" onClick={() => void rename()} className="text-brand"><Check className="size-4" /></button>
            <button type="button" onClick={() => { setEditing(false); setName(track.title) }} className="text-muted-foreground"><X className="size-4" /></button>
          </div>
        ) : (
          <><div className="truncate text-sm font-medium">{track.title}</div><div className="truncate text-xs capitalize text-muted-foreground">{sub}</div></>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={() => setEditing(true)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Rename"><Pencil className="size-4" /></button>
          <a href={trackAudioUrl(track.id)} download={`${track.title}.wav`} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Download"><Download className="size-4" /></a>
          <button type="button" onClick={() => setConfirmDel(true)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive" aria-label="Delete"><Trash2 className="size-4" /></button>
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
  if (isLoading) return <div className="flex justify-center py-12"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
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

// Square album thumbnail for a song row — YouTube art with a music-note fallback.
function SongThumb({ videoId }: { videoId: string }) {
  return (
    <div className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-gradient-to-br from-brand/30 to-brand/10">
      <ListMusic className="absolute size-4 text-brand/60" />
      <img src={proxyImg(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`)} alt="" loading="lazy"
        className="relative size-full object-cover" onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
    </div>
  )
}

function FavoritesTab() {
  const radio = useRadio()
  const avail = useOfflineAvailable()
  const { data } = useQuery({ queryKey: ['music-favorites'], queryFn: () => getFavorites() })
  let favs = data?.favorites ?? []
  if (avail) favs = favs.filter(f => f.kind === 'song' ? avail.songs.has(f.refId) : f.kind === 'station' ? avail.stations.has(f.refId) : false)
  if (!favs.length) return <Empty icon={Heart} text={avail ? 'None of your favorites are saved offline yet.' : 'Songs and stations you heart will show up here.'} />
  return (
    <div className="divide-y divide-border/50 rounded-xl border border-border/60">
      {favs.map(f => (
        <div key={f.id} className="group flex w-full items-center gap-2 px-3 py-2 transition hover:bg-accent/40">
          <button onClick={() => f.kind === 'song' && radio.playTrack({ videoId: f.refId, title: f.title ?? '', author: f.artist })}
            className="flex min-w-0 flex-1 items-center gap-3 text-left">
            {f.kind === 'song' ? <SongThumb videoId={f.refId} /> : <Heart className="size-4 shrink-0 fill-current text-brand" />}
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{f.title ?? f.refId}</p>{f.artist && <p className="truncate text-xs text-muted-foreground">{f.artist}</p>}</div>
          </button>
          {f.kind === 'song' && <><OpenInYoutubeButton videoId={f.refId} title={f.title ?? ''} /><SongDownloadButton videoId={f.refId} title={f.title ?? ''} /></>}
        </div>
      ))}
    </div>
  )
}

function PlaylistsTab() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['music-playlists'], queryFn: listPlaylists })
  const [creating, setCreating] = useState(false)
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
      <div className="mb-3"><Button size="sm" onClick={() => { setName(''); setCreating(true) }}><Plus className="size-4" /> New playlist</Button></div>
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
            <Card key={p.id} variant="interactive" className="p-3">
              <div className="mb-2 flex aspect-square items-center justify-center rounded-lg bg-gradient-to-br from-brand/30 to-brand/10"><ListMusic className="size-8 text-brand" /></div>
              <p className="truncate text-sm font-semibold">{p.name}</p>
              <p className="text-xs text-muted-foreground">{p.trackCount} track{p.trackCount === 1 ? '' : 's'}{p.ownerName ? ` · by ${p.ownerName}` : ''}</p>
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
    <div className="divide-y divide-border/50 rounded-xl border border-border/60">
      {hist.map(h => (
        <div key={h.id} className="group flex w-full items-center gap-2 px-3 py-2 transition hover:bg-accent/40">
          <button onClick={() => radio.playTrack({ videoId: h.videoId, title: h.title, author: h.artist })}
            className="flex min-w-0 flex-1 items-center gap-3 text-left">
            <SongThumb videoId={h.videoId} />
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{h.title}</p>{h.artist && <p className="truncate text-xs text-muted-foreground">{h.artist}</p>}</div>
          </button>
          <OpenInYoutubeButton videoId={h.videoId} title={h.title} />
          <SongDownloadButton videoId={h.videoId} title={h.title} />
        </div>
      ))}
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
  const del = async (videoId: string) => {
    try { await removeOffline(videoId); await qc.invalidateQueries({ queryKey: ['music-offline'] }); toast.success('Removed') }
    catch { toast.error('Could not remove') }
  }

  if (!stations.length && !songs.length) {
    return <Empty icon={Download} text="Save a station or a song for offline play. They'll show up here, ready without internet." />
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
      {stations.length > 0 && (
        <section>
          <SectionHeader title="Stations" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {stations.map(s => <StationCard key={s.id} station={s} />)}
          </div>
        </section>
      )}

      {songs.length > 0 && (
        <section>
          <SectionHeader title="Songs" />
          <div className="max-w-3xl divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-card/30">
            {songs.map(t => (
              <div key={t.videoId} className="group flex items-center gap-3 px-2.5 py-2 transition hover:bg-accent/40">
                {t.status === 'ready' ? (
                  <button onClick={() => radio.playTrack({ videoId: t.videoId, title: t.title })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <div className="relative shrink-0">
                      <SongThumb videoId={t.videoId} />
                      <span className="absolute inset-0 grid place-items-center rounded-md bg-black/45 opacity-0 transition group-hover:opacity-100">
                        <Play className="size-4 fill-white text-white" />
                      </span>
                    </div>
                    <p className="truncate text-sm font-medium">{t.title}</p>
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-md bg-muted">
                      {t.status === 'failed'
                        ? <Trash2 className="size-4 text-destructive" />
                        : <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-muted-foreground">{t.title}</p>
                      <p className="text-[11px] text-muted-foreground/70">{t.status === 'failed' ? 'Download failed' : 'Downloading…'}</p>
                    </div>
                  </div>
                )}
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

export function MusicLibraryPage() {
  const [params, setParams] = useSearchParams()
  const offline = useMusicModeOptional() === 'offline'
  const tab = (params.get('tab') as Tab) ?? (offline ? 'offline' : 'favorites')
  const setTab = (t: Tab) => setParams(p => { p.set('tab', t); return p }, { replace: true })

  return (
    <div className="px-5 pt-6">
      <PageHeader variant="plain" className="!px-0 !pt-0 !pb-5" eyebrow="Music" title="Your Library" />
      <AppTabBar tabs={TABS} value={tab} onChange={setTab} className="mb-4" />
      {tab === 'favorites' && <FavoritesTab />}
      {tab === 'playlists' && <PlaylistsTab />}
      {tab === 'created' && <CreatedTab />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'offline' && <OfflineTab />}
    </div>
  )
}
