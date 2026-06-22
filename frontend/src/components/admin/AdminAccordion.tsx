import { cn } from '@/lib/cn'

// A flat settings section (VS-Code-settings style): a static header + always-visible
// content. NOT collapsible. `id` is the scroll anchor (observed by the scroll-spy and
// targeted by click-to-scroll). `openSignal`/`defaultOpen` are accepted for call-site
// back-compat but ignored — sections are always open.
export function AdminAccordion({
  id, title, description, children, contentClassName,
}: {
  id: string
  title: string
  description?: string
  defaultOpen?: boolean
  openSignal?: string
  children: React.ReactNode
  contentClassName?: string
}) {
  return (
    <section id={id} className="scroll-mt-4 overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="px-5 py-4">
        <p className="text-base font-semibold tracking-tight">{title}</p>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className={cn('border-t border-border/50 p-4', contentClassName)}>{children}</div>
    </section>
  )
}
