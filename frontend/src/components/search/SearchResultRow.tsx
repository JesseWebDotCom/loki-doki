import { useState } from 'react'
import { FaviconImg } from '@/components/shared/FaviconImg'
import { hostFromUrl } from '@/components/shared/NewsCard'
import { proxyImg } from '@/lib/img'

/** First couple path segments of a URL, Google-breadcrumb style ("wikipedia.org › wiki › Topic"). */
function breadcrumbPath(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    return parts.slice(0, 2).join(' › ')
  } catch {
    return ''
  }
}

export interface SearchResultRowProps {
  title: string
  url: string
  snippet: string
  /** Opportunistic per-result thumbnail (present for a minority of results). */
  thumbnail?: string
}

/**
 * One organic result row: favicon + domain breadcrumb, bold title, snippet, and an
 * optional thumbnail when the source engine attached one. Modeled on NewsCard's
 * NewsRow (favicon/hover/spacing conventions) but kept search-generic rather than
 * reusing NewsRow directly, since that component carries news-reader routing and a
 * "no photo" Newspaper-icon placeholder that doesn't fit an arbitrary web result.
 */
export function SearchResultRow({ title, url, snippet, thumbnail }: SearchResultRowProps) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const host = hostFromUrl(url)
  const path = breadcrumbPath(url)
  const showThumb = !!thumbnail && !thumbFailed

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group -mx-2 flex gap-4 rounded-control p-2 transition-colors hover:bg-foreground/5"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {host && <FaviconImg domain={host} className="size-4 shrink-0 rounded-[3px] object-contain" />}
          <span className="truncate">
            {host}
            {path && <span className="text-muted-foreground/60"> {'›'} {path}</span>}
          </span>
        </div>
        <p className="text-lg font-medium leading-snug text-brand group-hover:underline">{title}</p>
        {snippet && <p className="line-clamp-2 text-sm leading-relaxed text-foreground/80">{snippet}</p>}
      </div>
      {showThumb && (
        <img
          src={proxyImg(thumbnail!)}
          alt=""
          loading="lazy"
          onError={() => setThumbFailed(true)}
          className="size-24 shrink-0 rounded-control border border-border/50 bg-muted/30 object-cover"
        />
      )}
    </a>
  )
}
