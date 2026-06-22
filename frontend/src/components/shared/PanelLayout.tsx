import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ChromeWash } from './ChromeWash'

export interface PanelSection {
  id: string
  label: string
  icon: LucideIcon
}

interface PanelLayoutProps {
  sections: PanelSection[]
  activeSection: string
  onSection: (id: string) => void
  children: React.ReactNode
}

export function PanelLayout({ sections, activeSection, onSection, children }: PanelLayoutProps) {
  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      {/* Horizontal pill tab strip */}
      <div className="relative shrink-0 border-b border-border/40 bg-background/70 backdrop-blur-md">
        <ChromeWash />
        <div className="relative flex items-center gap-1 overflow-x-auto px-4 py-2.5 no-scrollbar">
          {sections.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSection(s.id)}
              className={cn(
                'flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium whitespace-nowrap shrink-0 transition-all',
                activeSection === s.id
                  ? 'bg-brand text-brand-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/6',
              )}
            >
              <s.icon className="size-3.5 shrink-0" />
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  )
}
