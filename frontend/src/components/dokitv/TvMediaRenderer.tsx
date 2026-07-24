// Path A renderer for `media` blocks: a native <video> seeked to the broadcast offset.
// Plex plays through the direct-play proxy, YouTube through the same-origin stream proxy.
// Autoplay-with-sound is attempted first; when the browser blocks it we fall back to
// muted playback with a tap-for-sound affordance (standard TV-app behavior).

import { useEffect, useRef, useState } from 'react'
import { Volume2 } from 'lucide-react'
import { TvSlate } from '@/components/dokitv/TvSlate'
import type { TvBlock, TvChannel } from '@/lib/dokitv/api'

interface TvMediaRendererProps {
  channel: TvChannel
  block: TvBlock
  suspended: boolean
  onEnded: () => void
}

export function TvMediaRenderer({ channel, block, suspended, onEnded }: TvMediaRendererProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [needsTap, setNeedsTap] = useState(false)
  const [failed, setFailed] = useState(false)
  const payload = block.payload

  const src =
    payload.src === 'plex' ? `/api/plex/stream/${encodeURIComponent(payload.ratingKey)}`
    : payload.src === 'youtube' ? `/api/youtube/stream/${encodeURIComponent(payload.videoId)}?kind=video`
    : payload.src === 'segment' ? `/api/tv/segments/${encodeURIComponent(payload.segmentId)}/video`
    : null

  useEffect(() => {
    setFailed(false)
    setNeedsTap(false)
  }, [block.id])

  useEffect(() => {
    const video = videoRef.current
    if (!video || suspended) {
      video?.pause()
      return
    }
    const attempt = video.play()
    if (attempt) {
      attempt.catch(() => {
        // Autoplay with sound blocked: play muted and surface the unmute affordance.
        video.muted = true
        setNeedsTap(true)
        void video.play().catch(() => setFailed(true))
      })
    }
  }, [block.id, suspended])

  if (!src || failed) {
    return (
      <TvSlate
        channel={channel}
        headline={block.title}
        message="This program cannot play in the browser right now. The channel rolls on to the next block."
      />
    )
  }

  return (
    <div className="relative h-full w-full bg-black">
      <video
        key={block.id}
        ref={videoRef}
        src={src}
        className="h-full w-full object-contain"
        autoPlay
        playsInline
        onLoadedMetadata={(e) => {
          // Land mid-program at the broadcast offset, like TV that was already on.
          const offset = Math.max(0, (Date.now() - block.startAt) / 1000)
          const video = e.currentTarget
          if (Number.isFinite(video.duration) && offset < video.duration - 2) video.currentTime = offset
        }}
        onEnded={onEnded}
        onError={() => setFailed(true)}
      />
      {needsTap ? (
        <button
          type="button"
          onClick={() => {
            const video = videoRef.current
            if (video) { video.muted = false; void video.play() }
            setNeedsTap(false)
          }}
          className="absolute left-1/2 top-6 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm font-semibold text-white backdrop-blur hover:bg-black/80"
        >
          <Volume2 className="size-4" />
          Tap for sound
        </button>
      ) : null}
    </div>
  )
}
