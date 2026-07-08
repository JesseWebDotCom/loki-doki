// Drives a controls=0 TikTok iframe (play/pause/seek/mute) over its postMessage embed-player
// API; see lib/tiktok/api.ts for why this is a raw wrapper rather than an SDK. Mirrors
// use-vimeo-player's shape so the watch page and mini-bar can treat both sources the same way.
import { useEffect, useRef, type RefObject } from 'react'
import { tiktokCommands, onTikTokMessage } from '@/lib/tiktok/api'

interface TikTokPlayerHandlers {
  onPlay?: () => void
  onPause?: () => void
  onTimeUpdate?: (seconds: number, duration: number) => void
  onEnded?: () => void
}

export function useTikTokPlayer(iframeRef: RefObject<HTMLIFrameElement | null>, key: string, handlers: TikTokPlayerHandlers) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    return onTikTokMessage(iframe, (msg) => {
      if (msg.type === 'onStateChange') {
        if (msg.value === 1) handlersRef.current.onPlay?.()
        else if (msg.value === 2) handlersRef.current.onPause?.()
        else if (msg.value === 0) handlersRef.current.onEnded?.()
      } else if (msg.type === 'onCurrentTime') {
        handlersRef.current.onTimeUpdate?.(msg.value.currentTime, msg.value.duration)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return {
    play: () => { const el = iframeRef.current; if (el) tiktokCommands.play(el) },
    pause: () => { const el = iframeRef.current; if (el) tiktokCommands.pause(el) },
    seek: (sec: number) => { const el = iframeRef.current; if (el) tiktokCommands.seekTo(el, sec) },
    mute: () => { const el = iframeRef.current; if (el) tiktokCommands.mute(el) },
    unMute: () => { const el = iframeRef.current; if (el) tiktokCommands.unMute(el) },
  }
}
