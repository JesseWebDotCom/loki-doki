import { useEffect, useState, type ReactNode } from 'react'
import { Link2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { AVATAR_W_LARGE, proxyImgAuto } from '@/lib/img'
import { CreatorAvatar } from '@/components/videos/CreatorAvatar'
import { BlendedHeroBackdrop } from '@/components/shared/BlendedHeroBackdrop'
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

  const heroMeta = source ? SOURCE_META[source] : SOURCE_META.link
  return (
    <>
      {/* Banner-driven identity hero: the banner (or a blended avatar/brand backdrop when
          there is none) is the surface, with the identity overlaid on a bottom scrim, so a
          channel page opens like a title page instead of a strip + detached text block. */}
      <div className="relative mb-4 overflow-hidden rounded-sheet shadow-xl">
        <div className="relative aspect-[21/9] w-full sm:aspect-[5/1]">
          {bannerUrl && bannerOk ? (
            <img src={proxyImgAuto(bannerUrl)} alt="" referrerPolicy="no-referrer" decoding="async"
              className="absolute inset-0 size-full object-cover" onError={() => setBannerOk(false)} />
          ) : (
            <BlendedHeroBackdrop art={avatarUrl ? proxyImgAuto(avatarUrl) : null}
              color={heroMeta.heroColor} colorDark={heroMeta.heroColorDark} />
          )}
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />
        </div>
        {/* Actions float top-right so the identity row keeps the full width on phones
            (inline actions crushed the title to a couple of characters at 393pt). */}
        {actions && <div className="absolute right-3 top-3 flex items-center gap-2 sm:right-5 sm:top-auto sm:bottom-5">{actions}</div>}
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-3 p-4 sm:gap-4 sm:p-6 sm:pr-44">
          <CreatorAvatar title={title} src={avatarUrl} width={AVATAR_W_LARGE} eager className="size-14 shrink-0 text-2xl shadow-lg ring-2 ring-white/20 sm:size-20 sm:text-3xl" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              {/* design-ok(raw-h1-in-pages): channel identity header (content title, not app chrome) */}
              <h1 className="truncate text-xl font-extrabold tracking-tight text-white sm:text-3xl">{title}</h1>
              {badge && (
                <span className={cn('hidden shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold sm:inline-flex', badge.badgeClass)}>
                  <badge.icon className="size-3" aria-hidden /> {badge.label}
                </span>
              )}
            </div>
            {metaLine && <p className="mt-0.5 truncate text-xs text-white/70 sm:text-sm">{metaLine}</p>}
          </div>
        </div>
      </div>
      {(description || links.length > 0 || linksLoading) && (
        <div className="mb-6">
          {description && (
            <div className="max-w-2xl text-xs leading-relaxed text-muted-foreground/80">
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
      )}
    </>
  )
}
