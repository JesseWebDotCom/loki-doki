import { useState, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { mediaImg } from '@/lib/shows/api'

// The Movies/Shows detail hero: calm bg-card sheet over the cinema backdrop with a soft
// brand glow. Pages wrap the whole detail body in ArtAccentScope keyed to the artwork,
// so --brand (and therefore this glow, the action bar, tab underlines) follows the
// poster's palette with zero per-control edits.
export function DetailHero({ poster, title, meta, badges, summary, actions, FallbackIcon }: {
  /** Raw poster URL (proxied internally via mediaImg). */
  poster: string | null
  title: string
  /** The one-line context under the title, e.g. "HBO · 2019 · 60 min". */
  meta?: string | null
  /** Page-specific badge cluster (status, rating, genres, certification). */
  badges?: ReactNode
  summary?: string | null
  actions?: ReactNode
  FallbackIcon: LucideIcon
}) {
  const [ok, setOk] = useState(true)
  return (
    <div className="relative overflow-hidden rounded-sheet border border-border bg-card">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(640px circle at 0% 0%, color-mix(in oklch, var(--brand) 18%, transparent), transparent 62%)' }}
      />
      <div className="relative flex flex-col gap-5 p-6 sm:flex-row sm:p-8">
        <div className="mx-auto w-[160px] shrink-0 sm:mx-0">
          <div className="aspect-[2/3] overflow-hidden rounded-card bg-muted shadow-lg ring-1 ring-border/40">
            {poster && ok ? (
              <img src={mediaImg(poster)} alt={title} className="size-full object-cover" onError={() => setOk(false)} />
            ) : (
              <div className="flex size-full items-center justify-center">
                <FallbackIcon className="size-8 text-muted-foreground/40" />
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div>
            {/* design-ok(raw-h1-in-pages): bespoke detail hero (poster + badges + actions) that PageHeader can't host; title uses the sanctioned text-display style */}
            <h1 className="text-display">{title}</h1>
            {meta && <p className="mt-1 text-sm text-muted-foreground">{meta}</p>}
          </div>

          {badges && <div className="flex flex-wrap items-center gap-2">{badges}</div>}

          {summary && <p className="text-sm leading-relaxed text-muted-foreground">{summary}</p>}

          {actions && <div className="mt-auto pt-2">{actions}</div>}
        </div>
      </div>
    </div>
  )
}
