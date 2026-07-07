import { useState } from 'react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'

// design-ok(raw-palette-semantic): deterministic letter-avatar palette (identity data, not a UI accent)
export const AVATAR_COLORS = ['bg-red-500/20 text-red-400', 'bg-blue-500/20 text-blue-400', 'bg-green-500/20 text-green-400',
  'bg-sky-500/20 text-sky-400', 'bg-brand/15 text-brand', 'bg-pink-500/20 text-pink-400',
  'bg-teal-500/20 text-teal-400', 'bg-orange-500/20 text-orange-400']

/** Generic creator/community avatar (image with a deterministic-letter fallback), mirroring
 *  youtube's ChannelAvatar but routed through the SSRF-safe generic image proxy (/api/img)
 *  instead of YouTube's own (/api/youtube/img, which allows only Google CDNs): Reddit/TikTok/
 *  Vimeo avatars don't live on YouTube's CDN, so ytImageProxy silently drops them. */
export function CreatorAvatar({ title, src, className, proxy = proxyImg }: {
  title: string
  src?: string | null
  className?: string
  /** Image proxy to route through. Defaults to the generic /api/img; YouTube surfaces pass
   *  ytImageProxy so Google-CDN avatars use YouTube's own cache. */
  proxy?: (url: string) => string
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (src && failedSrc !== src) {
    return <img key={src} src={proxy(src)} alt={title} referrerPolicy="no-referrer" className={cn('rounded-full object-cover shrink-0', className)} onError={() => setFailedSrc(src)} />
  }
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length]
  const letter = (title.trim()[0] ?? '?').toUpperCase()
  return <div className={cn('flex items-center justify-center rounded-full font-semibold shrink-0', color, className)}>{letter}</div>
}
