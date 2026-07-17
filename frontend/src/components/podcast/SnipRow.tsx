import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { NotebookPen, Play, Scissors, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ShowCover } from '@/components/podcast/ShowCover'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { deleteSnip, type Snip } from '@/lib/podcast/aiApi'
import { fmtTime } from '@/lib/podcast/format'

/** One snip: tap to play the episode from the clipped moment, open the episode page at
 *  that timestamp, or jump to the note it created. Used by the Snips library and the
 *  episode page's snips tab. */
export function SnipRow({ snip, showEpisode = true, className }: {
  snip: Snip
  /** Off on the episode page, where every snip is from the episode you are reading. */
  showEpisode?: boolean
  className?: string
}) {
  const qc = useQueryClient()
  const { play } = usePodcastPlayback()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [expanded, setExpanded] = useState(false)

  function handlePlay() {
    play({
      episodeId: snip.episodeId,
      showId: snip.showId,
      showName: snip.showName,
      title: snip.episodeTitle,
      coverUrl: `/api/podcasts/shows/${snip.showId}/cover`,
    }, snip.startSec)
  }

  async function handleDelete() {
    try {
      await deleteSnip(snip.id)
      await qc.invalidateQueries({ queryKey: ['podcast-snips'] })
      toast.success('Snip deleted.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the snip.')
    }
  }

  return (
    <>
      <div className={cn('group rounded-control px-3 py-2 transition-colors hover:bg-accent/40', className)}>
        <div className="flex items-center gap-3">
          <button onClick={handlePlay} className="relative flex size-10 shrink-0 items-center justify-center"
            title={`Play from ${fmtTime(snip.startSec)}`} aria-label={`Play from ${fmtTime(snip.startSec)}`}>
            {showEpisode
              ? <ShowCover showId={snip.showId} title={snip.showName} size={40} rounded="rounded-control" />
              : <span className="flex size-10 items-center justify-center rounded-control bg-muted"><Scissors className="size-4 text-muted-foreground" /></span>}
            <span className="absolute inset-0 flex items-center justify-center rounded-control bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
              <Play className="size-4 fill-current" />
            </span>
          </button>

          <button onClick={() => setExpanded(v => !v)} className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm font-semibold">
              <span className="mr-2 inline-block rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-brand">
                {fmtTime(snip.startSec)}
              </span>
              {snip.title}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {showEpisode ? `${snip.showName} · ${snip.episodeTitle}` : (snip.summary ?? 'Tap to read the clip')}
            </p>
          </button>

          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {snip.noteId && (
              <Button asChild type="button" variant="ghost" size="icon-sm"
                title="Open the note this snip made" className="size-8 text-muted-foreground hover:text-foreground">
                <Link to={`/notes/${snip.noteId}`} aria-label="Open note"><NotebookPen className="size-4" /></Link>
              </Button>
            )}
            <Button asChild type="button" variant="ghost" size="icon-sm"
              title="Open the episode at this moment" className="size-8 text-muted-foreground hover:text-foreground">
              <Link to={`/podcasts/episode/${snip.episodeId}?t=${Math.floor(snip.startSec)}`} aria-label="Open episode at this moment">
                <Scissors className="size-4" />
              </Link>
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setConfirmDelete(true)}
              title="Delete snip" aria-label="Delete snip" className="size-8 text-muted-foreground hover:text-destructive">
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>

        {expanded && (
          <div className="mt-2 pl-13">
            {snip.summary && <p className="text-sm leading-relaxed text-muted-foreground">{snip.summary}</p>}
            <blockquote className="mt-2 border-l-2 border-brand/40 pl-3 text-xs italic leading-relaxed text-muted-foreground/80">
              {snip.transcriptText}
            </blockquote>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete snip"
        description={`Delete "${snip.title}"? The note it created goes with it. This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleDelete()}
      />
    </>
  )
}
