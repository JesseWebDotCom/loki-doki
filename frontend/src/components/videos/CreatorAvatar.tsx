import { useState } from 'react'
import { cn } from '@/lib/cn'
import { proxyImgAuto } from '@/lib/img'

// design-ok(raw-palette-semantic): deterministic letter-avatar palette (identity data, not a UI accent)
export const AVATAR_COLORS = ['bg-red-500/20 text-red-400', 'bg-blue-500/20 text-blue-400', 'bg-green-500/20 text-green-400',
  'bg-sky-500/20 text-sky-400', 'bg-brand/15 text-brand', 'bg-pink-500/20 text-pink-400',
  'bg-teal-500/20 text-teal-400', 'bg-orange-500/20 text-orange-400']

/** THE creator/channel/community avatar for every video surface (YouTube and hub sources
 *  alike): image with a deterministic-letter fallback. Proxy choice is internal -
 *  proxyImgAuto host-sniffs the URL, so Google-CDN avatars ride YouTube's own cache
 *  (/api/youtube/img, Google-hosts-only allowlist) and everything else rides the generic
 *  SSRF-guarded /api/img. Callers never pick a proxy. */
export function CreatorAvatar({ title, src, className }: {
  title: string
  src?: string | null
  className?: string
}) {
  // Track the URL that failed (not a bare boolean) so navigating to a different creator with
  // a new src gets a fresh chance to load instead of staying stuck on the letter fallback.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (src && failedSrc !== src) {
    // referrerPolicy="no-referrer": Google's avatar CDN (yt3.googleusercontent.com) 429s
    // hotlinked requests carrying a localhost Referer - avatars silently became letters.
    return <img key={src} src={proxyImgAuto(src)} alt={title} referrerPolicy="no-referrer" className={cn('rounded-full object-cover shrink-0', className)} onError={() => setFailedSrc(src)} />
  }
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length]
  const letter = (title.trim()[0] ?? '?').toUpperCase()
  return <div className={cn('flex items-center justify-center rounded-full font-semibold shrink-0', color, className)}>{letter}</div>
}
