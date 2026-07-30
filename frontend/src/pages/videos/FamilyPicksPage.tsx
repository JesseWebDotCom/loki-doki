import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Play, Popcorn, ThumbsUp, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { toast } from '@/lib/toast'
import { fmtAge, fmtDur } from '@/lib/youtube/format'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { SkeletonListRows } from '@/components/shared/SkeletonBlocks'
import { Button } from '@/components/ui/button'
import { DurationBadge } from '@/components/videos/cardParts'
import { VideoPlaceholderArt } from '@/components/videos/VideoPlaceholderArt'
import { HUB_PATHS } from '@/components/videos/HubVideoCard'
import { SOURCE_META } from '@/lib/videos/sources'
import {
  FAMILY_PICKS_PLAYLIST, castVote, listFamilyPicks, markFamilyPickPlayed, withdrawFamilyPick,
  type FamilyPick,
} from '@/lib/videos/api'

const PICKS_KEY = ['family-picks'] as const

/** One pick: thumbnail links to the watch page, actions sit beside/below the meta.
 *  Sized for phones first, this is the pass-the-phone movie-night surface. */
function PickRow({ pick }: { pick: FamilyPick }) {
  const qc = useQueryClient()
  const watchTo = HUB_PATHS[pick.source]?.watch(pick.videoId) ?? `/videos/${pick.source}/watch/${encodeURIComponent(pick.videoId)}`
  const badge = SOURCE_META[pick.source]
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)

  // Vote toggles feel instant (optimistic tally + resort), then resync with the server.
  const voteMutation = useMutation({
    mutationFn: () => castVote(FAMILY_PICKS_PLAYLIST, pick.source, pick.videoId, !pick.voted),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: PICKS_KEY })
      const prev = qc.getQueryData<{ picks: FamilyPick[] }>(PICKS_KEY)
      qc.setQueryData<{ picks: FamilyPick[] }>(PICKS_KEY, (data) => data && {
        picks: data.picks
          .map((p) => (p.id === pick.id ? { ...p, voted: !p.voted, votes: p.votes + (p.voted ? -1 : 1) } : p))
          .sort((a, b) => b.votes - a.votes || a.createdAt - b.createdAt),
      })
      return { prev }
    },
    onError: (_err, _v, ctx) => { if (ctx?.prev) qc.setQueryData(PICKS_KEY, ctx.prev); toast.error('Could not update your vote') },
    onSettled: () => void qc.invalidateQueries({ queryKey: PICKS_KEY }),
  })

  const withdrawMutation = useMutation({
    mutationFn: () => withdrawFamilyPick(pick.id),
    onSuccess: () => { toast.success('Pick withdrawn'); void qc.invalidateQueries({ queryKey: PICKS_KEY }) },
    onError: () => toast.error('Could not withdraw the pick'),
  })
  const playedMutation = useMutation({
    mutationFn: () => markFamilyPickPlayed(pick.id),
    onSuccess: () => { toast.success('Marked as played'); void qc.invalidateQueries({ queryKey: PICKS_KEY }) },
    onError: () => toast.error('Could not mark it played'),
  })

  return (
    <li className="flex gap-3 rounded-card p-1.5 transition-colors hover:bg-accent/50 sm:gap-4">
      <Link to={watchTo} className="group relative aspect-video w-32 shrink-0 self-start overflow-hidden rounded-card shadow-md ring-1 ring-white/10 sm:w-44">
        <VideoPlaceholderArt source={pick.source} />
        {pick.thumbnailUrl && (
          <img src={proxyImg(pick.thumbnailUrl, 640)} alt="" loading="lazy"
            className="relative size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
        )}
        {badge && (
          <span className={cn('absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', badge.badgeClass)}>
            <badge.icon className="size-2.5" aria-hidden /> {badge.label}
          </span>
        )}
        <DurationBadge label={fmtDur(pick.durationSec)} />
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Link to={watchTo} className="line-clamp-2 text-sm font-semibold leading-snug transition-colors hover:text-[var(--yt-accent-fg)] sm:text-base">
          {pick.title}
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          {[pick.author, `Added by ${pick.addedBy}`, fmtAge(pick.createdAt)].filter(Boolean).join(' · ')}
        </p>

        {/* Actions: >= 36px targets with gap-2, phone-first. */}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          {/* design-ok(glass-on-plain-bg): pill controls over the Videos cinema surface */}
          <Button size="sm" onClick={() => voteMutation.mutate()}
            title={pick.voted ? 'Remove your vote' : 'Vote for this pick'}
            aria-label={pick.voted ? 'Remove your vote' : 'Vote for this pick'} aria-pressed={pick.voted}
            className={cn('h-9 rounded-full bg-white/10 px-3 text-xs font-semibold text-foreground/85 shadow-none hover:bg-white/15',
              pick.voted && 'text-[var(--yt-accent-fg)]')}>
            <ThumbsUp className={cn('size-4', pick.voted && 'fill-current')} />
            <span className="tabular-nums">{pick.votes}</span>
          </Button>
          <Button size="sm" asChild
            className="h-9 rounded-full bg-[var(--yt-accent)] px-3.5 text-xs font-semibold text-[var(--yt-accent-contrast,white)] shadow-none hover:bg-[var(--yt-accent-hover)]">
            <Link to={watchTo}><Play className="size-4 fill-current" /> Play</Link>
          </Button>
          {/* design-ok(glass-on-plain-bg): pill controls over the Videos cinema surface */}
          <Button size="sm" onClick={playedMutation.isPending ? undefined : () => playedMutation.mutate()}
            title="Mark played: clears it from the queue (re-adding brings it back)"
            className="h-9 rounded-full bg-white/10 px-3 text-xs font-semibold text-foreground/85 shadow-none hover:bg-white/15">
            <Check className="size-4" /> Played
          </Button>
          {pick.mine && (
            // design-ok(glass-on-plain-bg): pill controls over the Videos cinema surface
            <Button size="sm" onClick={() => setConfirmWithdraw(true)}
              title="Withdraw your pick" aria-label="Withdraw your pick"
              className="h-9 rounded-full bg-white/10 px-3 text-xs font-semibold text-foreground/85 shadow-none hover:bg-destructive/20 hover:text-destructive">
              <X className="size-4" /> Withdraw
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmWithdraw}
        onOpenChange={(open) => !open && setConfirmWithdraw(false)}
        title="Withdraw this pick?"
        description={`"${pick.title}" will be removed from the family queue. You can add it again any time.`}
        confirmLabel="Withdraw"
        destructive
        onConfirm={() => { withdrawMutation.mutate(); setConfirmWithdraw(false) }}
      />
    </li>
  )
}

