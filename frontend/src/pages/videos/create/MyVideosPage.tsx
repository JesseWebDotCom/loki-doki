import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clapperboard, Clock, Download, Film, Heart, Pencil, Plus, Sparkles, Trash2, Users, Video } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { CompatVideo } from '@/components/shared/CompatVideo'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { toggleCollection, useCollection } from '@/lib/youtube/collections'
import { AddToPlaylistButton } from '@/components/youtube/AddToPlaylistButton'
import { downloadArtifact } from '@/lib/converter/api'
import {
  createStudioProject, deleteBinItem, deleteStudioProject, exportBinItemAs, isMineBinItem,
  listStudioBin, listStudioProjects, setStudioMediaShared, studioStreamUrl, updateBinItemMeta,
  type StudioBinItem,
} from '@/lib/videos/studioApi'

function fmtDur(sec: number | null): string {
  if (sec == null || sec <= 0) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const binIconBtnClass = 'grid size-7 place-items-center rounded-full bg-black/70 text-white opacity-0 transition-opacity hover:bg-black/90 group-hover:opacity-100'

// The formats a Mine video can be saved as. Handled server-side by the converter's animation
// engine (video → animated gif/webp, or a re-muxed mp4).
const SAVE_AS: Array<{ format: string; label: string; hint: string }> = [
  { format: 'gif', label: 'Animated GIF', hint: 'loops anywhere' },
  { format: 'webp', label: 'Animated WebP', hint: 'smaller, sharper' },
  { format: 'mp4', label: 'Video (MP4)', hint: 'H.264' },
]

/** Download a bin video's original bytes as-is (no transcode). */
async function downloadOriginal(assetId: string, name: string): Promise<void> {
  const r = await fetch(studioStreamUrl(assetId), { credentials: 'include' })
  if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`)
  const url = URL.createObjectURL(await r.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Kick off a server-side conversion of a bin video, wait for it on the converter's SSE
 *  stream, then trigger the browser download. */
async function convertAndDownload(assetId: string, title: string, format: string): Promise<void> {
  const { conversionId, jobId } = await exportBinItemAs(assetId, format, title)
  await new Promise<void>((resolve, reject) => {
    const es = new EventSource(`/api/converter/stream/${jobId}`, { withCredentials: true })
    es.addEventListener('done', (ev) => {
      es.close()
      let id = conversionId, name = `${title}.${format}`
      try { const d = JSON.parse((ev as MessageEvent).data); id = d.conversionId ?? id; name = d.outputName ?? name } catch { /* use defaults */ }
      downloadArtifact(id, name).then(resolve).catch(reject)
    })
    es.addEventListener('error', (ev) => {
      // EventSource also fires 'error' on transient reconnects (no data); only a payload is fatal.
      const data = (ev as MessageEvent).data
      if (!data) return
      es.close()
      try { reject(new Error(JSON.parse(data).error ?? 'Conversion failed')) } catch { reject(new Error('Conversion failed')) }
    })
  })
}

/** Hover "Save as…" menu on a Mine card: export the video to animated GIF / WebP / MP4. */
function SaveAsMenu({ item }: { item: StudioBinItem }) {
  const [busy, setBusy] = useState(false)
  const title = item.title || 'video'
  const pick = async (format: string, label: string) => {
    setBusy(true)
    try {
      // "Save as video": if it's already a plain mp4 (or format unknown), just grab the
      // original; only transcode when the source is a different container (e.g. webm).
      if (format === 'mp4' && (!item.format || item.format === 'mp4')) {
        await downloadOriginal(item.assetId, `${title}.mp4`)
      } else {
        await convertAndDownload(item.assetId, title, format)
      }
      toast.success(`Saved as ${label}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save this video')
    } finally {
      setBusy(false)
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button" title="Save as…" aria-label="Save as…"
          onClick={(e) => e.stopPropagation()}
          className={cn(binIconBtnClass, busy && 'opacity-100')}
        >
          {busy ? <Spinner size="sm" /> : <Download className="size-3.5" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {SAVE_AS.map((f) => (
          <DropdownMenuItem key={f.format} disabled={busy} onSelect={() => void pick(f.format, f.label)}>
            <span className="font-medium">{f.label}</span>
            <span className="ml-auto pl-4 text-xs text-muted-foreground">{f.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A Studio bin card, with hover-revealed Like / Watch Later toggles - the only way to get
 *  a Mine item into those collections, since there's no "watch" event to hang it off of.
 *  Also carries the household-share toggle (shared videos land in other members' My Videos
 *  Plex libraries under your show); unsharing confirms since it removes them there. */
function MineBinCard({ item, onPlay, onAskUnshare, onEdit, onAskDelete }: {
  item: StudioBinItem; onPlay: () => void; onAskUnshare: (item: StudioBinItem) => void
  onEdit: (item: StudioBinItem) => void; onAskDelete: (item: StudioBinItem) => void
}) {
  const qc = useQueryClient()
  const liked = useCollection('liked').some((v) => v.videoId === item.assetId)
  const watchLater = useCollection('watch-later').some((v) => v.videoId === item.assetId)
  const meta = { videoId: item.assetId, title: item.title, durationSec: item.durationSec, videoSource: 'mine' as const, thumbnailUrl: item.thumbUrl }
  const shared = item.sharedAt != null

  const share = async () => {
    if (!item.mediaId) return
    try {
      await setStudioMediaShared(item.mediaId, true)
      toast.success('Shared with the household')
      void qc.invalidateQueries({ queryKey: ['studio-bin'] })
    } catch {
      toast.error('Could not share this video')
    }
  }

  return (
    <div className="group flex flex-col gap-2">
      <button type="button" className="relative aspect-video w-full overflow-hidden rounded-card bg-muted text-left" onClick={onPlay}>
        {item.thumbUrl ? (
          <img src={item.thumbUrl} alt="" loading="lazy" className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
        ) : (
          <div className="flex size-full items-center justify-center"><Film className="size-8 text-muted-foreground/50" /></div>
        )}
        {item.durationSec ? (
          <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{fmtDur(item.durationSec)}</span>
        ) : null}
        <div className="absolute right-1.5 top-1.5 flex items-center gap-1.5">
          <SaveAsMenu item={item} />
          <AddToPlaylistButton video={meta} className={binIconBtnClass} />
          <button type="button" title={liked ? 'Unlike' : 'Like'} aria-label={liked ? 'Unlike' : 'Like'}
            onClick={(e) => { e.stopPropagation(); toggleCollection('liked', meta) }}
            className={cn(binIconBtnClass, liked && 'opacity-100 text-[var(--yt-accent-fg)]')}>
            <Heart className={cn('size-3.5', liked && 'fill-current')} />
          </button>
          <button type="button" title={watchLater ? 'Remove from Watch Later' : 'Watch later'} aria-label={watchLater ? 'Remove from Watch Later' : 'Watch later'}
            onClick={(e) => { e.stopPropagation(); toggleCollection('watch-later', meta) }}
            className={cn(binIconBtnClass, watchLater && 'opacity-100 text-[var(--yt-accent-fg)]')}>
            <Clock className={cn('size-3.5', watchLater && 'fill-current')} />
          </button>
          {item.mediaId && (
            <button type="button" title={shared ? 'Shared with household - click to unshare' : 'Share with household'}
              aria-label={shared ? 'Unshare from household' : 'Share with household'}
              onClick={(e) => { e.stopPropagation(); if (shared) onAskUnshare(item); else void share() }}
              className={cn(binIconBtnClass, shared && 'opacity-100 text-[var(--yt-accent-fg)]')}>
              <Users className={cn('size-3.5', shared && 'fill-current')} />
            </button>
          )}
          <button type="button" title="Edit details" aria-label="Edit details"
            onClick={(e) => { e.stopPropagation(); onEdit(item) }}
            className={binIconBtnClass}>
            <Pencil className="size-3.5" />
          </button>
          <button type="button" title="Delete" aria-label="Delete"
            onClick={(e) => { e.stopPropagation(); onAskDelete(item) }}
            className={cn(binIconBtnClass, 'hover:bg-destructive')}>
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </button>
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm font-semibold leading-snug">{item.title}</p>
        {item.description ? (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
        ) : null}
        <p className="mt-0.5 text-xs capitalize text-muted-foreground">
          {item.origin}{shared ? ' · shared' : ''}
        </p>
      </div>
    </div>
  )
}

/** Rename / describe a Mine item. Seeds from the item; Save routes to the right store
 *  (generated clips → image meta, studio-owned → studio_media) via updateBinItemMeta. */
function EditMetaDialog({ item, onOpenChange, onSaved }: {
  item: StudioBinItem | null; onOpenChange: (v: boolean) => void; onSaved: () => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (item) { setTitle(item.title ?? ''); setDescription(item.description ?? '') }
  }, [item])

  const save = async () => {
    if (!item) return
    setBusy(true)
    try {
      await updateBinItemMeta(item, { title: title.trim(), description: description.trim() })
      toast.success('Details saved')
      onSaved()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Edit details</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Title</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Description</span>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add a description…" rows={3} />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void save()} disabled={busy}>{busy ? <Spinner size="sm" /> : 'Save'}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** My Videos: everything that's yours (exports, uploads, recordings, AI generations)
 *  plus your edit projects, with the create actions living right here. */
export function MyVideosPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null)
  const [confirmUnshare, setConfirmUnshare] = useState<StudioBinItem | null>(null)
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<StudioBinItem | null>(null)
  const [editItem, setEditItem] = useState<StudioBinItem | null>(null)
  const [playing, setPlaying] = useState<StudioBinItem | null>(null)

  const { data, isLoading } = useQuery({ queryKey: ['studio-projects'], queryFn: listStudioProjects })
  const projects = data?.projects ?? []

  const { data: binData } = useQuery({ queryKey: ['studio-bin'], queryFn: listStudioBin })
  const mine = (binData?.items ?? []).filter(isMineBinItem)

  const createMutation = useMutation({
    mutationFn: () => createStudioProject(),
    onSuccess: ({ id }) => navigate(`/videos/mine/${id}`),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not create a project'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteStudioProject(id),
    onSuccess: () => {
      toast.success('Project deleted')
      void qc.invalidateQueries({ queryKey: ['studio-projects'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not delete'),
  })

  return (
    <PageContainer width="wide" className="pt-1 pb-8">
      <PageHeader
        title="Mine"
        icon={Video}
        // design-ok(hex-in-tsx): Mine identity tile gradient (amber: distinct from the other
        // sources' red/orange/black/sky and from the hub's own cyan + the site's violet apps)
        gradient="linear-gradient(135deg,#78350f,#f59e0b)"
        subtitle="Your exports, uploads & AI clips, plus the projects that make them."
        className="pt-4 pb-4"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
              {createMutation.isPending ? <Spinner size="sm" /> : <Plus className="size-4" />} New project
            </Button>
            <Button asChild size="sm" className="gap-1.5">
              <Link to="/videos/mine/generate"><Sparkles className="size-4" /> Generate a clip</Link>
            </Button>
          </div>
        }
      />

      {mine.length > 0 && (
        <section className="mb-8">
          <SectionHeader title="Your videos" className="mb-4" />
          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4">
            {mine.map((item) => (
              <MineBinCard key={item.assetId} item={item} onPlay={() => setPlaying(item)} onAskUnshare={setConfirmUnshare} onEdit={setEditItem} onAskDelete={setConfirmDeleteItem} />
            ))}
          </div>
        </section>
      )}

      <SectionHeader title="Projects" className="mb-4" />
      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Film className="mb-3 size-10 opacity-30" />
          <p className="text-sm font-medium">No projects yet</p>
          <p className="mt-1 text-xs">Start one and pull in anything from your library.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <Card key={p.id} variant="interactive" className="group p-4" onClick={() => navigate(`/videos/mine/${p.id}`)}>
              <div className="flex items-start gap-3">
                <Clapperboard className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {p.durationSec > 0 ? `${fmtDur(p.durationSec)} · ` : ''}updated {new Date(p.updatedAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  size="sm" variant="ghost"
                  className="size-7 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete({ id: p.id, name: p.name }) }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(v) => { if (!v) setConfirmDelete(null) }}
        title="Delete project?"
        description={`"${confirmDelete?.name}" will be removed. Videos already in Mine stay.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (confirmDelete) deleteMutation.mutate(confirmDelete.id); setConfirmDelete(null) }}
      />

      <ConfirmDialog
        open={!!confirmUnshare}
        onOpenChange={(v) => { if (!v) setConfirmUnshare(null) }}
        title="Stop sharing with the household?"
        description={`"${confirmUnshare?.title}" will disappear from other members' My Videos Plex libraries. Your own copy is unaffected.`}
        confirmLabel="Unshare"
        onConfirm={() => {
          const item = confirmUnshare
          setConfirmUnshare(null)
          if (!item?.mediaId) return
          void setStudioMediaShared(item.mediaId, false)
            .then(() => { toast.success('No longer shared'); void qc.invalidateQueries({ queryKey: ['studio-bin'] }) })
            .catch(() => toast.error('Could not unshare this video'))
        }}
      />

      <ConfirmDialog
        open={!!confirmDeleteItem}
        onOpenChange={(v) => { if (!v) setConfirmDeleteItem(null) }}
        title="Delete this video?"
        description={`"${confirmDeleteItem?.title}" will be permanently removed. This can't be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          const item = confirmDeleteItem
          setConfirmDeleteItem(null)
          if (!item) return
          void deleteBinItem(item)
            .then(() => { toast.success('Deleted'); void qc.invalidateQueries({ queryKey: ['studio-bin'] }) })
            .catch((err) => toast.error(err instanceof Error ? err.message : 'Could not delete this video'))
        }}
      />

      <EditMetaDialog
        item={editItem}
        onOpenChange={(v) => { if (!v) setEditItem(null) }}
        onSaved={() => void qc.invalidateQueries({ queryKey: ['studio-bin'] })}
      />

      <Dialog open={!!playing} onOpenChange={(v) => { if (!v) setPlaying(null) }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle className="truncate">{playing?.title}</DialogTitle></DialogHeader>
          {playing && (playing.origin === 'generated' ? (
            // AI clips are animated WebP (served from /api/image/artifacts), which <video> can't
            // play - render as a looping <img>, same as the generator's own result view.
            <img src={`/api/image/artifacts/${playing.assetId}`} alt={playing.title} className="aspect-video w-full rounded-card bg-black object-contain" />
          ) : (
            <CompatVideo src={studioStreamUrl(playing.assetId)} compatUrl={`/api/videos/studio/media/${playing.assetId}/compat`}
              controls autoPlay playsInline className="aspect-video w-full rounded-card bg-black" />
          ))}
        </DialogContent>
      </Dialog>
    </PageContainer>
  )
}
