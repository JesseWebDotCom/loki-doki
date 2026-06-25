import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Play, Download, Heart, Pencil, Share2, Copy, Trash2, Users, Mic, Loader2, Music2 } from 'lucide-react'
import { proxyImg } from '@/lib/img'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { StationArt } from '@/components/music/StationArt'
import { StationEditorDialog } from '@/components/music/StationEditorDialog'
import { useRadio } from '@/context/RadioContext'
import {
  getStation, previewStationQueue, deleteStation, shareStation, cloneStation, snapshotStation,
  addFavorite, stationToDj,
} from '@/lib/music/catalogApi'

const DJ_LABEL: Record<string, string> = { full: 'Full DJ', minimal: 'DJ minimal', silent: 'No DJ' }

export function MusicStationPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const radio = useRadio()
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const { data, isLoading } = useQuery({ queryKey: ['music-station', id], queryFn: () => getStation(id), enabled: !!id })
  const { data: preview, isLoading: previewLoading } = useQuery({
    queryKey: ['music-station-preview', id], queryFn: () => previewStationQueue(id, 12), enabled: !!id, staleTime: 5 * 60_000,
  })

  if (isLoading) return <div className="px-5 pt-10 text-sm text-muted-foreground">Loading…</div>
  if (!data?.station) return <div className="px-5 pt-10 text-sm text-muted-foreground">Station not found.</div>
  const s = data.station

  const refresh = () => { qc.invalidateQueries({ queryKey: ['music-stations'] }); qc.invalidateQueries({ queryKey: ['music-station', id] }) }
  const play = () => { radio.start(stationToDj(s)); navigate('/music/now-playing') }
  const favorite = async () => {
    try { await addFavorite({ kind: 'station', refId: s.id, title: s.name }); toast.success('Added to favorites') }
    catch { toast.error('Could not favorite') }
  }
  const snapshot = async () => {
    try { const r = await snapshotStation(s.id); toast.success(`Saving ${r.queued} songs offline…`) }
    catch { toast.error('Could not save offline') }
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
      {/* Hero */}
      <div className="relative overflow-hidden">
        <StationArt station={s} className="absolute inset-0" />
        <div className="relative bg-gradient-to-t from-background via-background/60 to-transparent px-5 pb-5 pt-24">
          <p className="text-xs font-semibold uppercase tracking-widest text-white/70">Station</p>
          <h1 className="mt-1 text-3xl font-black tracking-tight text-white drop-shadow sm:text-4xl">{s.name}</h1>
          {s.description && <p className="mt-1 max-w-2xl text-sm text-white/80">{s.description}</p>}
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
        <Button onClick={play}><Play className="size-4 fill-current" /> Play station</Button>
        <Button variant="secondary" onClick={favorite}><Heart className="size-4" /> Favorite</Button>
        <Button variant="secondary" onClick={snapshot}><Download className="size-4" /> Save offline</Button>
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

      {/* About / prompt */}
      {s.aiPrompt && (
        <div className="px-5 pt-5">
          <SectionHeader title="About this station" />
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{s.aiPrompt}</p>
        </div>
      )}

      {/* Preview of what it plays */}
      <div className="px-5 pb-6 pt-5">
        <SectionHeader title="A sample of what's playing" />
        {previewLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Building a preview…</div>
        ) : preview?.tracks.length ? (
          <div className="divide-y divide-border/50 rounded-xl border border-border/60">
            {preview.tracks.map((t, i) => (
              <button key={t.videoId + i} onClick={() => radio.playTrack({ videoId: t.videoId, title: t.title, author: t.artist })}
                className="group flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-accent/40">
                <div className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-gradient-to-br from-brand/30 to-brand/10">
                  <Music2 className="absolute size-4 text-brand/60" />
                  <img src={proxyImg(`https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg`)} alt="" loading="lazy"
                    className="relative size-full object-cover" onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
                </div>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{t.title}</p>{t.artist && <p className="truncate text-xs text-muted-foreground">{t.artist}</p>}</div>
                <Play className="size-4 shrink-0 opacity-0 group-hover:opacity-100" />
              </button>
            ))}
            <p className="px-3 py-2 text-[11px] text-muted-foreground">The station builds a fresh mix each time you tune in — this is just a taste.</p>
          </div>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">Couldn't build a preview right now. Hit Play to tune in.</p>
        )}
      </div>

      <StationEditorDialog open={editing} onOpenChange={o => { setEditing(o); if (!o) refresh() }} station={s} />
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete}
        title="Delete this station?" description="This permanently removes the station. This cannot be undone."
        confirmLabel="Delete" destructive onConfirm={doDelete} />
    </div>
  )
}
