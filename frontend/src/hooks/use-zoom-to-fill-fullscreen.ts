// Fullscreen toggle + a "zoom to fill" mode that swaps the video element's CSS object-fit
// between 'contain' (default — letterboxed, nothing cropped) and 'cover' (fills the screen,
// cropping the sides) while fullscreen. Generic over any video-in-container player: driven by
// refs, not tied to YouTube. Fill mode is component state only (a transient per-session
// viewing choice, not a persisted preference) and only meaningful while fullscreen, so it's
// reset back to 'contain' on exit.
import { useEffect, useState, type RefObject } from 'react'

export type FillMode = 'contain' | 'cover'

type FullscreenDoc = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void }
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => void }

export function useZoomToFillFullscreen(
  videoElRef: RefObject<HTMLElement | null>,
  containerRef: RefObject<HTMLElement | null>,
) {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fillMode, setFillMode] = useState<FillMode>('contain')

  useEffect(() => {
    const doc = document as FullscreenDoc
    const onChange = () => {
      const active = !!(doc.fullscreenElement || doc.webkitFullscreenElement)
      setIsFullscreen(active)
      if (!active) setFillMode('contain') // zoom is only meaningful in fullscreen
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
  }, [])

  useEffect(() => {
    const el = videoElRef.current as (HTMLElement & { style: CSSStyleDeclaration }) | null
    if (el) el.style.objectFit = isFullscreen ? fillMode : ''
  }, [videoElRef, isFullscreen, fillMode])

  // Toggle: exit if already fullscreen (so the button works both ways), else request.
  const toggleFullscreen = () => {
    const doc = document as FullscreenDoc
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      try { (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document) } catch { /* noop */ }
      return
    }
    const el = containerRef.current as FullscreenEl | null
    if (!el) return
    try { el.requestFullscreen ? void el.requestFullscreen() : el.webkitRequestFullscreen?.() } catch { /* noop */ }
  }

  const toggleFillMode = () => setFillMode(m => (m === 'contain' ? 'cover' : 'contain'))

  return { isFullscreen, fillMode, toggleFullscreen, toggleFillMode }
}
