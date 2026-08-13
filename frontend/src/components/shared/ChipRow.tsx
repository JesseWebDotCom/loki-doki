import { cn } from '@/lib/cn'
import type { LucideIcon } from 'lucide-react'

interface ChipProps {
  label: string
  active?: boolean
  onClick?: () => void
  className?: string
  /** Override the active-state fill (e.g. a source's brand color instead of bg-brand). */
  activeClassName?: string
  /** Optional leading glyph (e.g. the current-location arrow on Weather's live chip). */
  icon?: LucideIcon
}

export function Chip({ label, active, onClick, className, activeClassName, icon: Icon }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors',
        active
          ? (activeClassName ?? 'bg-brand text-brand-foreground')
          : 'bg-foreground/8 text-foreground hover:bg-foreground/12',
        className,
      )}
    >
      {Icon && <Icon className="size-3.5" />}
      {label}
    </button>
  )
}

interface ChipRowProps {
  children: React.ReactNode
  className?: string
}

export function ChipRow({ children, className }: ChipRowProps) {
  return (
    <div className={cn('no-scrollbar flex gap-2 overflow-x-auto', className)}>
      {children}
    </div>
  )
}
