import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { PanelSection } from '@/components/shared/PanelLayout'

// Left-column navigation for Settings — same visual anatomy as Admin's AdminSidebar
// (collapsible icon rail, w-56/w-14, border-right, bg-background/60), scaled down for
// Settings' flat section list (no subsections, no cross-content search — Settings has
// no registry to search across the way Admin does).

interface Props {
  sections: PanelSection[]
  activeSection: string
  onNavigate: (sectionId: string) => void
  className?: string
  /** Desktop icon-rail mode. Ignored in the mobile drawer. */
  collapsed?: boolean
  onToggleCollapse?: () => void
}

export function SettingsSidebar({ sections, activeSection, onNavigate, className, collapsed = false, onToggleCollapse }: Props) {
  // ── Collapsed icon rail (desktop only) ──────────────────────────────────────
  if (collapsed) {
    return (
      <aside className={cn('flex w-14 shrink-0 flex-col items-center border-r border-border/40 bg-background/60 py-2', className)}>
        <button
          onClick={onToggleCollapse}
          className="mb-1 rounded-lg p-2 text-muted-foreground hover:bg-foreground/6 hover:text-foreground"
          title="Expand sidebar"
        >
          <PanelLeftOpen className="size-4" />
        </button>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {sections.map((s) => {
            const Icon = s.icon
            const active = s.id === activeSection
            return (
              <button
                key={s.id}
                onClick={() => onNavigate(s.id)}
                title={s.label}
                className={cn(
                  'flex size-10 items-center justify-center rounded-lg transition-colors',
                  active ? 'bg-brand/12 text-brand' : 'text-muted-foreground hover:bg-foreground/6 hover:text-foreground',
                )}
              >
                <Icon className="size-4" />
              </button>
            )
          })}
        </nav>
      </aside>
    )
  }

  // ── Full sidebar ────────────────────────────────────────────────────────────
  return (
    <aside className={cn('flex w-56 shrink-0 flex-col border-r border-border/40 bg-background/60', className)}>
      <div className="flex shrink-0 items-center justify-between border-b border-border/40 p-3">
        <span className="text-sm font-semibold">Settings</span>
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="hidden shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-foreground/6 hover:text-foreground md:block"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="size-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto p-2 text-sm">
        {sections.map((s) => {
          const Icon = s.icon
          const active = s.id === activeSection
          return (
            <button
              key={s.id}
              onClick={() => onNavigate(s.id)}
              className={cn(
                'mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                active ? 'bg-brand/12 font-medium text-brand' : 'text-muted-foreground hover:bg-foreground/6 hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex-1">{s.label}</span>
            </button>
          )
        })}
      </nav>
    </aside>
  )
}
