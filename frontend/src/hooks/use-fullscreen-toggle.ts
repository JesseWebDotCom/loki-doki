// Toggles native fullscreen on a container element, exiting if already active so the same
// control works both ways. Shared by the watch-page players (Vimeo/TikTok/native video) that
// hide their source's own fullscreen button and need to drive it themselves.
import { type RefObject } from 'react'

type FsDoc = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void }
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void }

export function useFullscreenToggle(containerRef: RefObject<HTMLElement | null>) {
  return () => {
    const doc = document as FsDoc
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      try { (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document) } catch { /* noop */ }
      return
    }
    const el = containerRef.current as FsEl | null
    try { el?.requestFullscreen ? void el.requestFullscreen() : el?.webkitRequestFullscreen?.() } catch { /* noop */ }
  }
}
