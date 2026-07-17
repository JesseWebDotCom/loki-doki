import { useState } from 'react'
import { Play, Pause, Clock, AlertCircle, ListPlus, MoreHorizontal, Check, RotateCw, Trash2, ArrowDownToLine, GraduationCap } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
// The legacy @/lib/toast shim has no loading/dismiss/action support, so the study-kit
// flow (a slow LLM call with an "Open" follow-up) uses sonner, per the toast contract
// in agents.md. Existing callers above are left on the shim.
import { toast as sonnerToast } from 'sonner'
import { usePodcastPlayback, type PodcastTrack } from '@/context/PodcastPlaybackContext'
import { ShowCover } from '@/components/podcast/ShowCover'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { fmtDate, fmtDuration } from '@/lib/podcast/format'
import {
  toTrack, regenerateEpisode, deleteEpisode, downloadEpisode, removeEpisodeDownload, makeStudyKit,
  type Episode, type Show,
} from '@/lib/podcast/api'

export function EpisodeRow({ episode, show, playlist, showThumb = true, canManage = false }: {
  episode: Episode
  show: Pick<Show, 'id' | 'name'>
  /** When provided, playing starts a queue from this index (enables autoplay). */
  playlist?: { tracks: PodcastTrack[]; index: number }
  showThumb?: boolean
  /** Owner/admin: enables Regenerate + Delete. */
  canManage?: boolean
}) {
  const { track, playing, play, playQueue, enqueue, pause, resume, close } = usePodcastPlayback()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmRemoveDl, setConfirmRemoveDl] = useState(false)
  const [studying, setStudying] = useState(false)
  const isCurrent = track?.episodeId === episode.id
  const ready = episode.status === 'ready'
  const progress = episode.watchState
  const pct = progress && episode.durationSec ? Math.min(100, (progress.positionSec / episode.durationSec) * 100) : 0
  // RSS episodes (with a remote enclosure) can be archived offline per user.
  const isRss = !!episode.enclosureUrl
  const dl = episode.download ?? null

  function handlePlay() {
    if (isCurrent) { playing ? pause() : resume(); return }
    if (playlist) playQueue(playlist.tracks, playlist.index, progress?.positionSec ?? 0)
    else play(toTrack(episode, show), progress?.positionSec ?? 0)
  }

  async function invalidate() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['podcast-episodes', show.id] }),
      qc.invalidateQueries({ queryKey: ['podcast-feed'] }),
    ])
  }
  async function handleRegenerate() {
    await regenerateEpisode(episode.id)
    await invalidate()
  }
  async function handleDelete() {
    if (isCurrent) close()
    await deleteEpisode(episode.id)
    await invalidate()
  }
  async function handleDownload() {
    try {
      await downloadEpisode(episode.id)
      await invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download the episode.')
    }
  }
  async function handleRemoveDownload() {
    try {
      await removeEpisodeDownload(episode.id)
      await invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the download.')
    }
  }

  // Homework mode: only offered when the episode actually carries a transcript to
  // study from (generated episodes; RSS episodes have none).
  const canStudy = ready && episode.hasScript === true
  async function handleStudyKit() {
    if (studying) return
    setStudying(true)
    const pending = sonnerToast.loading('Making study notes…')
    try {
      const { noteId } = await makeStudyKit(episode.id)
      sonnerToast.dismiss(pending)
      sonnerToast.success('Study notes saved to your notes', {
        action: { label: 'Open', onClick: () => navigate(`/notes/${noteId}`) },
      })
    } catch (err) {
      sonnerToast.dismiss(pending)
      sonnerToast.error(err instanceof Error ? err.message : 'Could not make study notes')
    } finally {
      setStudying(false)
    }
  }

  const showMenu = ready || canManage

  return (
    <>
    <div className={cn('group flex items-center gap-3 rounded-control px-3 py-2.5 transition-colors hover:bg-accent/40', isCurrent && 'bg-accent/40')}>
      {/* Play / status */}
      {ready ? (
        <button onClick={handlePlay} className="relative flex size-10 shrink-0 items-center justify-center">
          {showThumb && <ShowCover showId={show.id} title={show.name} size={40} rounded="rounded-control" />}
          <span className={cn('absolute inset-0 flex items-center justify-center rounded-control bg-black/45 text-white transition-opacity',
            isCurrent ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
            {isCurrent && playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
          </span>
        </button>
      ) : (
        <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-muted text-muted-foreground">
          {episode.status === 'generating' ? <Spinner className="text-brand" />
            : episode.status === 'failed' ? <AlertCircle className="size-4 text-destructive" />
            : <Clock className="size-4" />}
        </div>
      )}

      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm font-semibold', isCurrent && 'text-brand')}>{episode.title}</p>
        {episode.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground leading-relaxed">{episode.description}</p>
        )}
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          {(episode.publishedAt ?? episode.generatedAt) && <span>{fmtDate(episode.publishedAt ?? episode.generatedAt)}</span>}
          {episode.durationSec ? <span>· {fmtDuration(episode.durationSec)}</span> : null}
          {episode.status === 'generating' && <span className="text-brand">Generating…</span>}
          {episode.status === 'pending' && <span>Queued</span>}
          {episode.status === 'failed' && <span className="text-destructive">Failed</span>}
          {progress?.completed && <span className="inline-flex items-center gap-0.5 text-success"><Check className="size-3" /> Played</span>}
          {isRss && dl?.status === 'ready' && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand">
              <Check className="size-3" /> Downloaded
            </span>
          )}
        </div>
        {pct > 0 && !progress?.completed && (
          <div className="mt-1.5 h-1 w-full max-w-48 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      {(showMenu || isRss) && (
        <div className="flex shrink-0 items-center gap-1">
          {ready && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => enqueue(toTrack(episode, show))} title="Add to Up Next" aria-label="Add to Up Next"
              className="size-8 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100">
              <ListPlus className="size-4" />
            </Button>
          )}
          {/* Offline download affordance - RSS episodes only */}
          {isRss && !dl && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => void handleDownload()} title="Download for offline" aria-label="Download for offline"
              className="size-8 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100">
              <ArrowDownToLine className="size-4" />
            </Button>
          )}
          {isRss && (dl?.status === 'pending' || dl?.status === 'downloading') && (
            <span title="Downloading…" className="flex size-8 items-center justify-center text-brand">
              <Spinner className="text-current" />
            </span>
          )}
          {isRss && dl?.status === 'failed' && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => void handleDownload()} title="Download failed - retry" aria-label="Retry download"
              className="size-8 text-destructive hover:text-destructive">
              <RotateCw className="size-4" />
            </Button>
          )}
          {showMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" className="size-8 text-muted-foreground hover:text-foreground" aria-label="Episode options"><MoreHorizontal className="size-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {ready && <DropdownMenuItem onSelect={handlePlay}><Play className="size-4" /> Play</DropdownMenuItem>}
                {ready && <DropdownMenuItem onSelect={() => enqueue(toTrack(episode, show))}><ListPlus className="size-4" /> Add to Up Next</DropdownMenuItem>}
                {canStudy && (
                  <DropdownMenuItem disabled={studying} onSelect={(e) => { e.preventDefault(); void handleStudyKit() }}>
                    {studying ? <Spinner className="size-4 text-current" /> : <GraduationCap className="size-4" />} Make study notes
                  </DropdownMenuItem>
                )}
                {isRss && !dl && (
                  <DropdownMenuItem onSelect={() => void handleDownload()}><ArrowDownToLine className="size-4" /> Download</DropdownMenuItem>
                )}
                {isRss && dl?.status === 'ready' && (
                  <DropdownMenuItem onSelect={() => setConfirmRemoveDl(true)}><Trash2 className="size-4" /> Remove download</DropdownMenuItem>
                )}
                {canManage && (
                  <>
                    {ready && <DropdownMenuSeparator />}
                    <DropdownMenuItem onSelect={() => void handleRegenerate()}><RotateCw className="size-4" /> Regenerate</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}><Trash2 className="size-4" /> Delete</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>

    <ConfirmDialog
      open={confirmDelete}
      onOpenChange={setConfirmDelete}
      title="Delete episode"
      description={`Delete "${episode.title}"? This cannot be undone.`}
      confirmLabel="Delete"
      destructive
      onConfirm={() => void handleDelete()}
    />
    <ConfirmDialog
      open={confirmRemoveDl}
      onOpenChange={setConfirmRemoveDl}
      title="Remove download"
      description={`Remove the offline copy of "${episode.title}"? You can still stream it.`}
      confirmLabel="Remove"
      destructive
      onConfirm={() => void handleRemoveDownload()}
    />
    </>
  )
}
