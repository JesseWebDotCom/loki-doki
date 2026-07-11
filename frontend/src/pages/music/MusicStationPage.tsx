import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Play, Download, Heart, Pencil, Share2, Copy, Trash2, Users, Mic, Music2, CheckCircle2, Headphones, MonitorPlay, ArrowLeft } from 'lucide-react'
import { proxyImg } from '@/lib/img'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { StationArt } from '@/components/music/StationArt'
import { BlendedHeroBackdrop } from '@/components/shared/BlendedHeroBackdrop'
import { useSongArt } from '@/components/music/SongArt'
import { SongDownloadButton } from '@/components/music/SongDownloadButton'
import { OpenInYoutubeButton } from '@/components/music/OpenInYoutubeButton'
import { SaveOfflineDialog } from '@/components/music/SaveOfflineDialog'
import { StationEditorDialog } from '@/components/music/StationEditorDialog'
import { AddToPlaylistButton } from '@/components/music/AddToPlaylistButton'
import { useRadio } from '@/context/RadioContext'
import { useMusicModeOptional } from '@/components/music/MusicLayout'
import {
  getStation, previewStationQueue, deleteStation, shareStation, cloneStation,
  getOfflineStatus, getOfflineTracks, addFavorite, stationToDj,
} from '@/lib/music/catalogApi'

const DJ_LABEL: Record<string, string> = { full: 'Full DJ', minimal: 'DJ minimal', silent: 'No DJ' }

