// Platform/capability detection for playback behavior. Kept deliberately tiny: we only
// branch on what changes behavior (iOS media pipeline quirks), never for styling.

/** iPhone/iPad (including iPadOS pretending to be macOS: Mac UA + real touch). */
export function isIOS(): boolean {
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

/** Any WebKit Safari (macOS or iOS) - the engine without programmatic-PiP-on-hide. */
export function isSafari(): boolean {
  const ua = navigator.userAgent
  return /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\//.test(ua)
}

/** Installed to the home screen / running as a standalone PWA window. */
export function isStandalonePWA(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as { standalone?: boolean }).standalone === true
}
