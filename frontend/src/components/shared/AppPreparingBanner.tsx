import { Loader2 } from 'lucide-react'
import { useAppPreparing } from '@/context/SetupProgressContext'

// Inline banner shown at the top of an app while its assets are still downloading in the
// background (first-run essentials-boot). Renders nothing once everything is ready.
export function AppPreparingBanner({ path, noun = 'this app' }: { path: string; noun?: string }) {
  const { preparing, pct, label } = useAppPreparing(path)
  if (!preparing) return null
  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 py-3 text-sm">
      <Loader2 className="size-4 shrink-0 animate-spin text-violet-400" />
      <span className="min-w-0 flex-1">
        Still setting up {noun}{label ? <> — downloading <span className="font-medium">{label}</span></> : null}
        {pct > 0 ? <span className="tabular-nums text-muted-foreground"> · {pct}%</span> : null}
      </span>
    </div>
  )
}
