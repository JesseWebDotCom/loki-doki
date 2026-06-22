import { useNavigate } from 'react-router-dom'
import { Check, Lock } from 'lucide-react'
import { cn } from '@/lib/cn'
import { CharacterAvatar } from '@/components/companion/CharacterAvatar'
import { useActiveCompanion, type CompanionRecord } from '@/hooks/useActiveCompanion'
import { isLocked } from '@/lib/companions/useCompanionStore'
import { getCompanionCategory } from '@/lib/companions/companionCategories'
import { SelectButton, FavoriteButton, PreviewButton, lockReason } from '@/components/companions/store/CompanionActions'

function CategoryLabel({ c }: { c: CompanionRecord }) {
  const cat = getCompanionCategory(c.category)
  return <p className="text-[11px] font-medium text-muted-foreground/70">{cat?.name ?? 'Companion'}</p>
}

function StatusDot({ c }: { c: CompanionRecord }) {
  const { activeCompanionId } = useActiveCompanion()
  if (isLocked(c)) {
    return (
      <span className="flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground" title={`Requires ${lockReason(c)} — exceeds your content settings`}>
        <Lock className="size-3" />
      </span>
    )
  }
  if (c.id === activeCompanionId) {
    return (
      <span className="flex size-6 items-center justify-center rounded-full bg-brand text-brand-foreground" title="Active companion">
        <Check className="size-3.5" />
      </span>
    )
  }
  return null
}

/** Grid card linking to the companion detail page. */
export function CompanionCard({ c, className }: { c: CompanionRecord; className?: string }) {
  const navigate = useNavigate()
  const locked = isLocked(c)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/companions/c/${c.id}`)}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/companions/c/${c.id}`) }}
      className={cn(
        'group flex flex-col gap-3 rounded-2xl border border-border/40 bg-card p-4 text-left',
        'cursor-pointer transition-colors hover:bg-accent/40 hover:border-border',
        locked && 'opacity-70',
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div className={cn('size-16 overflow-hidden rounded-full ring-1 ring-border/40', locked && 'grayscale')}>
          <CharacterAvatar character={c} size={64} viewPreset="head" pokeable={!locked} suppressOverlays ambient={!locked} />
        </div>
        <div className="flex items-center gap-1.5">
          <StatusDot c={c} />
          {!locked && <FavoriteButton c={c} className="size-7" />}
        </div>
      </div>

      <div className="flex-1">
        <p className="text-sm font-bold leading-snug">{c.name}</p>
        <CategoryLabel c={c} />
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {locked ? `Requires ${lockReason(c)}. Raise your content settings to unlock.` : (c.backstory ?? '')}
        </p>
      </div>

      <div className="mt-auto flex items-center gap-1.5 pt-0.5">
        <SelectButton c={c} full />
        <PreviewButton c={c} />
      </div>
    </div>
  )
}

/** Compact horizontal-scroll card (Recommended / Favorites rows). */
export function CompanionMiniCard({ c }: { c: CompanionRecord }) {
  const navigate = useNavigate()
  const locked = isLocked(c)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/companions/c/${c.id}`)}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/companions/c/${c.id}`) }}
      className="flex w-56 shrink-0 cursor-pointer flex-col gap-3 rounded-2xl border border-border/40 bg-card p-4 transition-colors hover:bg-accent/40 hover:border-border"
    >
      <div className="flex items-center gap-3">
        <div className={cn('size-12 shrink-0 overflow-hidden rounded-full ring-1 ring-border/40', locked && 'grayscale')}>
          <CharacterAvatar character={c} size={48} viewPreset="head" pokeable={false} suppressOverlays ambient={!locked} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{c.name}</p>
          <CategoryLabel c={c} />
        </div>
      </div>
      <SelectButton c={c} full />
    </div>
  )
}

/** List row (Browse list view / category page). */
export function CompanionRow({ c }: { c: CompanionRecord }) {
  const navigate = useNavigate()
  const locked = isLocked(c)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/companions/c/${c.id}`)}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/companions/c/${c.id}`) }}
      className={cn(
        'group flex items-center gap-4 rounded-2xl border border-border/40 bg-card p-3 transition-colors hover:bg-accent/40 hover:border-border',
        locked && 'opacity-70',
      )}
    >
      <div className={cn('size-12 shrink-0 overflow-hidden rounded-full ring-1 ring-border/40', locked && 'grayscale')}>
        <CharacterAvatar character={c} size={48} viewPreset="head" pokeable={false} suppressOverlays ambient={!locked} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-bold">{c.name}</p>
          {locked && <Lock className="size-3 text-muted-foreground" />}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {locked ? `Requires ${lockReason(c)}` : (c.backstory ?? getCompanionCategory(c.category)?.name ?? '')}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {!locked && <FavoriteButton c={c} className="size-8" />}
        <SelectButton c={c} />
      </div>
    </div>
  )
}
