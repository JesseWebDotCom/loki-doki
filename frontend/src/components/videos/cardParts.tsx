// Shared atoms for every video card and list row (YouTube's VideoCard family and the hub's
// HubVideoCard/HubVideoListRow): the title+creator meta block, thumbnail overlay chips
// (duration, watch progress, online-only) and the one-click Save button. One place to fix
// metadata rendering so YouTube and the other sources can't drift apart again.
//
// NOTE: meta text arrives pre-formatted (fmtViews/fmtAge for YouTube; provider `viewsText`
// raw for hub sources - reddit's "1.2K points" must NOT be run through fmtViews).

import type { MouseEvent } from 'react'
import { Check, CloudOff, HardDriveDownload, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Spinner } from '@/components/ui/spinner'
import { CreatorAvatar } from '@/components/videos/CreatorAvatar'

/** Title + creator identity + "creator · views · age" line.
 *  `grid` = avatar beside a 2-line title, meta line full-width below (kept apart, not one
 *  joined+truncated string, so a very long creator name only eats into itself).
 *  `row` = 2-line title, then a meta line with a small inline avatar (list views). */
export function CardMetaBlock({ title, creatorName, creatorAvatarUrl, metaSuffix, ghosted, layout = 'grid' }: {
  title: string
  creatorName?: string | null
  creatorAvatarUrl?: string | null
  /** Pre-formatted "views · age" suffix (may be empty). */
  metaSuffix?: string | null
  ghosted?: boolean
  layout?: 'grid' | 'row'
}) {
  const metaLine = (creatorName || metaSuffix) && (
    <p className="flex min-w-0 items-baseline gap-1 overflow-hidden text-xs text-muted-foreground">
      {creatorName && <span className="truncate">{creatorName}</span>}
      {metaSuffix && <span className="shrink-0 whitespace-nowrap">{creatorName ? ' · ' : ''}{metaSuffix}</span>}
    </p>
  )
  if (layout === 'row') {
    return (
      <div className="min-w-0 flex-1 py-0.5">
        <p className={cn('line-clamp-2 text-sm font-semibold leading-snug sm:text-[15px]', ghosted ? 'text-muted-foreground' : 'text-foreground')}>{title}</p>
        {(creatorName || metaSuffix) && (
          <div className="mt-1.5 flex items-center gap-2 overflow-hidden">
            {creatorName && <CreatorAvatar title={creatorName} src={creatorAvatarUrl} className={cn('size-5 shrink-0 text-[9px] ring-1 ring-white/10', ghosted && 'grayscale')} />}
            {metaLine}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-2.5">
        {creatorName && (
          <CreatorAvatar title={creatorName} src={creatorAvatarUrl} className={cn('mt-0.5 size-8 shrink-0 text-[11px] ring-1 ring-white/10', ghosted && 'grayscale')} />
        )}
        <p className={cn('line-clamp-2 min-w-0 flex-1 text-sm font-semibold leading-snug', ghosted ? 'text-muted-foreground' : 'text-foreground')}>{title}</p>
      </div>
      {/* Full-width, not indented under the avatar - keeps the subtitle from truncating early. */}
      {metaLine}
    </div>
  )
}

/** Bottom-right duration chip over a thumbnail. */
export function DurationBadge({ label }: { label?: string | null }) {
  if (!label) return null
  return <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{label}</span>
}

/** Bottom-edge watch progress strip (full faded bar once completed). */
export function WatchProgressBar({ progress, completed }: { progress: number; completed?: boolean }) {
  if (!(progress > 0) && !completed) return null
  return (
    <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
      <div className={cn('h-full', completed ? 'w-full bg-white/50' : 'bg-[var(--yt-accent)]')}
        style={completed ? undefined : { width: `${Math.min(100, progress * 100)}%` }} />
    </div>
  )
}

/** "Online only" chip for ghosted cards in offline mode. Position via className. */
export function OnlineOnlyBadge({ className }: { className?: string }) {
  return (
    <span className={cn('absolute inline-flex items-center gap-1 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white', className ?? 'right-1.5 top-1.5')}>
      <CloudOff className="size-2.5" aria-hidden /> Online only
    </span>
  )
}

/** One-click Save-offline button over the thumbnail's top-right corner: hover-revealed,
 *  stays visible once saving/saved. `cancelable` adds YouTube's click-to-cancel affordance
 *  (spinner swaps to an ✕ on hover) - relies on the card's `group` class for hover state. */
export function SaveOfflineButton({ state, onClick, cancelable = false }: {
  state: 'saved' | 'saving' | null
  onClick: (e: MouseEvent) => void
  cancelable?: boolean
}) {
  return (
    <button type="button" onClick={onClick}
      title={state === 'saved' ? 'Saved offline' : state === 'saving' ? (cancelable ? 'Saving offline - click to cancel' : 'Saving offline…') : 'Save offline'}
      aria-label={state === 'saved' ? 'Saved offline' : state === 'saving' ? (cancelable ? 'Cancel save' : 'Saving offline') : 'Save offline'}
      className={cn('absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-full text-white transition-all',
        state === 'saved' ? 'bg-[var(--yt-accent)] opacity-100 hover:bg-[var(--yt-accent-hover)]'
          : state === 'saving' ? 'bg-black/75 opacity-100 hover:bg-black/90'
          : 'bg-black/75 opacity-0 hover:bg-black/90 group-hover:opacity-100')}>
      {state === 'saving' ? (
        cancelable ? (
          <>
            <Spinner className="size-3.5 text-white group-hover:hidden" />
            <X className="hidden size-3.5 group-hover:block" />
          </>
        ) : <Spinner className="size-3.5 text-white" />
      ) : state === 'saved' ? <Check className="size-3.5" />
        : <HardDriveDownload className="size-3.5" />}
    </button>
  )
}
