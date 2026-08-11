// Run a callback once the browser is idle, with a timeout so it still runs on engines
// without requestIdleCallback (Safari). Returns a canceller. Shared by the idle app
// warmer and the per-list scroll-ahead image warmer so neither competes with first paint.

type IdleHandle = number

export function onIdle(cb: () => void, timeout = 3000): () => void {
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => IdleHandle
    cancelIdleCallback?: (id: IdleHandle) => void
  }
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(cb, { timeout })
    return () => w.cancelIdleCallback?.(id)
  }
  const t = setTimeout(cb, Math.min(timeout, 1500))
  return () => clearTimeout(t)
}
