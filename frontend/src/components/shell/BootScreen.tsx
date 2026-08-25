import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, AlertTriangle, XCircle, ChevronRight, ChevronDown, Wrench } from 'lucide-react'
import { cn } from '@/lib/cn'
import { BrandMark } from '@/components/shared/BrandMark'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { BOOT_STEP_FEATURE_NAME } from '@/lib/features'

type StepStatus = 'running' | 'ok' | 'warn' | 'error'

interface BootStep {
  key: string
  label: string
  status: StepStatus
  detail?: string
}

interface RepairProgress {
  key: string
  completed: number
  total: number
  speedBps: number
  etaSeconds: number
}

interface BootScreenProps {
  onComplete: () => void
}

// db, hw, ollama, llm, embed, router, image, happy-path count
const TOTAL_STEPS = 7

function fmtBytes(b: number): string {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(0)} MB`
  return `${(b / 1024).toFixed(0)} KB`
}

function fmtSpeed(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} KB/s`
  return `${bps.toFixed(0)} B/s`
}

function fmtEta(s: number): string {
  if (s < 60) return `${Math.ceil(s)}s`
  if (s < 3600) return `${Math.ceil(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

export function BootScreen({ onComplete }: BootScreenProps) {
  const [steps, setSteps]         = useState<BootStep[]>([])
  const [repairs, setRepairs]     = useState<Map<string, RepairProgress>>(new Map())
  const [currentLabel, setLabel]  = useState('Starting up…')
  const [phase, setPhase]         = useState<'booting' | 'repairing' | 'paused' | 'done'>('booting')
  const [showDetails, setShowDetails] = useState(false)
  const [fadeOut, setFadeOut]     = useState(false)
  const [progress, setProgress]   = useState(0)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const doneSteps     = useRef(0)
  const runningLabels = useRef(new Map<string, string>())

  useEffect(() => {
    doneSteps.current = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let es: EventSource
    let dead = false

    function connect() {
      es = new EventSource('/api/system/boot', { withCredentials: true })

      es.addEventListener('step', (e) => {
        let incoming: BootStep
        try { incoming = JSON.parse(e.data) as BootStep } catch { return } // skip malformed frame
        const featureName = BOOT_STEP_FEATURE_NAME[incoming.key]

        if (incoming.status === 'running') {
          // Show friendly feature name in main label; keep technical label for detail list
          const friendlyLabel = featureName ? `Loading ${featureName}…` : incoming.label
          setLabel(friendlyLabel)
          runningLabels.current.set(incoming.key, incoming.label)
          setSteps((prev) => {
            const idx = prev.findIndex((s) => s.key === incoming.key && s.status === 'running')
            if (idx < 0) return prev
            const next = [...prev]
            next[idx] = { ...next[idx], label: incoming.label }
            return next
          })
          return
        }

        doneSteps.current += 1
        // Reconcile can emit extra steps beyond the happy-path count, clamp to 100.
        setProgress(Math.min(100, Math.round((doneSteps.current / TOTAL_STEPS) * 100)))
        // Friendly label for ok; keep backend label for warn/error (they're descriptive)
        const friendlyLabel = featureName && incoming.status === 'ok'
          ? `${featureName} ready`
          : incoming.label
        setLabel(friendlyLabel)

        setSteps((prev) => {
          const idx = prev.findIndex((s) => s.key === incoming.key)
          if (idx >= 0) {
            const next = [...prev]; next[idx] = incoming; return next
          }
          return [...prev, incoming]
        })

        setRepairs((prev) => {
          if (!prev.has(incoming.key)) return prev
          const next = new Map(prev)
          next.delete(incoming.key)
          return next
        })
      })

      es.addEventListener('repair', (e) => {
        let data: RepairProgress
        try { data = JSON.parse(e.data) as RepairProgress } catch { return } // skip malformed frame
        setPhase((p) => p === 'booting' ? 'repairing' : p)
        setRepairs((prev) => new Map([...prev, [data.key, data]]))
        // Synthesize a step row so the step label is visible during repair
        setSteps((prev) => {
          if (prev.some((s) => s.key === data.key)) return prev
          const label = runningLabels.current.get(data.key) ?? '…'
          return [...prev, { key: data.key, label, status: 'running' }]
        })
        // Update the bottom label with ETA or "Loading…" when download finishes
        if (data.total > 0) {
          if (data.etaSeconds > 0) {
            setLabel(`${fmtEta(data.etaSeconds)} remaining`)
          } else if (data.completed >= data.total) {
            setLabel('Loading…')
          }
        }
      })

      es.addEventListener('done', () => {
        es.close()
        setProgress(100)
        setRepairs(new Map())
        setSteps((prev) => {
          const hasIssues = prev.some((s) => s.status === 'warn' || s.status === 'error')
          setLabel(hasIssues ? 'Started with warnings' : 'Ready')
          setPhase(hasIssues ? 'paused' : 'done')
          return prev
        })
      })

      es.onerror = () => {
        es.close()
        if (!dead) {
          retryTimer = setTimeout(connect, 2000)
        }
      }
    }

    connect()

    return () => {
      dead = true
      es?.close()
      if (retryTimer) clearTimeout(retryTimer)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phase !== 'done') return
    const t = setTimeout(() => {
      setFadeOut(true)
      setTimeout(() => onCompleteRef.current(), 450)
    }, 600)
    return () => clearTimeout(t)
  }, [phase])

  function proceed() {
    setPhase('done')
  }

  const warnings    = steps.filter((s) => s.status === 'warn' || s.status === 'error')
  const isRepairing = phase === 'repairing'
  const isDone      = phase === 'paused' || phase === 'done'

  // Active repair, there's at most one download running at a time
  const activeRepair = [...repairs.values()].find((r) => r.total > 0)
  const repairPct    = activeRepair ? Math.round((activeRepair.completed / activeRepair.total) * 100) : 0

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex flex-col items-center justify-center bg-background',
        'transition-opacity duration-450',
        fadeOut && 'opacity-0 pointer-events-none',
      )}
    >
      {/* Ambient glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-2/5 -translate-x-1/2 -translate-y-1/2 size-[600px] rounded-full bg-brand/10 blur-[140px]" />
      </div>

      <div className="relative z-10 flex w-full max-w-[320px] flex-col items-center">

        {/* Logo */}
        <div className="mb-10 flex flex-col items-center">
          <BrandMark glow className="size-[72px]" />
          <h1 className="mt-3 text-2xl font-bold tracking-tight">MaiPai Home</h1>
          <p className="mt-1 text-xs text-muted-foreground">Your private AI home hub</p>
        </div>

        {/* Repair mode badge */}
        {isRepairing && (
          <div className="mb-4 flex items-center gap-1.5 rounded-full border border-brand/20 bg-brand/10 px-3 py-1 animate-in fade-in duration-300">
            {/* design-ok(adhoc-pulse): repair-in-progress icon, same intent as StatusDot's pulse-for-active-state */}
            <Wrench className="size-3 text-brand animate-pulse" />
            <span className="text-[11px] font-medium text-brand">Repairing</span>
          </div>
        )}

        {/* Step log, hidden by default, shown when user expands details */}
        {steps.length > 0 && showDetails && (
          <div className="mb-4 w-full space-y-2 animate-in fade-in duration-200">
            {steps.map((s) => (
              <div key={s.key} className="flex items-center gap-2">
                <StepIcon status={s.status} />
                <span className={cn(
                  'text-xs min-w-0',
                  s.status === 'ok'    && 'text-foreground/60',
                  s.status === 'warn'  && 'text-warning/80',
                  s.status === 'error' && 'text-destructive/80',
                )}>
                  {s.label}
                </span>
                {s.detail && (
                  <span className="ml-auto text-[10px] text-muted-foreground/40 truncate max-w-[110px]">
                    {s.detail}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Main progress bar + label */}
        <div className="w-full">
          <div className="relative h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out',
                isDone && warnings.length === 0 ? 'bg-success' :
                isDone && warnings.length > 0  ? 'bg-warning' :
                isRepairing ? 'bg-brand' :
                'bg-gradient-to-r from-brand to-brand-hover',
              )}
              style={{ width: `${progress}%` }}
            />
            {!isDone && progress > 0 && (
              <div
                className="absolute inset-y-0 rounded-full animate-dl-shimmer"
                style={{
                  width: '60px',
                  left: 0,
                  background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)',
                }}
              />
            )}
          </div>

          <div className="mt-2.5 flex items-center justify-center gap-3">
            <p className={cn(
              'text-center text-xs transition-colors duration-300',
              isDone && warnings.length === 0 && 'text-success',
              isDone && warnings.length > 0  && 'text-warning',
              isRepairing && 'text-brand',
              !isDone && !isRepairing && 'text-muted-foreground/60',
            )}>
              {isRepairing && activeRepair
                ? `Setting up ${BOOT_STEP_FEATURE_NAME[activeRepair.key] ?? 'features'}…`
                : currentLabel}
            </p>
            {steps.length > 0 && (
              <button
                type="button"
                onClick={() => setShowDetails(v => !v)}
                className="flex items-center gap-0.5 text-[10px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
              >
                {showDetails ? 'Hide' : 'Details'}
                <ChevronDown className={cn('size-2.5 transition-transform', showDetails && 'rotate-180')} />
              </button>
            )}
          </div>
        </div>

        {/* Repair download details, always below the progress bar */}
        {activeRepair && (
          <div className="mt-4 w-full space-y-1.5 animate-in fade-in duration-200">
            <div className="h-0.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-brand/70 transition-[width] duration-300"
                style={{ width: `${repairPct}%` }}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-brand/70 tabular-nums">
                {fmtBytes(activeRepair.completed)} / {fmtBytes(activeRepair.total)}
              </span>
              <span className="text-[10px] text-brand/50 tabular-nums">
                {fmtSpeed(activeRepair.speedBps)}
                {activeRepair.etaSeconds > 0 ? ` · ${fmtEta(activeRepair.etaSeconds)}` : ''}
              </span>
            </div>
          </div>
        )}

        {/* Warning acknowledgment */}
        {phase === 'paused' && (
          <div className="mt-8 w-full animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="rounded-card border border-warning/20 bg-warning/5 px-4 py-3 space-y-2 mb-4">
              <p className="text-xs font-semibold text-warning flex items-center gap-1.5">
                <AlertTriangle className="size-3.5 shrink-0" />
                {warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`}, some features may be unavailable
              </p>
              {warnings.some((w) => w.detail) && (
                <ul className="space-y-1">
                  {warnings.filter((w) => w.detail).map((w) => (
                    <li key={w.key} className="text-xs text-muted-foreground leading-relaxed">
                      <span className={cn(w.status === 'error' ? 'text-destructive' : 'text-warning/80')}>
                        {w.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Button
              type="button"
              onClick={proceed}
              className="w-full"
            >
              Continue anyway <ChevronRight className="size-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'running': return <Spinner size="sm" className="size-3 shrink-0 text-muted-foreground/50" />
    case 'ok':      return <CheckCircle2 className="size-3 shrink-0 text-success/70" />
    case 'warn':    return <AlertTriangle className="size-3 shrink-0 text-warning/70" />
    case 'error':   return <XCircle className="size-3 shrink-0 text-destructive/70" />
  }
}
