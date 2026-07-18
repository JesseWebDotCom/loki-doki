// Auto Picture-in-Picture: a playing video pops into PiP when the user switches
// app/tab, and pops back when they return (only if WE entered it - a PiP the user
// chose stays put).
//
// Three mechanisms, best-effort by platform:
//  - Safari (macOS/iOS): the `autoPictureInPicture` attribute - WebKit engages PiP
//    itself on app switch for the most-recently-playing tagged video.
//  - Chrome 134+: the MediaSession 'enterpictureinpicture' action - registering it
//    makes the browser fire it on tab switch when the site has auto-PiP permission.
//  - Everything else: a straight requestPictureInPicture() on visibilitychange, which
//    some browsers allow for a recently-interacted video and others reject - harmless.

import { useEffect, useRef } from 'react'

export function useAutoPip(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  opts: { enabled?: boolean } = {},
): void {
  const { enabled = true } = opts
  const autoEnteredRef = useRef(false)

  useEffect(() => {
    if (!enabled) return
    // Players mount their <video> lazily (after data loads), so never capture the
    // element here - all listeners live at document level (capture phase: media events
    // don't bubble but ARE capturable) and read videoRef.current at event time.

    const enter = async () => {
      const el = videoRef.current
      if (!el || el.paused || document.pictureInPictureElement) return
      if (!document.pictureInPictureEnabled || el.disablePictureInPicture) return
      try {
        await el.requestPictureInPicture()
        autoEnteredRef.current = true
      } catch { /* no gesture/permission - the Safari attribute or Chrome action may still fire */ }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void enter()
      else if (autoEnteredRef.current && document.pictureInPictureElement === videoRef.current) {
        autoEnteredRef.current = false
        void document.exitPictureInPicture().catch(() => {})
      }
    }

    // If the user closes the PiP window themselves, stop treating it as ours.
    const onLeave = (e: Event) => { if (e.target === videoRef.current) autoEnteredRef.current = false }

    // Our video started playing: tag it for Safari's native auto-PiP and claim Chrome's
    // sanctioned auto-PiP action while it's the playing one.
    const onPlaying = (e: Event) => {
      const el = videoRef.current
      if (!el || e.target !== el) return
      type SafariVideo = HTMLVideoElement & { autoPictureInPicture?: boolean }
      ;(el as SafariVideo).autoPictureInPicture = true
      try {
        navigator.mediaSession?.setActionHandler('enterpictureinpicture' as MediaSessionAction, () => { void enter() })
      } catch { /* action not supported */ }
    }

    document.addEventListener('playing', onPlaying, true)
    document.addEventListener('leavepictureinpicture', onLeave, true)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('playing', onPlaying, true)
      document.removeEventListener('leavepictureinpicture', onLeave, true)
      document.removeEventListener('visibilitychange', onVisibility)
      try { navigator.mediaSession?.setActionHandler('enterpictureinpicture' as MediaSessionAction, null) } catch { /* ignore */ }
    }
  }, [videoRef, enabled])
}
