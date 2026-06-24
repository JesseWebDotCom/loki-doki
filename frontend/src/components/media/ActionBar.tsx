import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

// Plex-style action row. ActionButton renders a compact icon+label button (or link); ActionBar
// just lays them out. Used at the top of the Show/Movie detail pages.
export function ActionBar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>
}

export function ActionButton({
  icon: Icon,
  label,
  onClick,
  href,
  variant = 'secondary',
  disabled,
  title,
}: {
  icon: LucideIcon
  label: string
  onClick?: () => void
  href?: string
  variant?: 'primary' | 'secondary'
  disabled?: boolean
  title?: string
}) {
  const cls = cn(
    'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50',
    variant === 'primary'
      ? 'bg-brand text-brand-foreground hover:opacity-90'
      : 'bg-foreground/10 hover:bg-foreground/15',
  )
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls} title={title}>
        <Icon className="size-4" />
        {label}
      </a>
    )
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cls} title={title}>
      <Icon className="size-4" />
      {label}
    </button>
  )
}

// A compact icon-only button for secondary external links (JustWatch, IMDb, …).
export function ActionIcon({ icon: Icon, href, title }: { icon: LucideIcon; href: string; title: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      aria-label={title}
      className="inline-flex size-9 items-center justify-center rounded-lg bg-foreground/10 text-muted-foreground transition-colors hover:bg-foreground/15 hover:text-foreground"
    >
      <Icon className="size-4" />
    </a>
  )
}
