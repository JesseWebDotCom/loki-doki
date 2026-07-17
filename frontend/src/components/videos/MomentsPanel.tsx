import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ScrollFade } from '@/components/shared/ScrollFade'
import { cn } from '@/lib/cn'
import { toast } from 'sonner'

// Moments: the family's private reactions on a piece of media (video, track, episode). A
// saved moment is both a bookmark (jump back to the bit worth rewatching) and a note to
// the rest of the household ("Dad at 12:31"). Netflix ships Moments and niconico ships
// timed comments; neither is private, and nobody offers this scoped to one family.
// Everything stays on the home server. Media-agnostic: the caller injects its own
// list/add/remove calls (each media type keys moments differently — source+videoId for
// video, a unified track ref for music, episodeId for podcasts) so this component owns
// only the shared UI, not any one backend's shape.

export interface MomentItem {
  id: string; userId: string; atSec: number; emoji: string | null; note: string | null
  by: string; mine: boolean; createdAt: number
}

const QUICK_EMOJI = ['😂', '😮', '❤️', '🔥', '👀']

function fmtAt(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function MomentsPanel({ queryKey, currentSec, onSeek, listMoments, addMoment, removeMoment, emptyHint }: {
  /** react-query cache key for this item's moments — must be stable/unique per item. */
  queryKey: readonly unknown[]
  /** Live playhead: where a new moment lands. */
  currentSec: number
  onSeek: (sec: number) => void
  listMoments: () => Promise<{ moments: MomentItem[] }>
  addMoment: (atSec: number, opts: { emoji?: string; note?: string }) => Promise<{ id: string }>
  removeMoment: (id: string) => Promise<{ ok: true }>
  emptyHint?: string
}) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey, queryFn: listMoments })
  const moments = data?.moments ?? []
  const [note, setNote] = useState('')

  const invalidate = () => qc.invalidateQueries({ queryKey })
  const add = useMutation({
    mutationFn: ({ emoji, note: n }: { emoji?: string; note?: string }) =>
      addMoment(Math.max(0, Math.floor(currentSec)), { emoji, note: n }),
    onSuccess: () => { setNote(''); void invalidate() },
    onError: () => toast.error('Could not save that moment'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => removeMoment(id),
    onSuccess: () => void invalidate(),
    onError: () => toast.error('Could not remove that moment'),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollFade fadeSize="h-8" className="min-h-0 flex-1">
        <div className="space-y-1.5 pb-2">
          {isLoading && <div className="flex justify-center py-6"><Spinner className="size-4" /></div>}
          {!isLoading && moments.length === 0 && (
            <div className="px-1 py-6 text-center">
              <Bookmark className="mx-auto mb-2 size-5 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                {emptyHint ?? 'Save a moment for your family: a reaction, or a note about the bit worth rewatching. It stays on your home server.'}
              </p>
            </div>
          )}
          {moments.map((m) => (
            <div key={m.id} className="group flex items-start gap-2 rounded-card px-2 py-1.5 transition-colors hover:bg-foreground/5">
              <button onClick={() => onSeek(m.atSec)}
                className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-brand hover:bg-foreground/15">
                {fmtAt(m.atSec)}
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-xs leading-snug">
                  {m.emoji && <span className="mr-1">{m.emoji}</span>}
                  {m.note}
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{m.by}</p>
              </div>
              {m.mine && (
                <Button variant="ghost" size="icon-sm" aria-label="Remove moment"
                  onClick={() => remove.mutate(m.id)}
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100">
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </ScrollFade>

      <div className="mt-2 shrink-0 space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium tabular-nums text-muted-foreground">at {fmtAt(Math.floor(currentSec))}</span>
          {QUICK_EMOJI.map((e) => (
            <button key={e} onClick={() => add.mutate({ emoji: e })} disabled={add.isPending}
              aria-label={`React ${e} at ${fmtAt(Math.floor(currentSec))}`}
              className={cn('grid size-7 place-items-center rounded-full bg-foreground/8 text-sm transition hover:bg-foreground/15',
                add.isPending && 'opacity-50')}>
              {e}
            </button>
          ))}
        </div>
        <form className="flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); if (note.trim()) add.mutate({ note: note.trim() }) }}>
          <Input value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Save this moment…" className="h-9" />
          <Button type="submit" size="icon" disabled={!note.trim() || add.isPending} aria-label="Save moment" className="size-9 shrink-0">
            <Bookmark className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  )
}
