// Platform/capability detection for playback behavior. Kept deliberately tiny: we only
// branch on what changes behavior (iOS media pipeline quirks), never for styling.

/** iPhone/iPad (including iPadOS pretending to be macOS: Mac UA + real touch). */
export function isIOS(): boolean {
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

/** True where routing media elements through Web Audio breaks background playback:
 *  iOS suspends the page's AudioContext when the app is backgrounded or the phone
 *  locks, which silences (and soon pauses) any element sourced into a DSP graph,
 *  even though the bare element would have kept playing on the lock screen. The
 *  DSP graphs are additive by contract, so on these platforms they simply must not
 *  attach: playback works un-EQ'd and survives app switches and the lock screen. */
export function webAudioBreaksBackgroundPlayback(): boolean {
  return isIOS()
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
