import { useState } from 'react'
import { Play } from 'lucide-react'
import { cn } from '@/lib/cn'
import { thumbUrl } from '@/lib/youtube/format'

/** Video thumbnail with a graceful fallback when the image 404s. */
export function VideoThumb({ videoId, title, quality = 'mq', className }: {
  videoId: string
  title: string
  quality?: 'mq' | 'hq' | 'sd' | 'maxres'
  className?: string
}) {
  const [ok, setOk] = useState(true)
  return ok ? (
    <img
      src={thumbUrl(videoId, quality)}
      alt={title}
      className={cn('object-cover', className)}
      loading="lazy"
      onError={() => setOk(false)}
    />
  ) : (
    <div className={cn('flex items-center justify-center bg-muted', className)}>
      <Play className="size-8 text-muted-foreground/40" />
    </div>
  )
}

// Distinct per-channel avatar: the channel thumbnail when present, else a coloured
// circle with the channel's initial — so subscription lists aren't a wall of clones.
const AVATAR_COLORS = [
  'bg-rose-500/20 text-rose-400', 'bg-amber-500/20 text-amber-400', 'bg-emerald-500/20 text-emerald-400',
  'bg-sky-500/20 text-sky-400', 'bg-violet-500/20 text-violet-400', 'bg-fuchsia-500/20 text-fuchsia-400',
  'bg-teal-500/20 text-teal-400', 'bg-orange-500/20 text-orange-400',
]

export function ChannelAvatar({ title, src, className }: { title: string; src?: string | null; className?: string }) {
  const [ok, setOk] = useState(true)
  if (src && ok) return <img src={src} alt={title} className={cn('rounded-full object-cover shrink-0', className)} onError={() => setOk(false)} />
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
