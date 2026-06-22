import { cn } from '@/lib/cn'

interface ChipProps {
  label: string
  active?: boolean
  onClick?: () => void
  className?: string
}

export function Chip({ label, active, onClick, className }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-3 py-1 text-sm font-medium transition-colors',
        active
          ? 'bg-brand text-brand-foreground'
          : 'bg-foreground/8 text-foreground hover:bg-foreground/12',
        className,
      )}
    >
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
