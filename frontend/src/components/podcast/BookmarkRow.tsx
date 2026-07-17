import { useState } from 'react'
import { Play, Pencil, Trash2, Bookmark } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ShowCover } from '@/components/podcast/ShowCover'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { fmtTime } from '@/lib/podcast/format'
import { deleteBookmark, updateBookmarkNote, type PodcastBookmark } from '@/lib/podcast/playerApi'

/** One podcast bookmark: tap to resume the episode at that timestamp; edit the note or
 *  delete in place. Used by the Bookmarks page and the show-page bookmarks section. */
export function BookmarkRow({ bookmark, showThumb = true, onChanged, className }: {
  bookmark: PodcastBookmark
  showThumb?: boolean
  onChanged: () => void
  className?: string
}) {
  const { play } = usePodcastPlayback()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(bookmark.note ?? '')

  function handlePlay() {
    play({
      episodeId: bookmark.episodeId,
      showId: bookmark.showId,
      showName: bookmark.showName,
      title: bookmark.episodeTitle,
      durationSec: bookmark.durationSec ?? undefined,
      coverUrl: `/api/podcasts/shows/${bookmark.showId}/cover`,
    }, bookmark.positionSec)
  }

  async function handleSaveNote() {
    try {
      await updateBookmarkNote(bookmark.id, note.trim() || null)
      setEditing(false)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the bookmark.')
    }
  }

  async function handleDelete() {
    try {
      await deleteBookmark(bookmark.id)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the bookmark.')
    }
  }

  return (
    <>
      <div className={cn('group flex items-center gap-3 rounded-control px-3 py-2 transition-colors hover:bg-accent/40', className)}>
        <button onClick={handlePlay} className="relative flex size-10 shrink-0 items-center justify-center" title={`Play from ${fmtTime(bookmark.positionSec)}`} aria-label={`Play from ${fmtTime(bookmark.positionSec)}`}>
          {showThumb
            ? <ShowCover showId={bookmark.showId} title={bookmark.showName} size={40} rounded="rounded-control" />
            : <span className="flex size-10 items-center justify-center rounded-control bg-muted"><Bookmark className="size-4 text-muted-foreground" /></span>}
          <span className="absolute inset-0 flex items-center justify-center rounded-control bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
            <Play className="size-4 fill-current" />
          </span>
        </button>

        <button onClick={handlePlay} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-semibold">
            <span className="mr-2 inline-block rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-brand">{fmtTime(bookmark.positionSec)}</span>
            {bookmark.episodeTitle}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {bookmark.note || bookmark.showName}
          </p>
        </button>

        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => { setNote(bookmark.note ?? ''); setEditing(true) }}
            title="Edit note" aria-label="Edit note" className="size-8 text-muted-foreground hover:text-foreground">
            <Pencil className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => setConfirmDelete(true)}
            title="Delete bookmark" aria-label="Delete bookmark" className="size-8 text-muted-foreground hover:text-destructive">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Bookmark note</DialogTitle></DialogHeader>
          <Input value={note} onChange={e => setNote(e.target.value)} placeholder="What happens here?"
            onKeyDown={e => { if (e.key === 'Enter') void handleSaveNote() }} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
            <Button onClick={() => void handleSaveNote()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete bookmark"
        description={`Delete the bookmark at ${fmtTime(bookmark.positionSec)} in "${bookmark.episodeTitle}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleDelete()}
      />
    </>
  )
}
