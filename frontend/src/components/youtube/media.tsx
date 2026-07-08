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
      className={cn('object-cover bg-muted', className)}
      loading="lazy"
      onError={() => useOverride ? setOverrideFailed(true) : setOk(false)}
    />
  ) : (
    <div className={cn('flex items-center justify-center bg-muted', className)}>
      <Play className="size-8 text-muted-foreground/40" />
    </div>
  )
}

// The channel/creator avatar now lives in @/components/videos/CreatorAvatar: one shared
// component for YouTube and hub sources alike (proxy choice is host-sniffed internally).
