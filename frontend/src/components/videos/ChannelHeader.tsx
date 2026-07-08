import { useEffect, useState, type ReactNode } from 'react'
import { Link2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImgAuto } from '@/lib/img'
import { CreatorAvatar } from '@/components/videos/CreatorAvatar'
import { SOURCE_META } from '@/lib/videos/sources'
import type { VideoSource } from '@/lib/videos/api'

export interface ChannelHeaderLink { title: string; url: string }

/** The shared channel/creator identity header used by both the YouTube channel page and the
 *  non-YouTube source creator pages: banner, avatar, name, `·`-joined meta line, collapsible
 *  description, external links, and a right-aligned actions slot. Keeping one component means
 *  every source's subscription page reads identically. */
export function ChannelHeader({
  title, avatarUrl, bannerUrl, metaLine, description, links = [], linksLoading = false, actions,
  source,
}: {
  title: string
  avatarUrl?: string | null
  bannerUrl?: string | null
  metaLine?: string
  description?: string | null
  links?: ChannelHeaderLink[]
  /** Reserve the links row while a slower "about" query resolves, to avoid a layout shift. */
  linksLoading?: boolean
  actions?: ReactNode
  /** Shows a small platform badge next to the name (brand color + icon from SOURCE_META). */
  source?: VideoSource
}) {
  const badge = source ? SOURCE_META[source] : null
  const [descOpen, setDescOpen] = useState(false)
  const [bannerOk, setBannerOk] = useState(true)
  // A freshly-resolved banner gets a clean chance to load (the page stays mounted across
  // channel navigations, so a prior broken banner shouldn't suppress the next one's).
  useEffect(() => { setBannerOk(true) }, [bannerUrl])

  return (
    <>
      {bannerUrl && bannerOk && (
        <div className="mb-5 overflow-hidden rounded-card ring-1 ring-border/40">
          <img src={proxyImgAuto(bannerUrl)} alt="" referrerPolicy="no-referrer" className="aspect-[6/1] w-full object-cover" onError={() => setBannerOk(false)} />
        </div>
      )}
      <div className="mb-6 flex items-start gap-4">
        <CreatorAvatar title={title} src={avatarUrl} className="size-20 shrink-0 text-3xl ring-1 ring-border/40 sm:size-24" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {/* design-ok(raw-h1-in-pages): channel identity header (content title, not app chrome) */}
            <h1 className="truncate text-display">{title}</h1>
            {badge && (
              <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold', badge.badgeClass)}>
                <badge.icon className="size-3" aria-hidden /> {badge.label}
              </span>
            )}
          </div>
          {metaLine && <p className="mt-0.5 text-sm text-muted-foreground">{metaLine}</p>}
          {description && (
            <div className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted-foreground/80">
              <p className={cn('whitespace-pre-line', !descOpen && 'line-clamp-2')}>{description}</p>
              {description.length > 120 && (
                <button onClick={() => setDescOpen((o) => !o)} className="mt-0.5 font-semibold text-foreground/70 hover:text-foreground">
                  {descOpen ? 'Show less' : '…more'}
                </button>
              )}
            </div>
          )}
          {(links.length > 0 || linksLoading) && (
            <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1.5">
              {links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener"
                  className="flex items-center gap-1 text-xs font-medium text-[var(--yt-accent-fg)] hover:underline">
                  <Link2 className="size-3.5" />{l.title}
                </a>
              ))}
            </div>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </>
  )
}
