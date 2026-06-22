import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Optional custom fallback; defaults to a centered message + reload button. */
  fallback?: ReactNode
}
interface State { error: Error | null }

// App-wide safety net: a render-time throw in any page would otherwise unmount the whole
// React root and leave a blank screen with no recovery. This catches it and shows a
// reloadable fallback instead.
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  override render() {
    if (!this.state.error) return this.props.children
    if (this.props.fallback) return this.props.fallback
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-lg font-medium text-foreground">Something went wrong</div>
        <p className="max-w-md text-sm text-muted-foreground">
          This page hit an unexpected error. Reloading usually fixes it.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-md border border-border px-4 py-2 text-sm hover:bg-card"
        >
          Reload
        </button>
      </div>
    )
  }
}
