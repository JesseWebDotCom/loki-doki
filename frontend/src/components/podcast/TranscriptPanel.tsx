import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Scissors, Search, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import {
  createSnip, getEpisodeTranscript, transcribeEpisode,
  type AdSegment, type TranscriptSegment,
} from '@/lib/podcast/aiApi'
import { fmtTime } from '@/lib/podcast/format'

const AD_KIND_LABEL: Record<AdSegment['kind'], string> = { sponsor: 'Sponsor', ad: 'Ad', promo: 'Promo' }

/** The detected ad covering a transcript line (matched at the line's midpoint so a line
 *  half-in an ad isn't wrongly tagged). */
function adForLine(seg: TranscriptSegment, ads?: AdSegment[]): AdSegment | null {
  if (!ads?.length) return null
  const mid = (seg.startSec + seg.endSec) / 2
  return ads.find(a => mid >= a.startSec && mid < a.endSec) ?? null
}

/** Poll while a Whisper job is in flight; a ready/absent transcript needs no polling. */
const POLL_MS = 5000

export function transcriptQueryKey(episodeId: string) {
  return ['podcast-transcript', episodeId] as const
}

/**
 * The episode transcript, following playback: the active segment is highlighted and
 * scrolled into view, tapping a line seeks, and the search box filters to matching
 * lines. Shared by the episode page and the Now Playing transcript tab, so both stay
 * identical. `positionSec`/`onSeek` come from whichever player surface hosts it.
 */
export function TranscriptPanel({ episodeId, positionSec, onSeek, onSnipped, className, compact = false, adSegments }: {
  episodeId: string
  positionSec: number
  onSeek: (sec: number) => void
  onSnipped?: () => void
  className?: string
  /** Denser type + no header blurb, for the Now Playing side panel. */
  compact?: boolean
  /** Detected ad ranges to color-code inline (from the player context). */
  adSegments?: AdSegment[]
}) {
  const qc = useQueryClient()
  const [query, setQuery] = useState('')
  const [starting, setStarting] = useState(false)
  const [snipping, setSnipping] = useState(false)
  const activeRef = useRef<HTMLButtonElement>(null)
  // Auto-scroll follows playback only until the user takes over by scrolling or searching.
  const [following, setFollowing] = useState(true)

  const { data, isLoading } = useQuery({
    queryKey: transcriptQueryKey(episodeId),
    queryFn: () => getEpisodeTranscript(episodeId),
    refetchInterval: q => {
      const s = q.state.data?.status
      return s === 'pending' || s === 'processing' ? POLL_MS : false
    },
  })

  const segments = data?.transcript?.segments ?? []
  const status = data?.status ?? 'none'

  const activeIdx = useMemo(() => {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (positionSec >= segments[i]!.startSec) return i
    }
    return -1
  }, [segments, positionSec])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return segments
      .map((s, i) => ({ segment: s, index: i }))
      .filter(({ segment }) => segment.text.toLowerCase().includes(q))
  }, [segments, query])

  // Keep the active line in view while following.
  useEffect(() => {
    if (!following || filtered || activeIdx < 0) return
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeIdx, following, filtered])

  async function handleTranscribe() {
    setStarting(true)
    try {
      await transcribeEpisode(episodeId)
      toast.success('Transcribing in the background. This can take a few minutes.')
      await qc.invalidateQueries({ queryKey: transcriptQueryKey(episodeId) })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start transcription.')
    } finally {
      setStarting(false)
    }
  }

  async function handleSnip() {
    setSnipping(true)
    try {
      const snip = await createSnip(episodeId, positionSec)
      toast.success(`Snipped "${snip.title}".`)
      await qc.invalidateQueries({ queryKey: ['podcast-snips'] })
      onSnipped?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the snip.')
    } finally {
      setSnipping(false)
    }
  }

  if (isLoading) {
    return <div className={cn('flex justify-center py-10', className)}><Spinner /></div>
  }

  // Nothing yet, or a job that gave up: offer Whisper.
  if (status === 'none' || status === 'failed') {
    return (
      <div className={cn('flex flex-col items-center gap-3 px-4 py-10 text-center', className)}>
        <div className="flex size-12 items-center justify-center rounded-card bg-muted/50">
          <FileText className="size-6 opacity-40" />
        </div>
        <div>
          <p className="text-sm font-medium">
            {status === 'failed' ? 'Transcription did not finish' : 'No transcript yet'}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            {status === 'failed' && data?.error
              ? data.error
              : 'This episode did not ship a transcript. Transcribe it locally to search it, ask about it, and clip from it.'}
          </p>
        </div>
        <Button size="sm" onClick={() => void handleTranscribe()} disabled={starting} className="gap-1.5 font-semibold">
          {starting ? <Spinner className="text-current" /> : <Sparkles className="size-3.5" />}
          {status === 'failed' ? 'Try again' : 'Transcribe'}
        </Button>
      </div>
    )
  }

  // Whisper is working: the job reports its own progress note.
  if (status === 'pending' || status === 'processing') {
    const pct = data?.progress?.percent ?? null
    return (
      <div className={cn('flex flex-col items-center gap-3 px-4 py-10 text-center', className)}>
        <Spinner />
        <div>
          <p className="text-sm font-medium">{data?.progress?.note ?? 'Queued for transcription'}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Transcribing runs in the background. You can keep listening or leave this page.
          </p>
        </div>
        {pct != null && (
          <div className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    )
  }

  const rows = filtered ?? segments.map((segment, index) => ({ segment, index }))

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {/* Search + clip */}
      <div className="flex items-center gap-2 pb-3">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={e => { setQuery(e.target.value); setFollowing(false) }}
            placeholder="Search this transcript"
            className="h-9 pl-8 pr-8"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void handleSnip()} disabled={snipping}
          title="Clip the moment around the current position" className="shrink-0 gap-1.5">
          {snipping ? <Spinner className="text-current" /> : <Scissors className="size-3.5" />}
          Clip that
        </Button>
      </div>

      <div className="flex items-center justify-between pb-2 text-xs text-muted-foreground">
        <span>
          {filtered
            ? `${filtered.length} ${filtered.length === 1 ? 'match' : 'matches'}`
            : `${segments.length} lines · ${data?.transcript?.source === 'whisper' ? 'transcribed locally' : 'from the feed'}`}
        </span>
        {!filtered && !following && (
          <button onClick={() => setFollowing(true)} className="font-medium text-brand hover:underline">
            Follow playback
          </button>
        )}
      </div>

      {/* Lines */}
      <div onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)}
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground/60">No lines match your search.</p>
        ) : rows.map(({ segment, index }, rowIdx) => {
          const ad = adForLine(segment, adSegments)
          // Show the "Sponsor/Ad/Promo" chip only on the first line of a contiguous ad
          // block (when the previous visible row is not in the same ad).
          const prev = rows[rowIdx - 1]
          const adStarts = !!ad && (!prev || adForLine(prev.segment, adSegments)?.id !== ad.id)
          return (
            <TranscriptLine
              key={index}
              ref={index === activeIdx ? activeRef : undefined}
              segment={segment}
              active={index === activeIdx}
              compact={compact}
              adLabel={ad ? AD_KIND_LABEL[ad.kind] : null}
              adStarts={adStarts}
              onSeek={() => { setFollowing(true); onSeek(segment.startSec) }}
            />
          )
        })}
      </div>
    </div>
  )
}

