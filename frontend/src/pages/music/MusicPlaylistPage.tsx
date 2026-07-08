import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeft, ListMusic, Play, Trash2, Pencil, Check, X, Share2, Copy, GripVertical,
} from 'lucide-react'
import {
  DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { artUrlForRef } from '@/lib/music/trackRef'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { PageContainer } from '@/components/shared/PageContainer'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useRadio } from '@/context/RadioContext'
import type { QueuedTrack } from '@/lib/music/radioEngine'
import {
  getPlaylist, updatePlaylist, deletePlaylist, removePlaylistTrack, reorderPlaylist,
  sharePlaylist, clonePlaylist, type PlaylistTrack,
} from '@/lib/music/catalogApi'

const fmtDur = (s: number | null) => !s ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const toQueuedTrack = (t: PlaylistTrack): QueuedTrack => ({
  videoId: t.videoId, title: t.title, author: t.artist,
  thumbnail: artUrlForRef(t.videoId) ?? '',
})

function SongThumb({ videoId }: { videoId: string }) {
  return (
    <div className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-control bg-gradient-to-br from-brand/30 to-brand/10">
      <ListMusic className="absolute size-4 text-brand/60" />
      <img src={artUrlForRef(videoId) ?? undefined} alt="" loading="lazy"
        className="relative size-full object-cover" onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
    </div>
  )
}

function TrackRow({ track, tracks, editable, onRemoved }: { track: PlaylistTrack; tracks: PlaylistTrack[]; editable: boolean; onRemoved: () => void }) {
  const radio = useRadio()
  const [removing, setRemoving] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: track.id, disabled: !editable })

  const remove = async () => {
    setRemoving(true)
    try { await removePlaylistTrack(track.playlistId, track.id); onRemoved() }
    catch { toast.error('Could not remove track'); setRemoving(false) }
  }

  const play = () => {
    const idx = tracks.findIndex(t => t.id === track.id)
    radio.playPlaylist(tracks.map(toQueuedTrack), Math.max(0, idx), { playlistId: track.playlistId })
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
      <button onClick={play}
        className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <div className="relative shrink-0">
          <SongThumb videoId={track.videoId} />
          <span className="absolute inset-0 grid place-items-center rounded-control bg-black/45 opacity-0 transition group-hover:opacity-100">
            <Play className="size-4 fill-white text-white" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{track.title}</p>
          {track.artist && <p className="truncate text-xs text-muted-foreground">{track.artist}</p>}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtDur(track.durationSec)}</span>
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

