import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { reportClientError } from '@/lib/clientErrorReport'

interface Props {
  children: ReactNode
  /** Optional custom fallback; defaults to a centered message + reload button. */
  fallback?: ReactNode
}
interface State { error: Error | null; autoReloading: boolean }

// A lazy route chunk that no longer exists - the dev server restarted or a new build
// deployed since this page loaded, so the old hashed chunk URLs 404. A reload always
// fixes it, so do that automatically instead of showing the error screen.
// Messages per engine: Chrome "Failed to fetch dynamically imported module", Firefox
// "error loading dynamically imported module", Safari "Importing a module script failed".
const STALE_CHUNK_RE = /dynamically imported module|module script failed|Loading (CSS )?chunk|not a valid JavaScript MIME type/i

// One auto-reload per minute: if the reloaded page immediately errors again the problem
// isn't a stale chunk, and looping reloads would make the app unusable.
const RELOAD_STAMP_KEY = 'errorBoundary.autoReloadAt'
function tryAutoReload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_STAMP_KEY) ?? 0)
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()))
  } catch { /* storage unavailable → still reload; the loop guard just won't hold */ }
  window.location.reload()
  return true
}

// App-wide safety net: a render-time throw in any page would otherwise unmount the whole
// React root and leave a blank screen with no recovery. This catches it and shows a
// reloadable fallback instead - except stale-chunk errors, which self-heal via reload.
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, autoReloading: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
    reportClientError('error-boundary', error, { componentStack: (info.componentStack ?? '').slice(0, 2000) })
    if (STALE_CHUNK_RE.test(error.message) && tryAutoReload()) {
      this.setState({ autoReloading: true })
    }
  }

  override render() {
    if (!this.state.error) return this.props.children
    if (this.state.autoReloading) {
      return (
        <div className="flex min-h-screen items-center justify-center p-6">
          <p className="text-sm text-muted-foreground">A new version was deployed - reloading…</p>
        </div>
      )
    }
    if (this.props.fallback) return this.props.fallback
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-title text-foreground">Something went wrong</div>
        <p className="max-w-md text-sm text-muted-foreground">
          This page hit an unexpected error. Reloading usually fixes it.
        </p>
        <div className="flex gap-2">
          {/* Reset first: a transient render error (a race, a bad cache entry) recovers
              without losing app state; if it rethrows, the boundary catches it again. */}
          <Button variant="outline" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    )
  }
}
