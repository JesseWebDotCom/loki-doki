import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export interface AppFeature {
  icon: LucideIcon
  title: string
  desc: string
}

// Reusable "what this app does" empty state. Apps render this when they have no content yet,
// turning a blank page into a quick pitch + onboarding: a hero icon, a one-line value prop, a
// grid of feature highlights, and optional call-to-action buttons. Keep copy benefit-oriented.
export function EmptyAppState({
  icon: Icon,
  title,
  tagline,
  features,
  // design-ok(hex-in-tsx): registry identity fallback data
  gradient = 'linear-gradient(135deg,#1e3a5f,#0f766e)',
  actions,
  footnote,
}: {
  icon: LucideIcon
  title: string
  tagline: string
  features: AppFeature[]
  gradient?: string
  actions?: ReactNode
  footnote?: ReactNode
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center px-4 py-12 text-center sm:py-16">
      <div className="mb-5 flex size-16 items-center justify-center rounded-card shadow-lg" style={{ background: gradient }}>
        <Icon className="size-8 text-white" />
      </div>
      <h2 className="text-title">{title}</h2>
      <p className="mt-2 max-w-xl text-balance text-muted-foreground">{tagline}</p>

      {actions && <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{actions}</div>}

      <div className="mt-10 grid w-full gap-3 sm:grid-cols-2">
        {features.map((f) => (
          <div key={f.title} className="flex items-start gap-3 rounded-card bg-secondary/50 p-4 text-left">
            <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-control bg-muted/60">
              <f.icon className="size-[18px] text-foreground/80" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight">{f.title}</p>
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{f.desc}</p>
            </div>
          </div>
        ))}
      </div>

      {footnote && <p className="mt-6 text-xs text-muted-foreground">{footnote}</p>}
    </div>
  )
}
