import { useState } from 'react'
import { cn } from '@/lib/cn'
import { imgLoad } from '@/lib/img'
import { useCachedImg } from '@/lib/imageStore'
import { thumbUrl } from '@/lib/youtube/format'
import { ytImageProxy } from '@/lib/youtube/api'
import { VideoPlaceholderArt } from '@/components/videos/VideoPlaceholderArt'

/** Video thumbnail with a graceful fallback when the image 404s. An `overrideSrc`
 *  (e.g. a DeArrow community thumbnail, already same-origin) is used when present and
 *  falls back to YouTube's own thumbnail if it fails to load. */
export function VideoThumb({ videoId, title, quality = 'mq', className, overrideSrc, eager }: {
  videoId: string
  title: string
  quality?: 'mq' | 'hq' | 'sd' | 'maxres'
  className?: string
  overrideSrc?: string | null
  /** Above the fold - load now at high priority rather than on scroll-in. */
  eager?: boolean
}) {
  const [ok, setOk] = useState(true)
  const [overrideFailed, setOverrideFailed] = useState(false)
  const useOverride = !!overrideSrc && !overrideFailed
  // Persistent store (IndexedDB): revisited thumbnails paint from disk with no request,
  // even on the http-LAN phones where the service worker's image cache can't install.
  const cached = useCachedImg(ytImageProxy(thumbUrl(videoId, quality)))
  return ok ? (
    <img
      src={useOverride ? overrideSrc! : cached.src}
      alt={title}
      referrerPolicy="no-referrer"
      className={cn('object-cover', className)}
      {...imgLoad(eager)}
      onLoad={useOverride ? undefined : cached.onLoad}
      onError={() => {
        if (useOverride) { setOverrideFailed(true); return }
        if (cached.recover()) return
        setOk(false)
      }}
    />
  ) : (
    // Identity gradient instead of a flat bg-muted hole when the thumbnail 404s.
    <div className={cn('relative overflow-hidden', className)}>
      <VideoPlaceholderArt source="youtube" />
    </div>
  )
}

// The channel/creator avatar now lives in @/components/videos/CreatorAvatar: one shared
// component for YouTube and hub sources alike (proxy choice is host-sniffed internally).