/** The household's shared watch queue: anyone adds from any device, everyone votes,
 *  and the most-wanted pick rises to the top for movie night. */
export function FamilyPicksPage() {
  const { data, isPending } = useQuery({ queryKey: PICKS_KEY, queryFn: listFamilyPicks })
  const picks = data?.picks ?? []

  return (
    <PageContainer width="wide" className="pt-1 pb-8">
      <PageHeader title="Family Picks" icon={Popcorn}
        subtitle="The household watch queue. Anyone adds, everyone votes, the top pick plays next."
        className="pt-4 pb-4" />

      {isPending ? (
        <SkeletonListRows count={5} />
      ) : picks.length === 0 ? (
        <EmptyAppState
          icon={Popcorn}
          title="Nothing queued yet"
          tagline="Find a video anyone in the house would enjoy, open its more-actions menu on the watch page, and choose Add to Family Picks. Votes decide what plays first on movie night."
          actions={<Button variant="secondary" asChild><Link to="/videos">Browse videos</Link></Button>}
        />
      ) : (
        <>
          <p className="mb-3 px-1.5 text-xs text-muted-foreground">
            {picks.length} pick{picks.length === 1 ? '' : 's'} in the queue, sorted by votes
          </p>
          <ul className="space-y-2">
            {picks.map((pick) => <PickRow key={pick.id} pick={pick} />)}
          </ul>
        </>
      )}
    </PageContainer>
  )
}
