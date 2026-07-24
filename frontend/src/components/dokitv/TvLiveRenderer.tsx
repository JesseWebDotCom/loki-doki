// Path A renderer for `live` blocks. Frigate cameras arrive as proxied MJPEG (plain
// <img>, per the cameras app's live view); hls feeds attach via hls.js (dynamic import,
// same recipe as the videos WatchPage); video-loop feeds are ambient local loops.

import { useEffect, useRef, useState } from 'react'
import { StatusDot } from '@/components/shared/StatusDot'
import { TvSlate } from '@/components/dokitv/TvSlate'
import type { TvBlock, TvChannel } from '@/lib/dokitv/api'
import type Hls from 'hls.js'

interface TvLiveRendererProps {
  channel: TvChannel
  block: TvBlock
  suspended: boolean
}

export function TvLiveRenderer({ channel, block, suspended }: TvLiveRendererProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const payload = block.payload
  const feed = payload.src === 'live' ? payload.feed : null

  const hlsUrl = feed?.type === 'hls' ? feed.url ?? null : null

  useEffect(() => {
    if (!hlsUrl) return
    const video = videoRef.current
    if (!video) return
    let cancelled = false
    let hls: Hls | null = null
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl
    } else {
      void import('hls.js').then(({ default: HlsCtor }) => {
        if (cancelled || !HlsCtor.isSupported()) return
        hls = new HlsCtor({ maxBufferLength: 30 })
        hls.loadSource(hlsUrl)
        hls.attachMedia(video)
      })
    }
    return () => { cancelled = true; hls?.destroy() }
  }, [hlsUrl])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (suspended) video.pause()
    else void video.play().catch(() => { video.muted = true; void video.play().catch(() => {}) })
  }, [suspended, hlsUrl, block.id])

  if (!feed || failed) {
    return <TvSlate channel={channel} headline={block.title} message="This live feed is not reachable right now." />
  }

  if (feed.type === 'frigate' && feed.camera) {
    return (
      <div className="relative h-full w-full bg-black">
        <img
          src={`/api/frigate/live/${encodeURIComponent(feed.camera)}`}
          alt={feed.label}
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
        <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-white backdrop-blur">
          <StatusDot status="error" pulse className="size-2" />
          Live
        </div>
      </div>
    )
  }

  if (feed.type === 'mjpeg' && feed.url) {
    return (
      <div className="h-full w-full bg-black">
        <img src={feed.url} alt={feed.label} className="h-full w-full object-contain" onError={() => setFailed(true)} />
      </div>
    )
  }

  if ((feed.type === 'hls' && feed.url) || (feed.type === 'video-loop' && feed.url)) {
    return (
      <div className="h-full w-full bg-black">
        <video
          ref={videoRef}
          src={feed.type === 'video-loop' ? feed.url : undefined}
          className="h-full w-full object-contain"
          autoPlay
          playsInline
          loop={feed.type === 'video-loop'}
          onError={() => setFailed(true)}
        />
      </div>
    )
  }

  return <TvSlate channel={channel} headline={block.title} message="Add a stream URL in the TV settings to light this channel up." />
}
