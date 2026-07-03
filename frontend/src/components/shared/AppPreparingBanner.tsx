import { Spinner } from '@/components/ui/spinner'
import { useAppPreparing } from '@/context/SetupProgressContext'

// Inline banner shown at the top of an app while its assets are still downloading in the
// background (first-run essentials-boot). Renders nothing once everything is ready.
export function AppPreparingBanner({ path, noun = 'this app' }: { path: string; noun?: string }) {
  const { preparing, pct, label } = useAppPreparing(path)
  if (!preparing) return null
  return (
    <div className="mb-4 flex items-center gap-3 rounded-card border border-brand/30 bg-brand/10 px-4 py-3 text-sm">
      <Spinner className="size-4 shrink-0 text-brand" />
      <span className="min-w-0 flex-1">
        Still setting up {noun}{label ? <>, downloading <span className="font-medium">{label}</span></> : null}
        {pct > 0 ? <span className="tabular-nums text-muted-foreground"> · {pct}%</span> : null}
      </span>
    </div>
  )
}
