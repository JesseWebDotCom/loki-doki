// Drives a controls=0 Vimeo iframe (play/pause/seek/volume) over its postMessage Player.js
// SDK, backing the custom control bars that replace the native chrome Vimeo won't let us
// selectively hide (see backend/src/lib/videos/providers/vimeo.ts).
import { useEffect, useRef, type RefObject } from 'react'
import { loadVimeoApi, type VimeoPlayer } from '@/lib/vimeo/api'

interface VimeoPlayerHandlers {
  onPlay?: () => void
  onPause?: () => void
  onTimeUpdate?: (seconds: number, duration: number) => void
  onEnded?: () => void
}

export function useVimeoPlayer(iframeRef: RefObject<HTMLIFrameElement | null>, key: string, handlers: VimeoPlayerHandlers) {
  const playerRef = useRef<VimeoPlayer | null>(null)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!iframeRef.current) return
    let cancelled = false
    void loadVimeoApi().then(Vimeo => {
      if (cancelled || !iframeRef.current) return
      const player = new Vimeo.Player(iframeRef.current)
      playerRef.current = player
      player.on('play', () => handlersRef.current.onPlay?.())
      player.on('pause', () => handlersRef.current.onPause?.())
      player.on('timeupdate', (d) => handlersRef.current.onTimeUpdate?.(d.seconds, d.duration))
      player.on('ended', () => handlersRef.current.onEnded?.())
    })
    return () => {
      cancelled = true
      const p = playerRef.current; playerRef.current = null
      try { void p?.destroy?.() } catch { /* noop */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return {
    play: () => { try { void playerRef.current?.play?.()?.catch(() => {}) } catch { /* noop */ } },
    pause: () => { try { void playerRef.current?.pause?.()?.catch(() => {}) } catch { /* noop */ } },
    seek: (sec: number) => { try { void playerRef.current?.setCurrentTime?.(sec)?.catch(() => {}) } catch { /* noop */ } },
    setVolume: (v: number) => { try { void playerRef.current?.setVolume?.(v)?.catch(() => {}) } catch { /* noop */ } },
  }
}
