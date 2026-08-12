import { useEffect, useState } from 'react'
import { Cpu, RefreshCw, Trash2, Zap, AlertTriangle, Activity, HardDrive, CheckCircle2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useGpuHealth, type LoadedLlmModel } from '@/context/GpuHealthContext'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'

// Admin → System → AI Engine: live census of the local Ollama engines (which models are
// loaded, how much of each is actually in VRAM vs CPU-offloaded), one-click corrections
// (unload / free VRAM / sweep orphans / restart), and the engine guards. Status rides the
// existing 20 s GpuHealth poll - no second poller.

interface EngineGuards {
  maxLoadedModels: number
  numParallel: number
  flashAttention: boolean
  kvCacheType: 'q8_0' | 'f16'
  codingCtx: number
}

const CTX_CHOICES = [16384, 24576, 32768, 49152, 65536]
const fmtGb = (b: number) => `${(b / 1e9).toFixed(1)} GB`

interface ResourceHealth {
  mode: 'automatic' | 'manual'
  sharedGpu: boolean
  chatModel: { name: string; offloadPct: number | null; onGpuPct: number | null; sizeBytes: number }
  gpus: { index: number; name: string; usedMb: number | null; totalMb: number | null; utilPct: number | null }[]
  web: { count: number; p50: number; p95: number; p99: number; max: number }
  events: { kind: 'evict' | 'rewarm' | 'remediate'; message: string; at: number }[]
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

interface AutotuneInfo {
  fit: { vramBytes: number; hasGpu: boolean; recommendedModel: string; recommendedNumCtx: number; reason: string }
  auto: boolean
  pinnedModel: string | null
  effectiveModel: string
  pinnedFit: { fits: boolean; willSpill: boolean; sizeBytes: number } | null
  sharedGpu: boolean
}

function post(path: string, body?: unknown) {
  return fetch(`/api/admin/gpu${path}`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function ModelRow({ m, onUnload }: { m: LoadedLlmModel; onUnload: (m: LoadedLlmModel) => void }) {
  const onGpu = 100 - m.offloadPct
  // Planned CPU residency (the placement engine parked this model there on purpose,
  // e.g. the embedder yielding VRAM to the chat model) is informational, never a warning.
  const alarming = m.offloadPct >= 25 && !m.plannedCpu
  return (
    <div className="space-y-1 py-1.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{m.name}</span>
        {m.plannedCpu && (
          <Badge variant="outline" className="shrink-0 text-[10px]" title="Placed on the CPU by the resource manager to keep VRAM free for the chat model. Embeddings run fine there.">
            CPU by design
          </Badge>
        )}
        <Badge variant={m.engine === 'coding' ? 'info' : 'secondary'} className="shrink-0 text-[10px]">{m.engine}</Badge>
        <span className="shrink-0 tabular-nums text-muted-foreground">{fmtGb(m.sizeBytes)}</span>
        {m.contextLength != null && <span className="shrink-0 tabular-nums text-muted-foreground">ctx {(m.contextLength / 1024).toFixed(0)}k</span>}
        <Button variant="ghost" size="icon-sm" title="Unload now" onClick={() => onUnload(m)}>
          <Trash2 className="size-3.5 text-muted-foreground" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className={cn('h-full rounded-full', alarming ? 'bg-warning' : 'bg-success')}
            style={{ width: `${onGpu}%` }}
          />
        </div>
        <span className={cn('w-24 shrink-0 text-right text-[11px] tabular-nums', alarming ? 'text-warning' : 'text-muted-foreground')}>
          {m.plannedCpu ? 'on CPU' : `${onGpu}% on GPU`}
        </span>
      </div>
    </div>
  )
}

export function AdminAiEngineTab() {
  const { health, config, saveConfig, refresh } = useGpuHealth()
  const [guards, setGuards] = useState<EngineGuards | null>(null)
  const [dirty, setDirty] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [autotune, setAutotune] = useState<AutotuneInfo | null>(null)
  const [mode, setMode] = useState<'automatic' | 'manual' | null>(null)
  const [apiLat, setApiLat] = useState<{ count: number; p50: number; p95: number; p99: number; max: number } | null>(null)
  const [resHealth, setResHealth] = useState<ResourceHealth | null>(null)

  const loadAutotune = () => {
    fetch('/api/admin/gpu/engine-autotune', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((a) => { if (a) setAutotune(a as AutotuneInfo) })
      .catch(() => {})
  }

  const setResourceMode = async (next: 'automatic' | 'manual') => {
    setMode(next)
    setBusy('/resource-mode')
    try {
      const r = await fetch('/api/admin/gpu/resource-mode', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      })
      if (!r.ok) throw new Error(`${r.status}`)
      toast.success(next === 'automatic'
        ? 'Automatic: resources are managed for best performance. Restart the engine to apply now.'
        : 'Manual: your pinned model and device settings now take effect.')
      loadAutotune(); refresh()
    } catch (e) { toast.error(`Failed: ${e instanceof Error ? e.message : e}`) }
    setBusy(null)
  }

  useEffect(() => {
    fetch('/api/admin/gpu/engine-guards', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((g) => { if (g) setGuards(g as EngineGuards) })
      .catch(() => {})
    fetch('/api/admin/gpu/resource-mode', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (m) setMode(m.mode as 'automatic' | 'manual') })
      .catch(() => {})
    fetch('/api/admin/gpu/api-latency', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((l) => { if (l) setApiLat(l) })
      .catch(() => {})
    loadAutotune()
  }, [])

  // Resource health poll (live glance for validating automatic mode).
  useEffect(() => {
    let alive = true
    const load = () => fetch('/api/admin/gpu/resource-health', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => { if (alive && h) setResHealth(h as ResourceHealth) })
      .catch(() => {})
    void load()
    const t = setInterval(load, 10_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const switchToAuto = async () => {
    setBusy('/engine-autotune/apply')
    try {
      const r = await post('/engine-autotune/apply')
      if (!r.ok) throw new Error(`${r.status}`)
      toast.success('Engine is now auto-managed. Restart the engine to apply immediately.')
      loadAutotune(); refresh()
    } catch (e) { toast.error(`Failed: ${e instanceof Error ? e.message : e}`) }
    setBusy(null)
  }

  const llm = health?.llm

  const patchGuards = async (patch: Partial<EngineGuards>) => {
    if (!guards) return
    const next = { ...guards, ...patch }
    setGuards(next)
    try {
      const r = await fetch('/api/admin/gpu/engine-guards', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!r.ok) throw new Error(`${r.status}`)
      setDirty(true)
    } catch { toast.error('Could not save engine guards') }
  }

  const action = async (label: string, path: string, body?: unknown) => {
    setBusy(path)
    try {
      const r = await post(path, body)
      if (!r.ok) throw new Error(`${r.status}`)
      toast.success(label)
      refresh()
    } catch (e) { toast.error(`Failed: ${e instanceof Error ? e.message : e}`) }
    setBusy(null)
  }

  const unload = (m: LoadedLlmModel) =>
    void action(`Unloaded ${m.name}`, '/unload', { model: m.name, engine: m.engine })

  const onGpu = resHealth?.chatModel.onGpuPct
  const gpuHealthy = onGpu == null || onGpu >= 95
  const webHealthy = !resHealth?.web.count || resHealth.web.p95 <= 750

  return (
    <div className="space-y-3 p-3">
      {/* Resource health: the one-screen "is automatic working?" glance. */}
      {resHealth && (
        <Card variant="surface" className="border-border/50 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Activity className="size-3" /> Resource health
            </h3>
            <Badge variant={resHealth.mode === 'automatic' ? 'info' : 'secondary'} className="text-[10px]">{resHealth.mode}</Badge>
          </div>

          {/* Two headline health checks: chat model on GPU, and web responsiveness. */}
          <div className="grid grid-cols-2 gap-2">
            <div className={cn('rounded-card border p-2.5', gpuHealthy ? 'border-success/40 bg-success/[0.06]' : 'border-warning/40 bg-warning/[0.06]')}>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {gpuHealthy ? <CheckCircle2 className="size-3.5 text-success" /> : <AlertTriangle className="size-3.5 text-warning" />}
                Chat model on GPU
              </div>
              <p className="mt-0.5 text-lg font-bold tabular-nums">
                {onGpu == null ? 'n/a' : `${onGpu}%`}
                <span className="ml-1.5 text-xs font-normal text-muted-foreground truncate">{resHealth.chatModel.name}</span>
              </p>
            </div>
            <div className={cn('rounded-card border p-2.5', webHealthy ? 'border-success/40 bg-success/[0.06]' : 'border-warning/40 bg-warning/[0.06]')}>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {webHealthy ? <CheckCircle2 className="size-3.5 text-success" /> : <AlertTriangle className="size-3.5 text-warning" />}
                Web responsiveness (p95)
              </div>
              <p className="mt-0.5 text-lg font-bold tabular-nums">
                {resHealth.web.count ? `${resHealth.web.p95} ms` : 'n/a'}
                {resHealth.web.count ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">median {resHealth.web.p50} ms</span> : null}
              </p>
            </div>
          </div>

          {/* Per-GPU VRAM. */}
          {resHealth.gpus.map((g) => {
            const pct = g.usedMb != null && g.totalMb ? Math.round((g.usedMb / g.totalMb) * 100) : null
            return (
              <div key={g.index} className="space-y-1">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <HardDrive className="size-3" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{g.name}</span>
                  {pct != null && <span className="tabular-nums">{Math.round((g.usedMb ?? 0) / 1024 * 10) / 10}/{Math.round((g.totalMb ?? 0) / 1024 * 10) / 10} GB</span>}
                  {g.utilPct != null && <span className="tabular-nums">{g.utilPct}% util</span>}
                </div>
                {pct != null && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                    <div className={cn('h-full rounded-full', pct >= 92 ? 'bg-warning' : 'bg-brand')} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            )
          })}

          {/* Recent automatic actions, so eviction/re-warm is visible when it happens. */}
          {resHealth.events.length > 0 && (
            <div className="space-y-1 border-t border-border/50 pt-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recent actions</p>
              {resHealth.events.slice(0, 4).map((e, i) => (
                <p key={i} className="text-[11px] text-muted-foreground">
                  <span className="text-muted-foreground/60">{ago(e.at)}</span> · {e.message}
                </p>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* THE one switch: automatic owns all placement, manual exposes the knobs. */}
      {mode && (
        <Card variant="surface" className="border-border/50 p-3 space-y-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Zap className="size-3" /> Resource management
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {(['automatic', 'manual'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => void setResourceMode(m)}
                disabled={busy === '/resource-mode'}
                className={cn(
                  'rounded-card border p-2.5 text-left transition-all disabled:opacity-60',
                  mode === m ? 'border-brand/60 bg-brand/[0.07]' : 'border-border hover:border-foreground/20',
                )}
              >
                <span className="block text-sm font-semibold capitalize">{m}</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {m === 'automatic'
                    ? 'The system fits the model, voice, and image work to your hardware (GPU/CPU) for best performance.'
                    : 'You pin the model and devices yourself; automatic fitting is off.'}
                </span>
              </button>
            ))}
          </div>
          {mode === 'automatic' && (
            <p className="text-[11px] text-muted-foreground">
              Model, context size, voice backend, and image device are all chosen automatically and rebalanced as your hardware changes. Any manual pins are ignored while this is on.
            </p>
          )}
          {apiLat && apiLat.count > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
              <span className="font-medium uppercase tracking-wide">Web responsiveness</span>
              <span>median <span className="font-medium text-foreground tabular-nums">{apiLat.p50} ms</span></span>
              <span className={cn(apiLat.p95 > 750 ? 'text-warning' : '')}>p95 <span className={cn('font-medium tabular-nums', apiLat.p95 > 750 ? 'text-warning' : 'text-foreground')}>{apiLat.p95} ms</span></span>
              <span className="text-muted-foreground/70">({apiLat.count} recent requests)</span>
            </div>
          )}
        </Card>
      )}

      {/* Auto-managed engine: VRAM-fit model + context, with a spill warning. */}
      {autotune && (
        <Card variant="surface" className="border-border/50 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Zap className="size-3" /> Auto-managed engine
            </h3>
            <Badge variant={autotune.auto ? 'info' : 'secondary'} className="text-[10px]">
              {autotune.auto ? 'Auto' : 'Pinned'}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {autotune.fit.hasGpu
              ? <span>GPU VRAM: <span className="font-medium text-foreground">{fmtGb(autotune.fit.vramBytes)}</span></span>
              : <span className="font-medium text-foreground">No NVIDIA GPU detected (running on CPU)</span>}
            <span>Model: <span className="font-medium text-foreground">{autotune.effectiveModel}</span></span>
            <span>Context: <span className="font-medium text-foreground">{(autotune.fit.recommendedNumCtx / 1024).toFixed(0)}k</span></span>
          </div>
          {/* Prefer live reality over the boot-time estimate: if the model is actually
              resident on the GPU, say so instead of a pessimistic "may spill" prediction
              (the estimate over-counts overhead and can't see multi-GPU placement). */}
          {onGpu != null && onGpu >= 95
            ? <p className="text-xs text-muted-foreground">Fitting well: {resHealth?.chatModel.name ?? autotune.effectiveModel} is running fully on the GPU ({onGpu}%).</p>
            : <p className="text-xs text-muted-foreground">{autotune.fit.reason}</p>}
          {autotune.pinnedFit?.willSpill ? (
            <div className="flex flex-wrap items-center gap-2 rounded-card border border-warning/40 bg-warning/[0.06] px-3 py-2">
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              <p className="min-w-0 flex-1 text-xs text-foreground">
                <span className="font-semibold">{autotune.pinnedModel}</span> ({fmtGb(autotune.pinnedFit.sizeBytes)}) is larger than this GPU can hold with the router, so it runs partly on CPU and generates slowly. Switch to auto-managed to use <span className="font-semibold">{autotune.fit.recommendedModel}</span>.
              </p>
              <Button size="sm" onClick={() => void switchToAuto()} disabled={busy === '/engine-autotune/apply'}>
                Switch to auto-managed
              </Button>
            </div>
          ) : autotune.auto ? (
            <p className="text-[11px] text-muted-foreground">
              Managed for best performance: the model and context are fitted to your hardware automatically.
              {autotune.sharedGpu && ' Image and video generation briefly pause the chat model to free VRAM, so nothing oversubscribes the GPU (it reloads on your next message).'}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-[11px] text-muted-foreground">A model is pinned. It fits, but auto-management adapts if your hardware changes.</p>
              <Button variant="outline" size="sm" onClick={() => void switchToAuto()} disabled={busy === '/engine-autotune/apply'}>
                Auto-manage
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* Loaded models */}
      <Card variant="surface" className="border-border/50 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Cpu className="size-3" /> Loaded models
          </h3>
          <div className="flex items-center gap-1.5">
            <Badge variant={llm?.engines.main ? 'secondary' : 'destructive'} className="text-[10px]">
              main {llm?.engines.main ? 'up' : 'down'}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              coding {llm?.engines.coding ? 'up' : 'idle'}
            </Badge>
          </div>
        </div>

        {llm && llm.models.length > 0 ? (
          <div className="divide-y divide-border/40">
            {llm.models.map((m) => <ModelRow key={`${m.engine}:${m.name}`} m={m} onUnload={unload} />)}
          </div>
        ) : (
          <p className="py-2 text-xs text-muted-foreground">No models loaded right now - they load on demand.</p>
        )}

        {llm && llm.orphanSweep.pids.length > 0 && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <AlertTriangle className="size-3 text-warning" />
            Last sweep reclaimed {llm.orphanSweep.pids.length} orphaned runner{llm.orphanSweep.pids.length === 1 ? '' : 's'} ({new Date(llm.orphanSweep.at).toLocaleTimeString()})
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-2">
          <Button variant="outline" size="sm" disabled={busy !== null}
            onClick={() => void action('Freed VRAM - models reload on demand', '/free-vram')}>
            <Zap className="mr-1.5 size-3.5" />Free VRAM
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null}
            onClick={() => void action('Swept orphaned runners', '/sweep-orphans')}>
            <Trash2 className="mr-1.5 size-3.5" />Sweep orphans
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setConfirmRestart(true)}>
            <RefreshCw className="mr-1.5 size-3.5" />Restart engine
          </Button>
        </div>
      </Card>

      {/* Engine guards */}
      {guards && (
        <Card variant="surface" className="border-border/50 p-3 space-y-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Engine guards</h3>

          <GuardStepper label="Max loaded models" hint="Runners kept resident before evicting; keep at or below what your VRAM actually fits."
            value={guards.maxLoadedModels} min={1} max={8} onChange={(v) => void patchGuards({ maxLoadedModels: v })} />
          <GuardStepper label="Parallel requests per model" hint="Each slot multiplies a model's memory for context; 1 is right for a household."
            value={guards.numParallel} min={1} max={4} onChange={(v) => void patchGuards({ numParallel: v })} />

          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs text-foreground">Flash attention + compact KV cache</p>
              <p className="text-[11px] text-muted-foreground">Roughly halves per-model context memory. Applies to every model (not per-model) - turn off if any model misbehaves.</p>
            </div>
            <Switch checked={guards.flashAttention && guards.kvCacheType === 'q8_0'}
              onCheckedChange={(v) => void patchGuards(v ? { flashAttention: true, kvCacheType: 'q8_0' } : { flashAttention: false, kvCacheType: 'f16' })} />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs text-foreground">Coding context window</p>
              <p className="text-[11px] text-muted-foreground">Context for the dedicated coding engine. Too small truncates Claude Code's instructions (it derails); larger uses more VRAM.</p>
            </div>
            <select
              className="h-7 shrink-0 rounded-control border border-input bg-background px-2 text-xs"
              value={guards.codingCtx}
              onChange={(e) => void patchGuards({ codingCtx: Number(e.target.value) })}>
              {CTX_CHOICES.map((c) => <option key={c} value={c}>{c / 1024}k</option>)}
            </select>
          </div>

          {config && (
            <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-2">
              <div className="min-w-0">
                <p className="text-xs text-foreground">Alert when a model runs on the CPU</p>
                <p className="text-[11px] text-muted-foreground">CPU offload makes replies take minutes with no other signal.</p>
              </div>
              <Switch checked={config.offload.enabled} onCheckedChange={(v) => void saveConfig({ offload: { enabled: v } })} />
            </div>
          )}

          {dirty && (
            <div className="flex items-center justify-between gap-2 rounded-control border border-warning/30 bg-warning/10 px-3 py-2">
              <p className="text-xs text-warning">Saved - restart the engine to apply.</p>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirmRestart(true)}>
                <RefreshCw className="mr-1.5 size-3.5" />Apply & restart
              </Button>
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title="Restart the AI engine?"
        description="In-flight AI replies will be dropped and models reload on demand. Takes a few seconds; chat pays a short warm-up on its next message."
        confirmLabel="Restart"
        destructive
        onConfirm={() => { setConfirmRestart(false); setDirty(false); void action('Engine restarted', '/restart-engine') }}
      />
    </div>
  )
}

function GuardStepper({ label, hint, value, min, max, onChange }: {
  label: string; hint: string; value: number; min: number; max: number; onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="outline" size="icon-sm" disabled={value <= min} onClick={() => onChange(value - 1)}>−</Button>
        <span className="w-6 text-center text-xs tabular-nums">{value}</span>
        <Button variant="outline" size="icon-sm" disabled={value >= max} onClick={() => onChange(value + 1)}>+</Button>
      </div>
    </div>
  )
}
