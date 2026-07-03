import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { cn } from '@/lib/cn'
import { searchSettings, allEntries, findSection, type SearchHit } from './adminRegistry'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  onNavigate: (sectionId: string, subId?: string) => void
}

export function AdminCommandPalette({ open, onOpenChange, onNavigate }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const results = useMemo<SearchHit[]>(() => (query.trim() ? searchSettings(query) : allEntries()), [query])

  useEffect(() => { if (open) { setQuery(''); setActive(0) } }, [open])
  useEffect(() => { setActive(0) }, [query])

  const choose = (h: SearchHit) => { onNavigate(h.sectionId, h.subId); onOpenChange(false) }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const h = results[active]; if (h) choose(h) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden rounded-sheet p-0">
        <DialogTitle className="sr-only">Search admin settings</DialogTitle>
        <DialogDescription className="sr-only">Jump to any admin setting or section.</DialogDescription>
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search admin settings…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No settings match “{query}”.</p>
          ) : (
            results.map((h, i) => {
              const Icon = findSection(h.sectionId)?.icon
              return (
                <button
                  key={`${h.sectionId}/${h.subId ?? ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(h)}
                  className={cn('flex w-full items-start gap-3 rounded-control px-3 py-2 text-left', i === active ? 'bg-brand/10' : 'hover:bg-foreground/[0.04]')}
                >
                  {Icon && (
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-control bg-secondary/50 text-muted-foreground">
                      <Icon className="size-4" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {h.label} <span className="text-xs font-normal text-muted-foreground">· {h.breadcrumb}</span>
                    </span>
                    {h.description && <span className="block truncate text-xs text-muted-foreground">{h.description}</span>}
                  </span>
                </button>
              )
            })
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="flex items-center gap-1"><Kbd>esc</Kbd> close</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border/60 bg-muted px-1 font-sans text-[10px] leading-none text-muted-foreground">{children}</kbd>
}
