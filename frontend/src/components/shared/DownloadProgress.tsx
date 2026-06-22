import { cn } from '@/lib/cn'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Download,
  Pause,
  Play,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  HardDrive,
} from 'lucide-react'

export type DownloadStatus =
  | 'idle'
  | 'pending'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'

export interface DownloadProgressProps {
  label: string
  description?: string
  status: DownloadStatus
  progress?: number        // 0–100
  downloadedBytes?: number
  totalBytes?: number
  speedBps?: number        // bytes/sec
  etaSeconds?: number
  error?: string
  note?: string            // sub-status shown while no bytes have flowed yet
  onStart?: () => void
  onPause?: () => void
  onResume?: () => void
  onCancel?: () => void
  onRetry?: () => void
  className?: string
}

// ── helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b <= 0) return '0 B'
  if (b < 1024) return `${b} B`
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`
  return `${(b / 1_073_741_824).toFixed(2)} GB`
}

function formatEta(s: number): string {
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function pct(done: number, total: number): number | null {
  if (total <= 0) return null
  return Math.min(100, Math.round((done * 100) / total))
}

// ── sub-components ────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: DownloadStatus }) {
  switch (status) {
    case 'pending':
      return <Loader2 className="size-4 animate-spin text-blue-400" />
    case 'downloading':
      return <Download className="size-4 text-blue-400" />
    case 'paused':
      return <Pause className="size-4 text-amber-400" />
    case 'completed':
      return <CheckCircle2 className="size-4 text-emerald-400" />
    case 'error':
      return <AlertCircle className="size-4 text-red-400" />
    case 'cancelled':
      return <X className="size-4 text-muted-foreground" />
    default:
      return <HardDrive className="size-4 text-muted-foreground" />
  }
}

function StatusBadge({ status }: { status: DownloadStatus }) {
  const map: Record<DownloadStatus, { label: string; className: string }> = {
    idle:        { label: 'Not installed', className: 'border-border text-muted-foreground' },
    pending:     { label: 'Starting…',     className: 'border-blue-500/40 text-blue-400 bg-blue-500/10' },
    downloading: { label: 'Downloading',   className: 'border-blue-500/40 text-blue-400 bg-blue-500/10' },
    paused:      { label: 'Paused',        className: 'border-amber-500/40 text-amber-400 bg-amber-500/10' },
    completed:   { label: 'Installed',     className: 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10' },
    error:       { label: 'Failed',        className: 'border-red-500/40 text-red-400 bg-red-500/10' },
    cancelled:   { label: 'Cancelled',     className: 'border-border text-muted-foreground' },
  }
  const { label, className } = map[status]
  return (
    <span className={cn('rounded-full border px-2.5 py-0.5 text-[11px] font-semibold', className)}>
      {label}
    </span>
  )
}

function ProgressBar({
  progress,
  status,
  indeterminate,
}: {
  progress: number
  status: DownloadStatus
  indeterminate: boolean
}) {
  const fillColor =
    status === 'paused'    ? 'bg-amber-500' :
    status === 'completed' ? 'bg-emerald-500' :
    status === 'error'     ? 'bg-red-500' :
    null // use gradient

  const isIndeterminate = indeterminate
  const isAnimated = status === 'downloading' && !indeterminate

  return (
    <div
      className="relative h-2.5 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={isIndeterminate ? undefined : progress}
    >
      {isIndeterminate ? (
        <div className="absolute inset-y-0 w-1/3 rounded-full bg-blue-500/60 animate-[indeterminate_1.4s_ease-in-out_infinite]" />
      ) : (
        <div
          className={cn(
            'absolute inset-y-0 left-0 overflow-hidden rounded-full transition-[width] duration-500 ease-out',
            fillColor,
          )}
          style={{
            width: `${progress}%`,
            ...(isAnimated && !fillColor ? {
              background: 'linear-gradient(90deg, #3b82f6, #8b5cf6, #a855f7, #8b5cf6, #3b82f6)',
              backgroundSize: '200% 100%',
              animation: 'dl-gradient 2s linear infinite',
            } : {}),
          }}
        >
          {isAnimated && (
            <div
              className="absolute inset-y-0 w-12 animate-dl-shimmer"
              style={{
                background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────

export function DownloadProgress({
  label,
  description,
  status,
  progress: progressProp,
  downloadedBytes = 0,
  totalBytes = 0,
  speedBps,
  etaSeconds,
  error,
  note,
  onStart,
  onPause,
  onResume,
  onCancel,
  onRetry,
  className,
}: DownloadProgressProps) {
  const progress = progressProp ?? pct(downloadedBytes, totalBytes) ?? 0
  const showBar = status === 'pending' || status === 'downloading' || status === 'paused'
  // No bytes yet (resolving the URL / connecting / starved behind another download):
  // animate an indeterminate bar so the row never reads as a frozen 0%.
  const notStarted = status === 'downloading' && downloadedBytes <= 0
  const indeterminate = status === 'pending' || notStarted || (status === 'downloading' && totalBytes <= 0)

  const statsFragments: string[] = []
  if (notStarted && note) statsFragments.push(note)
  else if (totalBytes > 0) {
    statsFragments.push(
      status === 'completed'
        ? formatBytes(totalBytes)
        : `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`,
    )
  }
  if (speedBps && speedBps > 0 && status === 'downloading') {
    statsFragments.push(`${formatBytes(speedBps)}/s`)
  }
  if (etaSeconds && etaSeconds > 0 && status === 'downloading') {
    statsFragments.push(`${formatEta(etaSeconds)} remaining`)
  }

  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-4 shadow-sm transition-colors',
        status === 'completed' && 'border-emerald-500/20',
        status === 'error' && 'border-red-500/20',
        status === 'downloading' && 'border-blue-500/20',
        status === 'paused' && 'border-amber-500/20',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusIcon status={status} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{label}</p>
            {description && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Progress bar + stats */}
      {showBar && (
        <div className="mt-3 space-y-2">
          <ProgressBar progress={progress} status={status} indeterminate={indeterminate} />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs tabular-nums text-muted-foreground">
              {statsFragments.join(' · ')}
            </p>
            {!indeterminate && (
              <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {progress}%
              </p>
            )}
          </div>
        </div>
      )}

      {/* Completed stats */}
      {status === 'completed' && statsFragments.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">{statsFragments.join(' · ')}</p>
      )}

      {/* Error message */}
      {status === 'error' && error && (
        <p className="mt-2 text-xs text-red-400">{error}</p>
      )}

      {/* Action buttons */}
      <div className="mt-3 flex items-center justify-end gap-2">
        {status === 'idle' && onStart && (
          <Button size="sm" onClick={onStart} className="gap-1.5">
            <Download className="size-3.5" />
            Download
          </Button>
        )}

        {status === 'downloading' && (
          <>
            {onPause && (
              <Button size="sm" variant="outline" onClick={onPause} className="gap-1.5">
                <Pause className="size-3.5" />
                Pause
              </Button>
            )}
            {onCancel && (
              <Button size="sm" variant="ghost" onClick={onCancel} className="gap-1.5 text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
                Cancel
              </Button>
            )}
          </>
        )}

        {status === 'paused' && (
          <>
            {onResume && (
              <Button size="sm" onClick={onResume} className="gap-1.5">
                <Play className="size-3.5" />
                Resume
              </Button>
            )}
            {onCancel && (
              <Button size="sm" variant="ghost" onClick={onCancel} className="gap-1.5 text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
                Cancel
              </Button>
            )}
          </>
        )}

        {(status === 'error' || status === 'cancelled') && onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} className="gap-1.5">
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        )}

        {(status === 'error' || status === 'cancelled') && onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} className="gap-1.5 text-muted-foreground hover:text-foreground">
            <X className="size-3.5" />
            Dismiss
          </Button>
        )}
      </div>
    </div>
  )
}
