import { useContext, useLayoutEffect, useMemo, type ContextType, type ReactNode } from 'react'
import { UNSAFE_NavigationContext, parsePath, useLocation, type To } from 'react-router-dom'
import { notifyRouteCommitted, startRouteTransition } from '@/lib/viewTransition'

type NavigationContextValue = NonNullable<ContextType<typeof UNSAFE_NavigationContext>>

/** Returns the destination pathname, if the `to` value carries one. By the time the
 *  navigator sees it, relative paths have already been resolved to absolute ones. */
function pathnameOf(to: To): string | undefined {
  return (typeof to === 'string' ? parsePath(to) : to).pathname
}

/** True when the navigation changes the page (pathname), as opposed to only query params
 *  or hash. URL-synced state (search boxes, tab params, pagination) must NOT trigger a
 *  view transition: it fires per keystroke and would freeze rendering for each snapshot. */
function changesPathname(to: To): boolean {
  const next = pathnameOf(to)
  return !!next && next !== window.location.pathname
}

/** Mount ONCE, directly inside BrowserRouter (App.tsx). Wraps the router's navigator so
 *  EVERY in-app navigation (any `Link` click, any `useNavigate()` call, anywhere in the
 *  tree below) runs inside a browser view transition, a crossfade between the old and new
 *  page, with no per-link opt-in. Browser back/forward (popstate) bypasses the navigator
 *  and stays untransitioned, which is the platform norm.
 *
 *  UNSAFE_NavigationContext is React Router's internal context; the version is pinned to
 *  v6 and the wrapper only decorates the documented Navigator methods, so a router bump
 *  that changes this surface will fail loudly in the Vite build, not silently. */
export function ViewTransitionProvider({ children }: { children: ReactNode }) {
  const navigation = useContext(UNSAFE_NavigationContext) as NavigationContextValue
  const { navigator } = navigation

  const wrapped = useMemo<NavigationContextValue>(() => ({
    ...navigation,
    navigator: {
      ...navigator,
      push: (to, state, opts) => {
        if (!changesPathname(to)) return navigator.push(to, state, opts)
        startRouteTransition(() => navigator.push(to, state, opts))
      },
      replace: (to, state, opts) => {
        if (!changesPathname(to)) return navigator.replace(to, state, opts)
        startRouteTransition(() => navigator.replace(to, state, opts))
      },
      go: (delta) => startRouteTransition(() => navigator.go(delta)),
    },
  }), [navigation, navigator])

  return (
    <UNSAFE_NavigationContext.Provider value={wrapped}>
      <RouteCommitBridge />
      {children}
    </UNSAFE_NavigationContext.Provider>
  )
}

/** Signals every location commit so startRouteTransition snapshots the fully rendered
 *  destination page. Renders nothing. */
function RouteCommitBridge(): null {
  const location = useLocation()
  useLayoutEffect(() => {
    notifyRouteCommitted()
  }, [location])
  return null
}