export function MusicStationPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const radio = useRadio()
  const mode = useMusicModeOptional()
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)

  const { data, isLoading } = useQuery({ queryKey: ['music-station', id], queryFn: () => getStation(id), enabled: !!id })
  const { data: preview, isLoading: previewLoading } = useQuery({
    queryKey: ['music-station-preview', id], queryFn: () => previewStationQueue(id, 12), enabled: !!id, staleTime: 5 * 60_000,
  })
  // Hero artwork = the SAME cover song the station's card shows (one source of truth, so
  // the tile you clicked and the hero it opens into always match). The fresh preview's
  // lead only fills in for stations never built before.
  const previewLead = preview?.tracks?.[0] ?? null
  const coverSong = data?.station?.coverTrack ?? (previewLead ? { videoId: previewLead.videoId, title: previewLead.title, artist: previewLead.artist ?? null } : null)
  const heroArt = useSongArt(coverSong?.videoId, coverSong?.title, coverSong?.artist)
  // Live offline-save progress - polls while a snapshot is downloading/rendering.
  const { data: offline } = useQuery({
    queryKey: ['music-offline-status', id], queryFn: () => getOfflineStatus(id), enabled: !!id,
    refetchInterval: q => { const d = q.state.data; return d?.saved && (d.status === 'pending' || d.status === 'partial') ? 3000 : false },
  })
  // The actual saved tracklist (with per-track download status) once the station is saved offline.
  const { data: offTracks } = useQuery({
    queryKey: ['music-offline-tracks', id], queryFn: () => getOfflineTracks(id),
    enabled: !!id && (offline?.saved ?? false),
    refetchInterval: () => (offline?.saved && (offline.status === 'pending' || offline.status === 'partial') ? 4000 : false),
  })

  if (isLoading) return <div className="px-5 pt-10 text-sm text-muted-foreground">Loading…</div>
  if (!data?.station) return <div className="px-5 pt-10 text-sm text-muted-foreground">Station not found.</div>
  const s = data.station

  // Parse "source:movie:Title" | "source:show:{id}:Title" from the origin tag.
  const sourceBackLink = (() => {
    const ref = s.sourceRef ?? ''
    const movieM = ref.match(/^source:movie:(.+)$/)
    if (movieM) return { url: `/movies/${movieM[1]}`, label: decodeURIComponent(movieM[1]) }
    const showM = ref.match(/^source:show:(\d+):(.+)$/)
    if (showM) return { url: `/shows/${showM[1]}`, label: decodeURIComponent(showM[2]) }
    return null
  })()

  // Offline-save state for this station (saved? still downloading? fully ready?).
  const offSaved = offline?.saved ?? false
  const offReady = offSaved && offline?.status === 'ready'
  const offBusy = offSaved && (offline?.status === 'pending' || offline?.status === 'partial')
  const tDone = offline?.tracksReady ?? 0, tTotal = offline?.trackTotal ?? 0
  const dDone = offline?.djReady ?? 0, dTotal = offline?.djTotal ?? 0
  const vDone = offline?.videoReady ?? 0
  const offMedia = offline?.media
  // Offline mode only exposes the modes whose media is downloaded.
  const canListen = mode === 'online' || !offSaved || offMedia === 'audio' || offMedia === 'both'
  const canWatch = mode === 'online' || (offSaved && (offMedia === 'video' || offMedia === 'both'))
  // Progress reflects whatever media is being saved (audio tracks + DJ, and/or videos).
  const wantA = offMedia === 'audio' || offMedia === 'both'
  const wantV = offMedia === 'video' || offMedia === 'both'
  const offDone = (wantA ? tDone + dDone : 0) + (wantV ? vDone : 0)
  const offNeed = (wantA ? tTotal + dTotal : 0) + (wantV ? tTotal : 0)
  const offPct = offNeed ? Math.round((offDone / offNeed) * 100) : 0
  const invalidateOffline = () => {
    qc.invalidateQueries({ queryKey: ['music-offline-status', id] })
    qc.invalidateQueries({ queryKey: ['music-offline-tracks', id] })
    qc.invalidateQueries({ queryKey: ['music-offline-stations'] })
  }

  const refresh = () => { qc.invalidateQueries({ queryKey: ['music-stations'] }); qc.invalidateQueries({ queryKey: ['music-station', id] }) }
  const play = () => { radio.start(stationToDj(s)); navigate('/music/now-playing') }
  const favorite = async () => {
    try { await addFavorite({ kind: 'station', refId: s.id, title: s.name }); toast.success('Added to favorites') }
    catch { toast.error('Could not favorite') }
  }
  const toggleShare = async () => {
    try { const { visibility } = await shareStation(s.id, s.visibility !== 'shared'); refresh(); toast.success(visibility === 'shared' ? 'Shared with the family' : 'Made private') }
    catch { toast.error('Could not update sharing') }
  }
  const clone = async () => {
    try { const r = await cloneStation(s.id); refresh(); toast.success('Copied to your stations'); navigate(`/music/station/${r.station.id}`) }
    catch { toast.error('Could not copy station') }
  }
  const doDelete = async () => {
    try { await deleteStation(s.id); await qc.invalidateQueries({ queryKey: ['music-stations'] }); toast.success('Station deleted'); navigate('/music/stations') }
    catch { toast.error('Could not delete station') }
  }

  return (
    <div>
      {/* Hero - the station's lead track cover dissolving into its accent color. */}
      <div className="relative overflow-hidden">
        <BlendedHeroBackdrop art={heroArt} color={stationToDj(s).color} colorDark={stationToDj(s).colorDark}
          fallback={<StationArt station={s} className="absolute inset-0" showName={false} />} />
        <div className="relative bg-gradient-to-t from-black/70 via-transparent to-transparent px-5 pb-5 pt-24">
          <p className="text-overline text-white/70">Station</p>
          <div className="mt-1 text-display text-white drop-shadow sm:text-display-lg">{s.name}</div>
          {s.description && !s.description.startsWith('source:') && (
            <p className="mt-1 max-w-2xl text-sm text-white/80">{s.description}</p>
          )}
          {sourceBackLink && (
            <button onClick={() => navigate(sourceBackLink.url)}
              className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-medium text-white/70 transition hover:text-white">
              <ArrowLeft className="size-3.5" /> {sourceBackLink.label}
            </button>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="secondary"><Mic className="mr-1 size-3" /> {DJ_LABEL[s.djMode] ?? 'Full DJ'}</Badge>
            {s.isBuiltin && <Badge variant="secondary">Featured</Badge>}
            {s.visibility === 'shared' && !s.ownerName && <Badge variant="secondary">Shared</Badge>}
            {s.ownerName && <span className="flex items-center gap-1 text-xs text-white/70"><Users className="size-3" /> by {s.ownerName}</span>}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 px-5 pt-4">
        {canListen && <Button onClick={play}><Headphones className="size-4" /> Listen</Button>}
        {canWatch && <Button variant="secondary" onClick={() => navigate(`/music/watch/${s.id}`)}><MonitorPlay className="size-4" /> Watch</Button>}
        <Button variant="secondary" onClick={favorite}><Heart className="size-4" /> Favorite</Button>
        <Button variant="secondary" onClick={() => setSaveOpen(true)} disabled={offBusy}>
          {offBusy ? <Spinner className="text-current" /> : offReady ? <CheckCircle2 className="size-4 text-success" /> : <Download className="size-4" />}
          {offBusy ? `Saving… ${offPct}%` : offReady ? 'Saved offline' : offSaved ? 'Manage offline' : 'Save offline'}
        </Button>
        {s.owned ? (
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="size-4" /> Edit</Button>
            <Button variant="secondary" onClick={toggleShare}><Share2 className="size-4" /> {s.visibility === 'shared' ? 'Make private' : 'Share'}</Button>
            <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" /> Delete</Button>
          </>
        ) : (
          <Button variant="secondary" onClick={clone}><Copy className="size-4" /> Make a copy</Button>
        )}
      </div>

      {/* Offline-save progress - persistent, honest feedback while songs download + the DJ renders. */}
      {offBusy && (
        <div className="px-5 pt-3">
          <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Saving offline
              {wantA ? `: ${tDone}/${tTotal} songs${dTotal ? ` · DJ ${dDone}/${dTotal}` : ''}` : ''}
              {wantV ? `${wantA ? ' · ' : ': '}${vDone}/${tTotal} videos` : ''}
            </span>
            <span>{offPct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-[var(--music-accent)] transition-all" style={{ width: `${offPct}%` }} />
          </div>
        </div>
      )}

      {/* About / prompt */}
      {s.aiPrompt && (
        <div className="px-5 pt-5">
          <SectionHeader title="About this station" />
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{s.aiPrompt}</p>
        </div>
      )}

      {/* Once saved offline: the actual downloaded tracklist with per-track status. Otherwise a
          fresh sample of what the (generative) station tends to play. */}
      {offSaved ? (
        <div className="px-5 pb-6 pt-5">
          <SectionHeader title="Downloaded songs" />
          {offTracks?.tracks.length ? (
            <div className="divide-y divide-border/50 rounded-card border border-border/60">
              {offTracks.tracks.map((t, i) => {
                const aOk = !wantA || t.status === 'ready'
                const vOk = !wantV || t.videoStatus === 'ready'
                const ready = aOk && vOk
                const failed = (wantA && t.status === 'failed') || (wantV && t.videoStatus === 'failed')
                const audioReady = wantA && t.status === 'ready'
                // Click plays the audio deck when audio is saved; for a video-only save it opens Watch.
                const onPlay = () => audioReady ? radio.playTrack({ videoId: t.videoId, title: t.title, author: t.artist }) : navigate(`/music/watch/${s.id}`)
                return (
                  <div key={t.videoId + i} className="group flex w-full items-center gap-2 px-3 py-2 transition hover:bg-accent/40">
                    <button onClick={onPlay} disabled={!ready} className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-60">
                      <div className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-control bg-gradient-to-br from-brand/30 to-brand/10">
                        <Music2 className="absolute size-4 text-brand/60" />
                        <img src={proxyImg(`https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg`)} alt="" loading="lazy"
                          className="relative size-full object-cover" onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
                        {ready && <span className="absolute inset-0 grid place-items-center bg-black/45 opacity-0 transition group-hover:opacity-100"><Play className="size-4 fill-white text-white" /></span>}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{t.title}</p>
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          {t.artist && <span className="truncate">{t.artist}</span>}
                          {ready && wantV && <span className="rounded-full bg-foreground/10 px-1.5 font-medium">Video</span>}
                        </div>
                      </div>
                      {ready ? <CheckCircle2 className="size-4 shrink-0 text-success" />
                        : failed ? <span className="shrink-0 text-caption font-medium text-destructive">failed</span>
                          : <Spinner className="shrink-0" />}
                    </button>
                    <AddToPlaylistButton song={{ videoId: t.videoId, title: t.title, artist: t.artist ?? undefined }} />
                    <OpenInYoutubeButton videoId={t.videoId} title={t.title} />
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner /> Preparing your downloads…</div>
          )}
        </div>
      ) : (
        <div className="px-5 pb-6 pt-5">
          <SectionHeader title="A sample of what's playing" />
          {previewLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner /> Building a preview…</div>
          ) : preview?.tracks.length ? (
            <div className="divide-y divide-border/50 rounded-card border border-border/60">
              {preview.tracks.map((t, i) => (
                <div key={t.videoId + i} className="group flex w-full items-center gap-2 px-3 py-2 transition hover:bg-accent/40">
                  <button onClick={() => radio.playTrack({ videoId: t.videoId, title: t.title, author: t.artist })}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <div className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-control bg-gradient-to-br from-brand/30 to-brand/10">
                      <Music2 className="absolute size-4 text-brand/60" />
                      <img src={proxyImg(`https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg`)} alt="" loading="lazy"
                        className="relative size-full object-cover" onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
                    </div>
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{t.title}</p>{t.artist && <p className="truncate text-xs text-muted-foreground">{t.artist}</p>}</div>
                  </button>
                  <AddToPlaylistButton song={{ videoId: t.videoId, title: t.title, artist: t.artist ?? undefined }} />
                  <OpenInYoutubeButton videoId={t.videoId} title={t.title} />
                  <SongDownloadButton videoId={t.videoId} title={t.title} />
                </div>
              ))}
              <p className="px-3 py-2 text-caption text-muted-foreground">The station builds a fresh mix each time you tune in; this is just a taste.</p>
            </div>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">Couldn't build a preview right now. Hit Play to tune in.</p>
          )}
        </div>
      )}

      <StationEditorDialog open={editing} onOpenChange={o => { setEditing(o); if (!o) refresh() }} station={s} />
      <SaveOfflineDialog open={saveOpen} onOpenChange={setSaveOpen} stationId={s.id} saved={offSaved} onChanged={invalidateOffline} />
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete}
        title="Delete this station?" description="This permanently removes the station. This cannot be undone."
        confirmLabel="Delete" destructive onConfirm={doDelete} />
    </div>
  )
}
