import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '@/lib/toast'
import {
  ArrowLeft, ListVideo, Play, Shuffle, Trash2, Pencil, Check, X, Share2, Copy, GripVertical,
  Download, Music, Video as VideoIcon,
} from 'lucide-react'
import {
  DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { PageContainer } from '@/components/shared/PageContainer'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { VideoThumb } from '@/components/youtube/media'
import { PlaylistCover } from '@/components/youtube/PlaylistCover'
import { fmtDur, resLabel } from '@/lib/youtube/format'
import { getSaveQuality } from '@/lib/youtube/api'
import { useYoutubePlayback, type YtMiniTrack } from '@/context/YoutubePlaybackContext'
import {
  getYtPlaylist, updateYtPlaylist, deleteYtPlaylist, removeYtPlaylistVideo, reorderYtPlaylist,
  shareYtPlaylist, cloneYtPlaylist, startYtPlaylistDownload, getYtPlaylistDownloadStatus,
  type YtPlaylistVideo, type YtPlaylistBatchStatus,
} from '@/lib/youtube/playlists'

const toMiniTrack = (v: YtPlaylistVideo): YtMiniTrack => ({ videoId: v.videoId, title: v.title, author: v.author, durationSec: v.durationSec })

function VideoRow({ video, videos, editable, onRemoved }: { video: YtPlaylistVideo; videos: YtPlaylistVideo[]; editable: boolean; onRemoved: () => void }) {
  const pb = useYoutubePlayback()
  const [removing, setRemoving] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: video.id, disabled: !editable })

  const remove = async () => {
    setRemoving(true)
    try { await removeYtPlaylistVideo(video.playlistId, video.id); onRemoved() }
    catch { toast.error('Could not remove video'); setRemoving(false) }
  }

  const play = () => {
    const idx = videos.findIndex(v => v.id === video.id)
    pb.dock(videos.map(toMiniTrack), Math.max(0, idx), 0)
  }

  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="group flex w-full items-center gap-2 px-2 py-1.5 transition hover:bg-accent/40">
      {editable && (
        <button type="button" {...attributes} {...listeners} aria-label="Drag to reorder"
          className="shrink-0 cursor-grab touch-none p-1 text-muted-foreground/50 opacity-0 transition hover:text-muted-foreground group-hover:opacity-100 active:cursor-grabbing">
          <GripVertical className="size-4" />
        </button>
      )}
      <button onClick={play} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <div className="relative shrink-0">
          <VideoThumb videoId={video.videoId} title={video.title} quality="mq" className="size-10 rounded-control object-cover" />
          <span className="absolute inset-0 grid place-items-center rounded-control bg-black/45 opacity-0 transition group-hover:opacity-100">
            <Play className="size-4 fill-white text-white" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{video.title}</p>
          {video.author && <p className="truncate text-xs text-muted-foreground">{video.author}</p>}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtDur(video.durationSec)}</span>
      </button>
      {editable && (
        <button type="button" onClick={() => void remove()} disabled={removing} aria-label="Remove from playlist"
          className="shrink-0 rounded-full p-2 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100">
          {removing ? <Spinner className="text-current" /> : <Trash2 className="size-4" />}
        </button>
      )}
    </div>
  )
}

