import { useState } from 'react'
import { Play } from 'lucide-react'
import { cn } from '@/lib/cn'
import { thumbUrl } from '@/lib/youtube/format'
import { ytImageProxy } from '@/lib/youtube/api'

/** Video thumbnail with a graceful fallback when the image 404s. An `overrideSrc`
 *  (e.g. a DeArrow community thumbnail, already same-origin) is used when present and
 *  falls back to YouTube's own thumbnail if it fails to load. */
export function VideoThumb({ videoId, title, quality = 'mq', className, overrideSrc }: {
  videoId: string
  title: string
  quality?: 'mq' | 'hq' | 'sd' | 'maxres'
  className?: string
  overrideSrc?: string | null
}) {
  const [ok, setOk] = useState(true)
  const [overrideFailed, setOverrideFailed] = useState(false)
  const useOverride = !!overrideSrc && !overrideFailed
  return ok ? (
    <img
      src={useOverride ? overrideSrc! : ytImageProxy(thumbUrl(videoId, quality))}
      alt={title}
      referrerPolicy="no-referrer"
      className={cn('object-cover', className)}
      loading="lazy"
      onError={() => useOverride ? setOverrideFailed(true) : setOk(false)}
    />
  ) : (
    <div className={cn('flex items-center justify-center bg-muted', className)}>
      <Play className="size-8 text-muted-foreground/40" />
    </div>
  )
}

// Distinct per-channel avatar: the channel thumbnail when present, else a coloured
// circle with the channel's initial, so subscription lists aren't a wall of clones.
const AVATAR_COLORS = [
  'bg-rose-500/20 text-rose-400', 'bg-amber-500/20 text-amber-400', 'bg-emerald-500/20 text-emerald-400', // design-ok(raw-palette-semantic): deterministic letter-avatar palette (channel identity data, not UI accents)
  'bg-sky-500/20 text-sky-400', 'bg-brand/15 text-brand', 'bg-pink-500/20 text-pink-400', // design-ok(raw-palette-semantic): deterministic letter-avatar palette (channel identity data, not UI accents)
  'bg-teal-500/20 text-teal-400', 'bg-orange-500/20 text-orange-400', // design-ok(raw-palette-semantic): deterministic letter-avatar palette (channel identity data, not UI accents)
]

export function ChannelAvatar({ title, src, className }: { title: string; src?: string | null; className?: string }) {
  // Track the URL that failed (not a bare boolean) so navigating to a different channel with a
  // new src gets a fresh chance to load instead of staying stuck on the letter fallback.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  // referrerPolicy="no-referrer": Google's avatar CDN (yt3.googleusercontent.com) 429s hotlinked
  // requests that carry a localhost Referer, which made avatars silently fall back to the letter.
  if (src && failedSrc !== src) return <img key={src} src={ytImageProxy(src)} alt={title} referrerPolicy="no-referrer" className={cn('rounded-full object-cover shrink-0', className)} onError={() => setFailedSrc(src)} />
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length]
  const letter = (title.trim()[0] ?? '?').toUpperCase()
  return (
    <div className={cn('flex items-center justify-center rounded-full font-semibold shrink-0', color, className)}>
      {letter}
    </div>
  )
}
