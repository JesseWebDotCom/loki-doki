import { useState } from 'react'
import { AlertTriangle, Trash2, CheckCircle2, XCircle, AlertCircle, Power } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { formatFeatureBytes } from '@/lib/features'

// ── Types mirrored from the backend preview/stream ──────────────────────────────

interface UninstallTargets {
  dataDir: string
  dataEntries: { name: string; sizeBytes: number }[]
  dataTotalBytes: number
  ollamaModels: { name: string; sizeBytes: number }[]
  systemOllamaPaths: { path: string; exists: boolean }[]
}

type StepStatus = 'running' | 'ok' | 'warn' | 'error'
interface StepState {
  key: string
  label: string
  status: StepStatus
  detail?: string
  completed?: number
  total?: number
  progressLabel?: string
}

type Phase = 'idle' | 'confirm' | 'running' | 'done' | 'error'

const CONFIRM_PHRASE = 'UNINSTALL'

// Wipe everything this app stored in the browser once the server says it's done.
async function clearBrowserStorage(): Promise<void> {
  try { localStorage.clear() } catch { /* unavailable */ }
  try { sessionStorage.clear() } catch { /* unavailable */ }
  try {
    for (const c of document.cookie.split(';')) {
      const name = c.split('=')[0]?.trim()
      if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`
    }
  } catch { /* unavailable */ }
  try {
    const dbs = (await indexedDB.databases?.()) ?? []
    await Promise.all(dbs.map((d) => d.name && new Promise<void>((res) => {
      const req = indexedDB.deleteDatabase(d.name!)
      req.onsuccess = req.onerror = req.onblocked = () => res()
    })))
  } catch { /* unavailable */ }
}

// ── Step row ────────────────────────────────────────────────────────────────────

function StepRow({ step }: { step: StepState }) {
  const Icon = step.status === 'ok' ? CheckCircle2
    : step.status === 'error' ? XCircle
    : AlertCircle
  const color = step.status === 'ok' ? 'text-success'
    : step.status === 'error' ? 'text-destructive'
    : 'text-warning'
  const pct = step.total ? Math.min(100, Math.round(((step.completed ?? 0) / step.total) * 100)) : 0

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2.5 text-sm">
        {step.status === 'running'
          ? <Spinner className="size-4 shrink-0 text-brand" />
          : <Icon className={`size-4 shrink-0 ${color}`} />}
        <span className="font-medium">{step.label}</span>
      </div>
      {step.status === 'running' && step.total ? (
        <div className="ml-[26px] space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
          </div>
          {step.progressLabel && (
            <p className="truncate text-[11px] text-muted-foreground tabular-nums">
              {step.completed}/{step.total} · {step.progressLabel}
            </p>
          )}
        </div>
      ) : step.detail ? (
        <p className="ml-[26px] text-[11px] text-muted-foreground">{step.detail}</p>
      ) : null}
    </div>
  )
}

// ── Main panel ───────────────────────────────────────────────────────────────────

export function UninstallPanel() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [preview, setPreview] = useState<UninstallTargets | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [steps, setSteps] = useState<StepState[]>([])
  const [error, setError] = useState<string | null>(null)

  async function openConfirm() {
    setConfirmText('')
    setPreview(null)
    setLoadingPreview(true)
    setPhase('confirm')
    try {
      const r = await fetch('/api/admin/uninstall/preview', { credentials: 'include' })
      if (r.ok) setPreview(await r.json() as UninstallTargets)
    } catch { /* dialog still works without sizes */ }
    setLoadingPreview(false)
  }

  function upsertStep(next: Partial<StepState> & { key: string }) {
    setSteps((prev) => {
      const i = prev.findIndex((s) => s.key === next.key)
      if (i === -1) return [...prev, { label: '', status: 'running', ...next } as StepState]
      const merged = { ...prev[i], ...next }
      const copy = [...prev]
      copy[i] = merged
      return copy
    })
  }

  async function runUninstall() {
    setPhase('running')
    setSteps([])
    setError(null)
    try {
      const res = await fetch('/api/admin/uninstall', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: CONFIRM_PHRASE }),
      })
      if (!res.ok || !res.body) {
        setError(`Server returned ${res.status}`)
        setPhase('error')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let currentEvent = 'message'
      let sawError = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); continue }
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          let data: Record<string, unknown> = {}
          try { data = JSON.parse(payload) } catch { /* keep empty */ }

          if (currentEvent === 'step') {
            upsertStep({
              key: String(data.key),
              label: String(data.label ?? ''),
              status: (data.status as StepStatus) ?? 'running',
              detail: data.detail as string | undefined,
            })
          } else if (currentEvent === 'progress') {
            upsertStep({
              key: String(data.key),
              completed: Number(data.completed ?? 0),
              total: Number(data.total ?? 0),
              progressLabel: data.label as string | undefined,
            })
          } else if (currentEvent === 'done') {
            await clearBrowserStorage()
            setPhase('done')
          } else if (currentEvent === 'error') {
            sawError = true
            setError(String(data.error ?? 'Unknown error'))
            setPhase('error')
          }
        }
      }
      // Stream ended (server exited): if we never saw an explicit error, the wipe
      // ran to completion (the server exits mid-stream by design).
      if (!sawError) { await clearBrowserStorage(); setPhase('done') }
    } catch {
      // A dropped connection after we've started is expected: the server process
      // exits as the final step, which the wipe is underway/complete by then.
      await clearBrowserStorage()
      setPhase((p) => (p === 'running' ? 'done' : p))
    }
  }

  return (
    <section className="mx-6 mb-8 rounded-card border border-destructive/30 bg-destructive/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="flex-1 space-y-1">
          <h3 className="text-sm font-semibold text-destructive">Danger zone: uninstall MaiPai Home</h3>
          <p className="text-xs text-muted-foreground">
            Permanently delete <strong>everything</strong>: the database and all accounts, every downloaded
            AI model, ComfyUI and its Python environment, maps, offline libraries, voice models, generated
            images, caches and logs, plus the system-wide Ollama install and all of its models. The server
            shuts down when finished. <strong>This cannot be undone.</strong>
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="destructive" size="sm" onClick={openConfirm}>
          <Trash2 className="size-4" />
          Uninstall MaiPai Home…
        </Button>
      </div>

      {/* Confirmation dialog */}
      <Dialog open={phase === 'confirm'} onOpenChange={(o) => { if (!o) setPhase('idle') }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-5" /> This will erase everything
            </DialogTitle>
            <DialogDescription>
              The following will be permanently deleted. There is no recovery.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[40vh] space-y-3 overflow-y-auto rounded-control border border-border/60 bg-muted/30 p-3 text-xs">
            {loadingPreview && <p className="text-muted-foreground">Calculating what will be removed…</p>}
            {preview && (
              <>
                <div>
                  <div className="flex items-center justify-between font-medium">
                    <span>App data, models &amp; caches</span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatFeatureBytes(preview.dataTotalBytes) || '-'}
                    </span>
                  </div>
                  <p className="mt-0.5 break-all text-[11px] text-muted-foreground">{preview.dataDir}</p>
                  {preview.dataEntries.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {preview.dataEntries
                        .slice()
                        .sort((a, b) => b.sizeBytes - a.sizeBytes)
                        .map((e) => (
                          <li key={e.name} className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <span className="truncate">{e.name}</span>
                            <span className="tabular-nums">{formatFeatureBytes(e.sizeBytes)}</span>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>

                <div>
                  <div className="font-medium">
                    Ollama AI models{' '}
                    <span className="text-muted-foreground">({preview.ollamaModels.length})</span>
                  </div>
                  {preview.ollamaModels.length > 0 ? (
                    <ul className="mt-1 space-y-0.5">
                      {preview.ollamaModels.map((m) => (
                        <li key={m.name} className="flex items-center justify-between text-[11px] text-muted-foreground">
                          <span className="truncate">{m.name}</span>
                          <span className="tabular-nums">{formatFeatureBytes(m.sizeBytes)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">None detected.</p>
                  )}
                </div>

                <div>
                  <div className="font-medium">System Ollama install</div>
                  <ul className="mt-1 space-y-0.5">
                    {preview.systemOllamaPaths.filter((p) => p.exists).map((p) => (
                      <li key={p.path} className="break-all text-[11px] text-muted-foreground">{p.path}</li>
                    ))}
                    {preview.systemOllamaPaths.every((p) => !p.exists) && (
                      <li className="text-[11px] text-muted-foreground">None detected.</li>
                    )}
                  </ul>
                </div>

                <p className="text-[11px] text-muted-foreground">
                  Your browser&apos;s saved login and local settings will also be cleared.
                </p>
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">
              Type <span className="font-mono text-destructive">{CONFIRM_PHRASE}</span> to confirm
            </label>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={CONFIRM_PHRASE}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPhase('idle')}>Cancel</Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={confirmText !== CONFIRM_PHRASE}
              onClick={runUninstall}
            >
              <Trash2 className="size-4" />
              Permanently uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Progress / result dialog. Not dismissable: the wipe must not be
          interrupted, and the original overlay only closed via the explicit
          Close button in the error state. */}
      <Dialog open={phase === 'running' || phase === 'done' || phase === 'error'} onOpenChange={() => {}}>
        <DialogContent className="max-w-md space-y-5 [&>button:last-child]:hidden">
          {phase === 'running' && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2.5 text-base">
                  <Spinner className="size-5 text-destructive" />
                  Uninstalling MaiPai Home…
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Do not close this window. The server will shut down automatically when finished.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {steps.map((s) => <StepRow key={s.key} step={s} />)}
              </div>
            </>
          )}

          {phase === 'done' && (
            <DialogHeader className="space-y-3 text-center sm:text-center">
              <Power className="mx-auto size-10 text-success" />
              <DialogTitle className="text-base">MaiPai Home has been uninstalled</DialogTitle>
              <DialogDescription className="text-xs">
                All data, models and the Ollama install have been removed and the server has shut down.
                You can safely close this window.
              </DialogDescription>
            </DialogHeader>
          )}

          {phase === 'error' && (
            <div className="space-y-3">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2.5 text-base">
                  <XCircle className="size-5 text-destructive" />
                  Uninstall failed
                </DialogTitle>
              </DialogHeader>
              <p className="text-xs text-muted-foreground">{error}</p>
              <div className="space-y-3">
                {steps.map((s) => <StepRow key={s.key} step={s} />)}
              </div>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setPhase('idle')}>Close</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