function PlaylistDownloadDialog({ playlistId, open, onClose }: { playlistId: string; open: boolean; onClose: () => void }) {
  const [tiers, setTiers] = useState<number[]>([])
  const [cap, setCap] = useState<number | null>(null)
  const [choice, setChoice] = useState('')
  const [starting, setStarting] = useState(false)
  const [status, setStatus] = useState<YtPlaylistBatchStatus | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!open) return
    setChoice(''); setStatus(null)
    getSaveQuality().then(d => { setTiers(d.tiers ?? []); setCap(d.cap); setChoice(`h:${d.pref ?? d.cap}`) }).catch(() => {})
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [open])

  async function start() {
    if (!choice) return
    setStarting(true)
    const isAudio = choice.startsWith('audio')
    const kind: 'audio' | 'video' = isAudio ? 'audio' : 'video'
    const maxHeight = isAudio ? null : Number(choice.slice(2))
    try {
      const { batchId } = await startYtPlaylistDownload(playlistId, { kind, maxHeight })
      pollRef.current = setInterval(async () => {
        const s = await getYtPlaylistDownloadStatus(playlistId, batchId).catch(() => null)
        if (!s) return
        setStatus(s)
        if (s.pending === 0 && s.downloading === 0 && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      }, 1500)
    } catch { toast.error('Could not start download') } finally { setStarting(false) }
  }

  const videoTiers = tiers.filter(t => cap == null || t <= cap).slice().reverse()
  const done = !!status && status.pending === 0 && status.downloading === 0

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-md gap-3 p-4">
        <DialogHeader><DialogTitle className="pr-8 text-sm font-semibold leading-snug">Download entire playlist</DialogTitle></DialogHeader>
        <DialogDescription className="sr-only">Save every video in this playlist for offline viewing.</DialogDescription>
        {status ? (
          <div className="space-y-3 py-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-brand transition-all" style={{ width: `${status.total ? ((status.ready + status.failed) / status.total) * 100 : 0}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {done
                ? (status.failed > 0 ? `Done — ${status.ready} of ${status.total} saved, ${status.failed} failed.` : `All ${status.total} videos saved.`)
                : `${status.ready} of ${status.total} saved…`}
            </p>
            <Button onClick={onClose} variant="outline" className="w-full">{done ? 'Close' : 'Run in background'}</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              {videoTiers.map(t => (
                <label key={t} className="flex cursor-pointer items-center gap-2 rounded-control border border-border/60 px-3 py-2 text-sm hover:bg-muted/50">
                  <input type="radio" name="pldl" checked={choice === `h:${t}`} onChange={() => setChoice(`h:${t}`)} />
                  <VideoIcon className="size-3.5 text-muted-foreground" /> {resLabel(t)} video (MP4)
                </label>
              ))}
              <label className="flex cursor-pointer items-center gap-2 rounded-control border border-border/60 px-3 py-2 text-sm hover:bg-muted/50">
                <input type="radio" name="pldl" checked={choice === 'audio'} onChange={() => setChoice('audio')} />
                <Music className="size-3.5 text-muted-foreground" /> Audio only (M4A)
              </label>
            </div>
            {cap && <p className="text-[10px] text-muted-foreground/60">Max {resLabel(cap)} set by your admin.</p>}
            <Button onClick={start} disabled={starting || !choice} className="w-full font-semibold">
              {starting ? <Spinner className="text-primary-foreground" /> : <Download className="size-4" />} Download all
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function YoutubeMyPlaylistPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const pb = useYoutubePlayback()
  const { data, isLoading } = useQuery({ queryKey: ['yt-playlist', id], queryFn: () => getYtPlaylist(id!), enabled: !!id })
  const [editingName, setEditingName] = useState(false)
  const [name, setName] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [downloadOpen, setDownloadOpen] = useState(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const playlist = data?.playlist
  const videos = data?.videos ?? []
  const editable = !!playlist?.owned

  const invalidate = () => qc.invalidateQueries({ queryKey: ['yt-playlist', id] })

  const startEdit = () => { setName(playlist?.name ?? ''); setEditingName(true) }
  const saveName = async () => {
    setEditingName(false)
    const n = name.trim()
    if (!id || !n || n === playlist?.name) return
    try { await updateYtPlaylist(id, { name: n }); invalidate(); qc.invalidateQueries({ queryKey: ['yt-playlists'] }) }
    catch { toast.error('Rename failed') }
  }

  const toggleShare = async (shared: boolean) => {
    if (!id) return
    try { await shareYtPlaylist(id, shared); invalidate(); toast.success(shared ? 'Playlist shared with the family' : 'Playlist made private') }
    catch { toast.error('Could not update sharing') }
  }

  const playAll = () => pb.dock(videos.map(toMiniTrack), 0, 0)
  const playShuffled = () => {
    const q = videos.map(toMiniTrack)
    for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j]!, q[i]!] }
    pb.dock(q, 0, 0)
  }

  const doClone = async () => {
    if (!id) return
    setCloning(true)
    try {
      const { playlist: cloned } = await cloneYtPlaylist(id)
      qc.invalidateQueries({ queryKey: ['yt-playlists'] })
      toast.success('Playlist cloned to your library')
      navigate(`/youtube/my-playlist/${cloned.id}`)
    } catch { toast.error('Could not clone playlist') }
    finally { setCloning(false) }
  }

  const doDelete = async () => {
    if (!id) return
    try {
      await deleteYtPlaylist(id)
      qc.invalidateQueries({ queryKey: ['yt-playlists'] })
      toast.success('Playlist deleted')
      navigate('/youtube/library?tab=playlists')
    } catch { toast.error('Could not delete playlist') }
  }

  const onDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e
    if (!id || !over || active.id === over.id) return
    const ids = videos.map(v => v.id)
    const oldIdx = ids.indexOf(String(active.id))
    const newIdx = ids.indexOf(String(over.id))
    if (oldIdx < 0 || newIdx < 0) return
    const reordered = arrayMove(ids, oldIdx, newIdx)
    qc.setQueryData(['yt-playlist', id], (prev: typeof data) =>
      prev ? { ...prev, videos: arrayMove(prev.videos, oldIdx, newIdx) } : prev)
    try { await reorderYtPlaylist(id, reordered) }
    catch { toast.error('Could not save the new order'); invalidate() }
  }

  if (isLoading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>
  if (!playlist) return <div className="px-5 pt-10 text-center text-sm text-muted-foreground">Playlist not found.</div>

  return (
    <PageContainer width="wide" className="pt-6 pb-10">
      <button onClick={() => navigate('/youtube/library?tab=playlists')} className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Library
      </button>

      <div className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="w-full shrink-0 sm:w-64 md:w-72">
          <PlaylistCover videoIds={videos.slice(0, 4).map(v => v.videoId)} title={playlist.name} count={videos.length} />
        </div>
        <div className="min-w-0 flex-1">
          {editingName ? (
            <div className="flex items-center gap-1.5">
              <Input value={name} onChange={e => setName(e.target.value)} autoFocus
                onKeyDown={e => { if (e.key === 'Enter') void saveName(); if (e.key === 'Escape') setEditingName(false) }}
                className="h-9 text-xl font-semibold" />
              <button type="button" onClick={() => void saveName()} className="text-[var(--yt-accent)]"><Check className="size-5" /></button>
              <button type="button" onClick={() => setEditingName(false)} className="text-muted-foreground"><X className="size-5" /></button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="truncate text-display">{playlist.name}</div>
              {editable && (
                <button type="button" onClick={startEdit} aria-label="Rename playlist" className="shrink-0 text-muted-foreground hover:text-foreground">
                  <Pencil className="size-4" />
                </button>
              )}
            </div>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            {editable ? (playlist.visibility === 'shared' ? 'Shared with family' : 'Private') : (playlist.ownerName ? `by ${playlist.ownerName}` : 'Shared')}
            {' · '}{videos.length} video{videos.length === 1 ? '' : 's'}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {videos.length > 0 && (
              <>
                <Button onClick={playAll}>
                  <Play className="size-4 fill-current" /> Play all
                </Button>
                <Button variant="outline" onClick={playShuffled}>
                  <Shuffle className="size-4" /> Shuffle
                </Button>
              </>
            )}
            {editable ? (
              <>
                {videos.length > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setDownloadOpen(true)}>
                    <Download className="size-4" /> Download all
                  </Button>
                )}
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch checked={playlist.visibility === 'shared'} onCheckedChange={toggleShare} />
                  <Share2 className="size-4" /> Share with family
                </label>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmDel(true)}>
                  <Trash2 className="size-4" /> Delete
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void doClone()} disabled={cloning}>
                {cloning ? <Spinner className="text-current" /> : <Copy className="size-4" />} Clone to my library
              </Button>
            )}
          </div>
        </div>
      </div>

      {!videos.length ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
          <ListVideo className="size-8 opacity-40" />
          <p className="text-sm">{editable ? 'Add videos from anywhere in YouTube via the “Add to playlist” button.' : 'This playlist is empty.'}</p>
        </div>
      ) : editable ? (
        <DndContext sensors={sensors} onDragEnd={e => void onDragEnd(e)}>
          <SortableContext items={videos.map(v => v.id)} strategy={verticalListSortingStrategy}>
            <div className="divide-y divide-border/50 rounded-card border border-border/60">
              {videos.map(v => <VideoRow key={v.id} video={v} videos={videos} editable onRemoved={invalidate} />)}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="divide-y divide-border/50 rounded-card border border-border/60">
          {videos.map(v => <VideoRow key={v.id} video={v} videos={videos} editable={false} onRemoved={invalidate} />)}
        </div>
      )}

      <ConfirmDialog open={confirmDel} onOpenChange={setConfirmDel} title="Delete this playlist?"
        description={`“${playlist.name}” and its ${videos.length} video${videos.length === 1 ? '' : 's'} will be permanently removed.`}
        destructive confirmLabel="Delete" onConfirm={() => void doDelete()} />
      {id && <PlaylistDownloadDialog playlistId={id} open={downloadOpen} onClose={() => setDownloadOpen(false)} />}
    </PageContainer>
  )
}