const TranscriptLine = forwardRef<HTMLButtonElement, {
  segment: TranscriptSegment
  active: boolean
  compact: boolean
  adLabel?: string | null
  adStarts?: boolean
  onSeek: () => void
}>(function TranscriptLine({ segment, active, compact, adLabel, adStarts, onSeek }, ref) {
  const isAd = !!adLabel
  return (
    <button ref={ref} onClick={onSeek}
      className={cn(
        'flex w-full gap-3 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-muted',
        active && 'bg-brand/10',
        // design-ok(raw-palette-semantic): semantic "ad range" amber, matches the seek-bar ad overlay
        isAd && 'bg-amber-400/10 hover:bg-amber-400/15',
      )}>
      <span className={cn('shrink-0 pt-0.5 text-xs tabular-nums', active ? 'font-semibold text-brand' : 'text-muted-foreground/60')}>
        {fmtTime(segment.startSec)}
      </span>
      <span className="min-w-0">
        {adStarts && adLabel && (
          // design-ok(raw-palette-semantic): semantic "ad" badge amber, distinct from the brand accent
          <span className="mr-1.5 inline-flex items-center rounded bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            {adLabel}
          </span>
        )}
        {segment.speaker && (
          <span className="mr-1.5 text-xs font-semibold text-brand">{segment.speaker}</span>
        )}
        <span className={cn(
          'leading-relaxed',
          compact ? 'text-xs' : 'text-sm',
          isAd ? 'text-muted-foreground/70' : active ? 'font-medium text-foreground' : 'text-muted-foreground',
        )}>
          {segment.text}
        </span>
      </span>
    </button>
  )
})
