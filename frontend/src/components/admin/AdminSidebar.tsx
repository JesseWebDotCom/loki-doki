import { useState } from 'react'
import { Search, ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ChromeWash } from '@/components/shared/ChromeWash'
import { ADMIN_SECTIONS, searchSettings } from './adminRegistry'

interface Props {
  sectionId: string
  subId?: string
  query: string
  setQuery: (q: string) => void
  onNavigate: (sectionId: string, subId?: string) => void
  className?: string
  /** Desktop icon-rail mode. Ignored in the mobile drawer. */
  collapsed?: boolean
  onToggleCollapse?: () => void
}

export function AdminSidebar({
  sectionId, subId, query, setQuery, onNavigate, className, collapsed = false, onToggleCollapse,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([sectionId]))
  const toggle = (id: string) =>
    setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const results = searchSettings(query)

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
          {ADMIN_SECTIONS.map((section) => {
            const Icon = section.icon
            const active = section.id === sectionId
            return (
              <button
                key={section.id}
                onClick={() => onNavigate(section.id)}
                title={section.label}
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
      <div className="relative flex shrink-0 items-center gap-1.5 border-b border-border/40 p-2">
        <ChromeWash />
        <div className="relative flex flex-1 items-center gap-2 rounded-lg border border-border/60 bg-background px-2.5 py-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="relative hidden shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-foreground/6 hover:text-foreground md:block"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="size-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto p-2 text-sm">
        {query.trim() ? (
          results.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No settings match “{query}”.</p>
          ) : (
            results.map((h) => (
              <button
                key={`${h.sectionId}/${h.subId ?? ''}`}
                onClick={() => onNavigate(h.sectionId, h.subId)}
                className="flex w-full flex-col items-start rounded-lg px-2.5 py-1.5 text-left hover:bg-foreground/6"
              >
                <span className="font-medium">{h.label}</span>
                <span className="text-[11px] text-muted-foreground">{h.breadcrumb}</span>
              </button>
            ))
          )
        ) : (
          ADMIN_SECTIONS.map((section) => {
            const Icon = section.icon
            const isActiveSection = section.id === sectionId
            const hasSubs = section.subsections.length > 0
            const isOpen = expanded.has(section.id) || isActiveSection
            return (
              <div key={section.id} className="mb-0.5">
                <button
                  onClick={() => { onNavigate(section.id); if (hasSubs) toggle(section.id) }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors',
                    isActiveSection && !hasSubs ? 'bg-brand/12 font-medium text-brand' : 'hover:bg-foreground/6',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="flex-1 text-left">{section.label}</span>
                  {hasSubs && (isOpen ? <ChevronDown className="size-3.5 opacity-50" /> : <ChevronRight className="size-3.5 opacity-50" />)}
                </button>
                {hasSubs && isOpen && (
                  <div className="ml-[18px] border-l border-border/40 pl-1.5">
                    {section.subsections.map((sub) => {
                      const active = isActiveSection && sub.id === subId
                      return (
                        <button
                          key={sub.id}
                          onClick={() => onNavigate(section.id, sub.id)}
                          className={cn(
                            'flex w-full items-center rounded-lg px-2.5 py-1.5 text-left transition-colors',
                            active ? 'bg-brand/12 font-medium text-brand' : 'text-muted-foreground hover:bg-foreground/6 hover:text-foreground',
                          )}
                        >
                          {sub.label}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}
      </nav>
    </aside>
  )
}
