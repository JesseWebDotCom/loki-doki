import { useEffect, useRef, useState } from 'react'
import { Loader2, CheckCircle2, AlertTriangle, Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'

// Staged, friendly progress for wake-word training. Mirrors the Add-a-device
// wizard (FlashDeviceWizard): a calm done/active/pending checklist, plain-English
// status sentences translated from the raw training log, a thin progress bar, and
// a collapsed "Show details" technical log — so training a companion's wake word
// feels as polished as flashing a device instead of a wall of mono-font log lines.
//
// Self-contained: it opens the /api/admin/wakewords/train SSE stream on mount and
// reports back via onComplete/onDismiss. Mounted from the companion editor on Save.

type Stage = 'generate' | 'analyze' | 'train' | 'finalize'

const STAGES: { id: Stage; label: string }[] = [
  { id: 'generate', label: 'Creating voice samples' },
  { id: 'analyze', label: 'Analyzing the sound' },
  { id: 'train', label: 'Training the detector' },
  { id: 'finalize', label: 'Finishing up' },
]
const ORDER = STAGES.map((s) => s.id)
// Bar fill per stage — derived from the stage (monotonic, meaningful) rather than
// the backend's coarse byte/length-based pct, which jumps around.
const STAGE_PCT: Record<Stage, number> = { generate: 25, analyze: 55, train: 85, finalize: 100 }

// Best-effort, forward-only mapping of a backend (step, msg) to its stage.
function stageFor(step: string, msg: string): Stage | null {
  if (step === 'generating') return 'generate'
  const m = msg.toLowerCase()
  if (/exporting|^done|done\.|calibrat/.test(m)) return 'finalize'
  if (/training on|validation accuracy|training accuracy|threshold/.test(m)) return 'train'
  if (/embedding server|onnx backbone|loading onnx|processing|reverb|mel produces|feature bank|near-miss|augment/.test(m)) return 'analyze'
  if (step === 'training') return 'analyze'
  return null
}

const FRIENDLY: Record<Stage, string> = {
  generate: 'Creating voice samples of your phrase…',
  analyze: 'Listening to the samples…',
  train: 'Teaching the detector your phrase…',
  finalize: 'Finishing up…',
}

function friendlyError(e: string): string {
  if (/training.*not installed|wake word training/i.test(e)) return 'Wake Word Training isn’t installed yet — add it in Admin → Features, then try again.'
  if (/core models/i.test(e)) return 'The wake-word core models aren’t installed yet. Install “Wake Word” in Admin → Features.'
  return 'Something went wrong while training. You can try again.'
}

interface Props {
  phrase: string
  characterId?: string
  /** 'auto' (default) trains across the full diverse voice set — the reliable, speaker-independent choice. */
  trainingVoice?: string
  onComplete?: (modelId: string) => void
  onDismiss?: () => void
}

export function WakeTrainingProgress({ phrase, characterId, trainingVoice = 'auto', onComplete, onDismiss }: Props) {
  const [stage, setStage] = useState<Stage>('generate')
  const [status, setStatus] = useState('Getting ready…')
  const [log, setLog] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [summary, setSummary] = useState<string | null>(null) // parsed "~X false alarms/hour"
  const [retry, setRetry] = useState(0)

  const logRef = useRef<HTMLDivElement | null>(null)
  // Keep the latest onComplete without making it an effect dependency (a parent
  // callback that changes identity each render would otherwise restart training).
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  // Run training once per mount (and once per Try-again). The effect owns the
  // AbortController so a real unmount cancels the stream; props are stable for a
  // given training request (the parent keys this component by request).
  useEffect(() => {
    const ctrl = new AbortController()
    setError(''); setDone(false); setLog([]); setStage('generate'); setStatus('Getting ready…'); setSummary(null)
    let cancelled = false

    const advance = (s: Stage) => setStage((cur) => (ORDER.indexOf(s) > ORDER.indexOf(cur) ? s : cur))

    ;(async () => {
      let completedId = ''
      try {
        const res = await fetch('/api/admin/wakewords/train', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phrase, label: phrase, characterId, trainingVoice }),
          signal: ctrl.signal,
        })
        if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`)
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        let event = ''
        for (;;) {
          const { done: rdone, value } = await reader.read()
          if (rdone) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (line.startsWith('event:')) { event = line.slice(6).trim(); continue }
            if (!line.startsWith('data:')) continue
            const raw = line.slice(5).trim()
            if (!raw) continue
            let d: { status?: string; msg?: string; pct?: number; modelId?: string; error?: string }
            try { d = JSON.parse(raw) } catch { continue }
            if (event === 'progress') {
              const msg = typeof d.msg === 'string' ? d.msg : ''
              if (msg) {
                setLog((l) => [...l.slice(-200), msg])
                const st = stageFor(d.status ?? '', msg)
                if (st) { advance(st); setStatus(FRIENDLY[st]) }
                const fa = msg.match(/~\s*([\d.]+)\s*false-accepts\/hr/i)
                if (fa) setSummary(`~${fa[1]} false alarms/hour`)
              }
            } else if (event === 'complete') {
              if (typeof d.modelId === 'string') completedId = d.modelId
            } else if (event === 'error') {
              throw new Error(typeof d.error === 'string' ? d.error : 'Training failed')
            }
          }
        }
        if (!completedId) throw new Error('Training ended unexpectedly')
        if (cancelled) return
        setStage('finalize'); setDone(true); setStatus('Ready')
        onCompleteRef.current?.(completedId)
      } catch (e) {
        if (cancelled || (e as Error).name === 'AbortError') return
        setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => { cancelled = true; ctrl.abort() }
  }, [phrase, characterId, trainingVoice, retry])

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [log])

  return (
    <div className="space-y-3 rounded-xl border border-border bg-background/50 p-3">
      {!error && !done && (
        <>
          <div>
            <p className="text-sm font-semibold">Teaching “{phrase}”…</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{status}</p>
          </div>
          <StageList stage={stage} />
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all duration-700 ease-out" style={{ width: `${STAGE_PCT[stage]}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground">This runs in the background — you can keep editing.</p>
        </>
      )}

      {done && (
        <div className="flex flex-col items-center gap-2 py-1 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-emerald-500/10 text-emerald-500"><CheckCircle2 className="size-6" /></span>
          <div>
            <p className="text-sm font-semibold">Wake word ready <Sparkles className="inline size-3.5 text-amber-400" /></p>
            <p className="mt-0.5 text-xs text-muted-foreground">Your device now answers to “{phrase}”{summary ? ` · ${summary}` : ''}.</p>
          </div>
          <button type="button" onClick={onDismiss} className="rounded-lg border border-border px-3 py-1 text-xs hover:bg-foreground/5">Done</button>
        </div>
      )}

      {error && (
        <div className="flex flex-col items-center gap-2 py-1 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive"><AlertTriangle className="size-5" /></span>
          <div>
            <p className="text-sm font-semibold">Training didn’t finish</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{friendlyError(error)}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setRetry((r) => r + 1)} className="rounded-lg border border-violet-500/50 bg-violet-500/10 px-3 py-1 text-xs text-violet-300 hover:bg-violet-500/20">Try again</button>
            <button type="button" onClick={onDismiss} className="rounded-lg border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-foreground/5">Dismiss</button>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <div className="min-w-0">
          <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'Hide details' : 'Show details'}
          </button>
          {showLog && (
            <div ref={logRef} className="mt-1 max-h-28 overflow-auto rounded-lg bg-black/90 p-2 font-mono text-[10px] leading-relaxed text-emerald-200/90">
              {log.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all">{l}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// done / in-progress / pending checklist — the calm alternative to a scrolling log.
function StageList({ stage }: { stage: Stage }) {
  const active = ORDER.indexOf(stage)
  return (
    <div className="space-y-1">
      {STAGES.map((s, i) => {
        const state = i < active ? 'done' : i === active ? 'active' : 'pending'
        return (
          <div key={s.id} className={cn('flex items-center gap-2.5 rounded-lg px-2 py-1.5', state === 'active' && 'bg-primary/5')}>
            <span className="grid size-4 shrink-0 place-items-center">
              {state === 'done' ? <CheckCircle2 className="size-4 text-emerald-500" />
                : state === 'active' ? <Loader2 className="size-3.5 animate-spin text-primary" />
                : <span className="size-1.5 rounded-full bg-muted-foreground/30" />}
            </span>
            <span className={cn('text-xs', state === 'pending' ? 'text-muted-foreground/60' : state === 'active' ? 'font-medium text-foreground' : 'text-foreground')}>
              {s.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
