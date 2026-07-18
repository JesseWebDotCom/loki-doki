// Same-document View Transitions for route changes. We run BrowserRouter (library mode),
// so React Router's own `viewTransition` support (data routers only) is unavailable, and
// `v7_startTransition` means the router commits location updates inside React.startTransition,
// so a flushSync wrapper could not capture the new DOM either. Instead the transition
// callback resolves when the router actually commits: ViewTransitionProvider signals every
// location commit from a layout effect via notifyRouteCommitted().
//
// Browser coverage: Chromium (the Electron shell) and iOS 18+ Safari animate; anywhere
// `document.startViewTransition` is missing (Firefox) navigation just runs untransitioned.

let pendingCommits: Array<() => void> = []

/** Resolves once the next route commit lands, or after `timeoutMs` (slow first-visit lazy
 *  chunks, same-location navigations). On timeout the swap simply lands unanimated. */
function nextRouteCommit(timeoutMs = 500): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      pendingCommits = pendingCommits.filter((r) => r !== done)
      resolve()
    }, timeoutMs)
    const done = () => {
      clearTimeout(t)
      resolve()
    }
    pendingCommits.push(done)
  })
}

/** Called by ViewTransitionProvider's layout effect on every location commit. */
export function notifyRouteCommitted() {
  const pending = pendingCommits
  pendingCommits = []
  pending.forEach((resolve) => resolve())
}

/** Run a navigation inside a browser view transition (crossfade) when supported; plain
 *  call otherwise. Also skipped under prefers-reduced-motion. */
export function startRouteTransition(navigateFn: () => void) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!document.startViewTransition || reducedMotion) {
    navigateFn()
    return
  }
  document.startViewTransition(async () => {
    const committed = nextRouteCommit()
    navigateFn()
    await committed
  })
}
