// Visibility-managed EventSource lifecycle.
//
// Browsers allow only ~6 concurrent HTTP/1.1 connections per origin, SHARED ACROSS ALL
// TABS. Every long-lived SSE stream pins one of them for the tab's whole life, so two
// or three open tabs (each holding its app-wide streams, plus any audio/media stream)
// exhaust the pool and every later fetch - page loads included - queues forever. That
// is the "second tab won't load / works in the other browser" failure mode.
//
// This wrapper keeps a stream open only while it can matter: open while the tab is
// visible, closed a grace period after it hides (unless `keepWhenHidden` says this tab
// still needs it, e.g. it's the one playing music), reopened the moment the tab is
// shown again. A tab opened in the background doesn't connect until first viewed.

interface ManagedEventSourceOptions {
  /** Re-checked when the hide grace period expires: return true to keep the stream
   *  open in a hidden tab (e.g. media is playing here and a remote may drive it). */
  keepWhenHidden?: () => boolean
  /** How long a tab stays connected after hiding, so quick tab flips don't churn
   *  connect/disconnect (and the backend's most-recent-tab routing stays sane). */
  hideDelayMs?: number
}

/**
 * Manage `create()`'s EventSource across tab visibility changes. The factory must
 * attach all listeners itself - it runs on every (re)connect. Returns a dispose fn.
 */
export function manageEventSource(
  create: () => EventSource,
  { keepWhenHidden, hideDelayMs = 15_000 }: ManagedEventSourceOptions = {},
): () => void {
  let es: EventSource | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const open = () => { if (!disposed && !es) es = create() }
  const close = () => { if (es) { es.close(); es = null } }
  const clearHideTimer = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null } }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      clearHideTimer()
      open()
      return
    }
    clearHideTimer()
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (document.visibilityState === 'visible') return
      if (keepWhenHidden?.()) return
      close()
    }, hideDelayMs)
  }

  if (document.visibilityState === 'visible' || keepWhenHidden?.()) open()
  document.addEventListener('visibilitychange', onVisibility)

  return () => {
    disposed = true
    clearHideTimer()
    close()
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
