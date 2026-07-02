import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCw } from 'lucide-react'

interface Props {
  children: ReactNode
}
interface State { error: Error | null }

// Per-tile safety net for dashboard-style widgets: a render-time throw inside one
// widget would otherwise bubble to the app-wide ErrorBoundary and blank the whole
// page. This isolates the failure to a compact muted card with a retry (remount)
// affordance, sized to fit the widget tile it replaces.
export class WidgetErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[WidgetErrorBoundary]', error, info.componentStack)
  }

  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="rounded-xl border border-dashed border-border/40 bg-card/40 p-4 h-full min-h-24 flex flex-col items-center justify-center gap-1.5 text-center">
        <p className="text-[11px] text-muted-foreground/50">This widget hit an error</p>
        <button
          onClick={() => this.setState({ error: null })}
          className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground/60 hover:text-foreground/80 transition-colors"
        >
          <RotateCw className="size-3" />
          Retry
        </button>
      </div>
    )
  }
}
