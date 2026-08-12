import { useMemo } from 'react'
import { ExternalLink } from 'lucide-react'
import type { Source } from '@/lib/transformCitations'

/** Compact "Sources" list rendered under an answer that cited web results (#8). The inline
 *  [n] chips link out per-marker; this card lists every source once, in citation order. */
export function SourcesCard({ sources }: { sources: Source[] }) {
  const items = useMemo(
    () => sources.map((s, i) => {
      let domain = ''
      try { domain = new URL(s.url).hostname.replace(/^www\./, '') } catch { /* leave blank */ }
      return { n: i + 1, title: s.title || s.url, url: s.url, domain, date: s.date }
    }),
    [sources],
  )
  if (!items.length) return null
  return (
    <div className="rounded-card border border-border/60 bg-card/60 p-3">
      <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">Sources</p>
      <ol className="flex flex-col gap-1.5">
        {items.map((s) => (
          <li key={`${s.n}-${s.url}`}>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-baseline gap-2 text-xs hover:text-brand"
            >
              <span className="shrink-0 tabular-nums text-muted-foreground">{s.n}.</span>
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              {s.date && <span className="shrink-0 text-muted-foreground/60">{s.date}</span>}
              {s.domain && <span className="shrink-0 text-muted-foreground/70">{s.domain}</span>}
              <ExternalLink className="size-3 shrink-0 self-center text-muted-foreground/50 group-hover:text-brand" />
            </a>
          </li>
        ))}
      </ol>
    </div>
  )
}
