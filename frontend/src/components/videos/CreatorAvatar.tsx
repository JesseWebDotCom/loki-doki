import { useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { AVATAR_W, avatarImgUrl, imgLoad } from '@/lib/img'
import { useCachedImg } from '@/lib/imageStore'

// design-ok(raw-palette-semantic): deterministic letter-avatar palette (identity data, not a UI accent)
export const AVATAR_COLORS = ['bg-red-500/20 text-red-400', 'bg-blue-500/20 text-blue-400', 'bg-green-500/20 text-green-400',
  'bg-sky-500/20 text-sky-400', 'bg-brand/15 text-brand', 'bg-pink-500/20 text-pink-400',
  'bg-teal-500/20 text-teal-400', 'bg-orange-500/20 text-orange-400']

/** THE creator/channel/community avatar for every video surface (YouTube and hub sources
 *  alike): image with a deterministic-letter fallback. Proxy choice is internal -
 *  proxyImgAuto host-sniffs the URL, so Google-CDN avatars ride YouTube's own cache
 *  (/api/youtube/img, Google-hosts-only allowlist) and everything else rides the generic
 *  SSRF-guarded /api/img. Callers never pick a proxy. */
export function CreatorAvatar({ title, src, className, width = AVATAR_W, eager }: {
  title: string
  src?: string | null
  className?: string
  /** Device-pixel width to request (see AVATAR_W / AVATAR_W_LARGE). */
  width?: number
  /** Above-the-fold: load immediately at high priority. Off-screen avatars stay lazy so a
   *  long feed cannot spend the browser's ~6 connections on avatars nobody is looking at. */
  eager?: boolean
}) {
  // Track the URL that failed (not a bare boolean) so navigating to a different creator with
  // a new src gets a fresh chance to load instead of staying stuck on the letter fallback.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  // One delayed retry per src: on a slow network a transient stall would otherwise turn a
  // real logo into a letter for the rest of the surface's life.
  const retried = useRef<Set<string>>(new Set())
  // Persistent store (IndexedDB): once a logo has been seen, later opens paint it from
  // disk without a request - the layer service workers provide on secure contexts only.
  const cached = useCachedImg(src ? avatarImgUrl(src, width) : null)
  if (src && failedSrc !== src) {
    // referrerPolicy="no-referrer": Google's avatar CDN (yt3.googleusercontent.com) 429s
    // hotlinked requests carrying a localhost Referer - avatars silently became letters.
    // No key={src}: the element must survive src changes so navigating creator-to-creator
    // keeps the previous avatar painted until the next one decodes (no blank flash).
    return <img src={cached.src} alt={title} referrerPolicy="no-referrer" {...imgLoad(eager)}
      className={cn('rounded-full object-cover shrink-0', className)} onLoad={cached.onLoad}
      onError={() => {
        if (cached.recover()) return
        if (!retried.current.has(src)) {
          retried.current.add(src)
          setTimeout(() => setFailedSrc((cur) => (cur === src ? null : cur)), 4000)
        }
        setFailedSrc(src)
      }} />
  }
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length]
  const letter = (title.trim()[0] ?? '?').toUpperCase()
  return <div className={cn('flex items-center justify-center rounded-full font-semibold shrink-0', color, className)}>{letter}</div>
}
