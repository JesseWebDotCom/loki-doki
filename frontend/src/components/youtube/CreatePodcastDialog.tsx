import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Mic, Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import { RichOptionSelect } from '@/components/shared/RichOptionSelect'
import { getShows } from '@/lib/podcast/api'
import { createPodcast } from '@/lib/youtube/api'
import { getBatchSize, setBatchSize, MAX_BATCH } from '@/lib/youtube/podcast'

// Send the full loaded list so the backend can skip already-made videos and pick the
// next batch; it only ever generates `limit` at a time.
const MAX_PAYLOAD = 100

// source/url carry non-YouTube hub videos through to the episode payload (matches
// PodcastSourceButtons' shape); absent means YouTube.
export interface PodcastSourceVideo { videoId: string; title?: string; author?: string; source?: string; url?: string }

/**
 * "Create podcast" from YouTube content (a video, channel, or playlist). Creates a new
 * show or adds to an existing one, generating one episode per video (newest first), in
 * batches of an adjustable size.
 */
export function CreatePodcastDialog({ open, onClose, onCreated, videos, sourceLabel, sourceRef, suggestedShowName, defaultLabel }: {
  open: boolean
  onClose: () => void
  /** Called with the target show id after a successful create (for "next batch"). */
  onCreated?: (showId: string) => void
  videos: PodcastSourceVideo[]
  /** What the episode is being built from, e.g. the channel or playlist name. */
  sourceLabel: string
  /** Origin tag (e.g. 'channel:<id>') stored on a new show so the source can continue it. */
  sourceRef?: string
  /** Pre-fills the new-show name field (e.g. the channel name). */
  suggestedShowName?: string
  /** Pre-fills the episode title field (single-video only). */
  defaultLabel?: string
}) {
  const { data: shows = [] } = useQuery({ queryKey: ['podcast-shows'], queryFn: getShows, enabled: open })
  const ownShows = useMemo(() => shows.filter(s => s.isOwn), [shows])
  const multi = videos.length > 1

  const [mode, setMode] = useState<'existing' | 'new'>('new')
  const [showId, setShowId] = useState('')
  const [newName, setNewName] = useState('')
  const [label, setLabel] = useState('')
  const [batch, setBatch] = useState(getBatchSize())
  const [busy, setBusy] = useState(false)

  // Re-seed sensible defaults each time the dialog opens (and once shows load).
  // Default to "new": the action is "create a podcast", so a new show is the norm.
  useEffect(() => {
    if (!open) return
    setMode('new')
    setShowId(ownShows[0]?.id ?? '')
    setNewName(suggestedShowName ? `${suggestedShowName} Podcast` : 'My Podcast')
    setLabel(defaultLabel ?? '')
    setBatch(getBatchSize())
  }, [open, ownShows.length, suggestedShowName, defaultLabel])

  function changeBatch(n: number) {
    const clamped = Math.min(MAX_BATCH, Math.max(1, n))
    setBatch(clamped); setBatchSize(clamped)
  }

  const count = multi ? Math.min(videos.length, batch) : 1
  const canSubmit = videos.length > 0 && (mode === 'existing' ? !!showId : newName.trim().length > 0)

  async function submit() {
    if (!canSubmit) return
    setBusy(true)
    try {
      const res = await createPodcast(
        videos.slice(0, MAX_PAYLOAD),
        mode === 'existing'
          ? { showId, label: multi ? undefined : (label.trim() || undefined), limit: batch }
          : { newShowName: newName.trim(), label: multi ? undefined : (defaultLabel?.trim() || undefined), limit: batch, sourceRef },
      )
      if (res.error) { toast.error(res.error); return }
      if (res.showId) onCreated?.(res.showId)
      const n = res.episodeCount ?? count
      const eps = `${n} ${n === 1 ? 'episode' : 'episodes'}`
      const left = res.remaining ? ` · ${res.remaining} left for the next batch` : ''
      toast.success(mode === 'existing'
        ? `${eps} queued, newest first${left}.`
        : `Podcast created: ${eps} generating, newest first${left}.`)
      onClose()
    } catch {
      toast.error('Could not start the podcast.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Mic className="size-5 text-brand" /> Create podcast</DialogTitle>
          <DialogDescription>
            From <span className="font-medium text-foreground">{sourceLabel}</span> · {videos.length} {videos.length === 1 ? 'video' : 'videos'}
            {multi ? '. One AI episode per video, newest first.' : '. AI hosts discuss the transcript.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Target: a brand-new podcast (show) vs adding to an existing one. */}
          <div className="grid grid-cols-2 gap-2">
            <TargetTab label="New podcast" active={mode === 'new'} onClick={() => setMode('new')} />
            <TargetTab label="Existing podcast" active={mode === 'existing'} disabled={ownShows.length === 0}
              onClick={() => setMode('existing')} />
          </div>

          {mode === 'new' ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Podcast name</label>
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="My Podcast" maxLength={80} />
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Add episodes to</label>
                <RichOptionSelect
                  groups={[{ options: ownShows.map(s => ({ value: s.id, label: s.name, description: s.style })) }]}
                  value={showId} onChange={setShowId} placeholder="Choose a podcast"
                />
              </div>
              {!multi && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Episode title <span className="text-muted-foreground/60">(optional)</span></label>
                  <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="Auto-named from the source" maxLength={120} />
                </div>
              )}
            </>
          )}

          {/* Batch size: only meaningful when there's more than one video. */}
          {multi && (
            <div className="flex items-center justify-between rounded-control border border-border/60 px-3 py-2">
              <div>
                <p className="text-sm font-medium">Episodes this batch</p>
                <p className="text-xs text-muted-foreground/70">Newest first · up to {MAX_BATCH}. Generate more anytime.</p>
              </div>
              <div className="flex items-center gap-1">
                <Stepper icon={Minus} label="Fewer episodes" disabled={batch <= 1} onClick={() => changeBatch(batch - 1)} />
                <span className="w-7 text-center text-sm font-semibold tabular-nums">{count}</span>
                <Stepper icon={Plus} label="More episodes" disabled={batch >= MAX_BATCH || batch >= videos.length} onClick={() => changeBatch(batch + 1)} />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit || busy}>
            {busy && <Spinner className="text-primary-foreground" />} {mode === 'new' ? 'Create podcast' : 'Add episodes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TargetTab({ label, active, disabled, onClick }: { label: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={cn('rounded-control border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'border-brand bg-brand/10 text-brand' : 'border-border/60 text-muted-foreground hover:text-foreground')}>
      {label}
    </button>
  )
}

function Stepper({ icon: Icon, label, disabled, onClick }: { icon: typeof Plus; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Button variant="outline" size="icon-sm" onClick={onClick} disabled={disabled} aria-label={label}>
      <Icon className="size-3.5" />
    </Button>
  )
}