export function MusicPlaylistPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const radio = useRadio()
  const { data, isLoading } = useQuery({ queryKey: ['music-playlist', id], queryFn: () => getPlaylist(id!), enabled: !!id })
  const [editingName, setEditingName] = useState(false)
  const [name, setName] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const [cloning, setCloning] = useState(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const playlist = data?.playlist
  const tracks = data?.tracks ?? []
  const editable = !!playlist?.owned

  const invalidate = () => qc.invalidateQueries({ queryKey: ['music-playlist', id] })

  const startEdit = () => { setName(playlist?.name ?? ''); setEditingName(true) }
  const saveName = async () => {
    setEditingName(false)
    const n = name.trim()
    if (!id || !n || n === playlist?.name) return
    try { await updatePlaylist(id, { name: n }); invalidate(); qc.invalidateQueries({ queryKey: ['music-playlists'] }) }
    catch { toast.error('Rename failed') }
  }

  const toggleShare = async (shared: boolean) => {
    if (!id) return
    try { await sharePlaylist(id, shared); invalidate(); toast.success(shared ? 'Playlist shared with the family' : 'Playlist made private') }
    catch { toast.error('Could not update sharing') }
  }

  const doClone = async () => {
    if (!id) return
    setCloning(true)
    try {
      const { playlist: cloned } = await clonePlaylist(id)
      qc.invalidateQueries({ queryKey: ['music-playlists'] })
      toast.success('Playlist cloned to your library')
      navigate(`/music/playlist/${cloned.id}`)
    } catch { toast.error('Could not clone playlist') }
    finally { setCloning(false) }
  }

  const doDelete = async () => {
    if (!id) return
    try {
      await deletePlaylist(id)
      qc.invalidateQueries({ queryKey: ['music-playlists'] })
      toast.success('Playlist deleted')
      navigate('/music/library?tab=playlists')
    } catch { toast.error('Could not delete playlist') }
  }

  const onDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e
    if (!id || !over || active.id === over.id) return
    const ids = tracks.map(t => t.id)
    const oldIdx = ids.indexOf(String(active.id))
    const newIdx = ids.indexOf(String(over.id))
    if (oldIdx < 0 || newIdx < 0) return
    const reordered = arrayMove(ids, oldIdx, newIdx)
    qc.setQueryData(['music-playlist', id], (prev: typeof data) =>
      prev ? { ...prev, tracks: arrayMove(prev.tracks, oldIdx, newIdx) } : prev)
    try { await reorderPlaylist(id, reordered) }
    catch { toast.error('Could not save the new order'); invalidate() }
  }

  if (isLoading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>
  if (!playlist) return <div className="px-5 pt-10 text-center text-sm text-muted-foreground">Playlist not found.</div>

  return (
    <PageContainer width="wide" className="pt-6 pb-10">
      <button onClick={() => navigate('/music/library?tab=playlists')} className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Library
      </button>

      <div className="mb-6 flex items-start gap-4">
        <div className="flex size-20 shrink-0 items-center justify-center rounded-card bg-gradient-to-br from-brand/30 to-brand/10">
          <ListMusic className="size-9 text-brand" />
        </div>
        <div className="min-w-0 flex-1">
          {editingName ? (
            <div className="flex items-center gap-1.5">
              <Input value={name} onChange={e => setName(e.target.value)} autoFocus
                onKeyDown={e => { if (e.key === 'Enter') void saveName(); if (e.key === 'Escape') setEditingName(false) }}
                className="h-9 text-xl font-semibold" />
              <button type="button" onClick={() => void saveName()} className="text-brand"><Check className="size-5" /></button>
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
            {tracks.length} track{tracks.length === 1 ? '' : 's'}
            {!editable && playlist.ownerName && ` · by ${playlist.ownerName}`}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {tracks.length > 0 && (
              <Button size="sm" onClick={() => radio.playPlaylist(tracks.map(toQueuedTrack), 0, { name: playlist.name, playlistId: playlist.id })}>
                <Play className="size-4" /> Play
              </Button>
            )}
            {editable ? (
              <>
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

      {!tracks.length ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
          <ListMusic className="size-8 opacity-40" />
          <p className="text-sm">{editable ? 'Add songs from anywhere in Music via the “Add to playlist” button.' : 'This playlist is empty.'}</p>
        </div>
      ) : editable ? (
        <DndContext sensors={sensors} onDragEnd={e => void onDragEnd(e)}>
          <SortableContext items={tracks.map(t => t.id)} strategy={verticalListSortingStrategy}>
            {/* dnd-sortable list: plain rows on a resting surface, no hover-translate (drag-safe) */}
            <div className="divide-y divide-border/50 rounded-card border border-border/60">
              {tracks.map(t => <TrackRow key={t.id} track={t} tracks={tracks} editable onRemoved={invalidate} />)}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="divide-y divide-border/50 rounded-card border border-border/60">
          {tracks.map(t => <TrackRow key={t.id} track={t} tracks={tracks} editable={false} onRemoved={invalidate} />)}
        </div>
      )}

      <ConfirmDialog open={confirmDel} onOpenChange={setConfirmDel} title="Delete this playlist?"
        description={`“${playlist.name}” and its ${tracks.length} track${tracks.length === 1 ? '' : 's'} will be permanently removed.`}
        destructive confirmLabel="Delete" onConfirm={() => void doDelete()} />
    </PageContainer>
  )
}
