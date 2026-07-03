import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { getShows, deleteShow } from '@/lib/podcast/api'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { toast } from '@/lib/toast'

interface Pending {
  /** Channel/playlist display name shown in the prompt. */
  name: string
  /** Matches podcastShows.sourceRef: `channel:<id>` or `playlist:<id>`. */
  sourceRef: string
  kind: 'channel' | 'playlist'
  /** Does the actual unsubscribe + that call site's own local state updates. */
  onUnsubscribe: () => Promise<void>
}

/**
 * Shared unsubscribe confirmation. Detects podcasts the user created from this
 * channel/playlist (podcastShows.sourceRef) and offers a checkbox to delete them
 * too, so removing a source can also clean up everything spun off from it.
 *
 * Usage: const { ask, dialog } = useUnsubscribeConfirm(); render {dialog}; call
 * ask({...}) to open it.
 */
export function useUnsubscribeConfirm() {
  const qc = useQueryClient()
  const { closeIfShow } = usePodcastPlayback()
  const { data: shows = [] } = useQuery({ queryKey: ['podcast-shows'], queryFn: getShows })
  const [pending, setPending] = useState<Pending | null>(null)
  const [alsoDelete, setAlsoDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const tied = pending ? shows.filter(s => s.isOwn && s.sourceRef === pending.sourceRef) : []
  const n = tied.length

  function ask(p: Pending) { setAlsoDelete(false); setPending(p) }
  function close() { if (!busy) setPending(null) }

  async function confirm() {
    if (!pending || busy) return
    setBusy(true)
    try {
      await pending.onUnsubscribe()
      if (alsoDelete && n) {
        await Promise.all(tied.map(s => deleteShow(s.id).catch(() => {})))
        tied.forEach(s => closeIfShow(s.id))
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['podcast-shows'] }),
          qc.invalidateQueries({ queryKey: ['podcast-feed'] }),
        ])
        toast.success(`Deleted ${n} podcast${n > 1 ? 's' : ''}`)
      }
      setPending(null)
    } finally { setBusy(false) }
  }

  const dialog = (
    <Dialog open={!!pending} onOpenChange={o => { if (!o) close() }}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="border-b border-border/40 px-5 py-4">
          <DialogTitle>Unsubscribe from {pending?.name || 'this channel'}?</DialogTitle>
          <DialogDescription className="sr-only">Stop receiving updates from this channel.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-5 py-4 text-sm">
          {n > 0 ? (
            <>
              <p className="text-muted-foreground">
                You have <span className="font-semibold text-foreground">{n}</span> podcast{n > 1 ? 's' : ''} created from this {pending?.kind}:
              </p>
              <ul className="max-h-32 space-y-1 overflow-y-auto rounded-control border border-border/50 p-2">
                {tied.map(s => <li key={s.id} className="truncate text-xs text-muted-foreground">• {s.name}</li>)}
              </ul>
              <label className="flex cursor-pointer items-start gap-2 rounded-control bg-muted/50 px-3 py-2.5">
                <input type="checkbox" checked={alsoDelete} onChange={e => setAlsoDelete(e.target.checked)}
                  className="mt-0.5 size-4 accent-brand" />
                <span className="flex items-center gap-1.5 font-medium">
                  <Trash2 className="size-3.5 shrink-0" />
                  Also delete {n === 1 ? 'this podcast' : `these ${n} podcasts`} and all their episodes
                </span>
              </label>
            </>
          ) : (
            <p className="text-muted-foreground">You’ll stop seeing new uploads from this {pending?.kind ?? 'channel'} in your feed.</p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border/40 px-5 py-3">
          <Button variant="ghost" onClick={close} disabled={busy} className="text-muted-foreground hover:text-foreground">Cancel</Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy} className="gap-1.5">
            {busy && <Spinner size="sm" className="text-destructive-foreground" />}
            {alsoDelete && n ? 'Unsubscribe & delete' : 'Unsubscribe'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )

  return { ask, dialog }
}
