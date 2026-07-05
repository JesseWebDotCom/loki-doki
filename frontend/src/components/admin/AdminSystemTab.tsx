import { useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, Cpu, MemoryStick, MonitorCog, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { RichOptionSelect } from '@/components/shared/RichOptionSelect'
import { cn } from '@/lib/cn'
import { useGpuHealth, type GpuAlertConfigPatch } from '@/context/GpuHealthContext'

// ── Types ─────────────────────────────────────────────────────────────────────

interface QueueLimits { chat: number; image: number; vision: number }

interface QueueConfig {
  mode: 'manual' | 'suggested' | 'dynamic'
  limits: {
    manual: QueueLimits
    suggested: QueueLimits
    dynamic: QueueLimits
  }
  dynamicConfig: {
    loadHighWatermark: number
    loadLowWatermark: number
    min: QueueLimits
    max: QueueLimits
  }
  snapshot: {
    running: QueueLimits
    queued: QueueLimits
    limits: QueueLimits
    loadAvg: number
    mode: string
  }
}

interface QueueStatus {
  running: QueueLimits
  queued: QueueLimits
  limits: QueueLimits
  loadAvg: number
  mode: string
  system: {
    loadAvg1m: number
    loadAvg5m: number
    loadNorm: number
    totalRamGb: number
    freeRamGb: number
    cpuCount: number
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: 'include', ...options })
    if (!r.ok) return null
    return await r.json() as T
  } catch { return null }
}

function LoadBar({ value, max = 1 }: { value: number; max?: number }) {
  const pct = Math.min(100, Math.round((value / max) * 100))
  const color = pct > 75 ? 'bg-destructive' : pct > 50 ? 'bg-warning' : 'bg-success'
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function SlotCounter({
  label,
  running,
  queued,
  limit,
}: { label: string; running: number; queued: number; limit: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium text-foreground capitalize">{label}</span>
        <span>{running}/{limit} active{queued > 0 ? `, ${queued} queued` : ''}</span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: limit }).map((_, i) => (
          <div
            key={i}
            className={`h-2 flex-1 rounded-full transition-colors ${
              i < running ? 'bg-brand' : 'bg-muted'
            }`}
          />
        ))}
        {queued > 0 && (
          <div className="flex gap-1 pl-1 border-l border-border">
            {Array.from({ length: Math.min(queued, 4) }).map((_, i) => (
              <div key={i} className="h-2 w-2 rounded-full bg-warning" />
            ))}
            {queued > 4 && <span className="text-xs text-muted-foreground">+{queued - 4}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

// ── GPU health + alerts ─────────────────────────────────────────────────────────

function AlertToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function ThresholdInput({ value, suffix, disabled, onCommit }: { value: number; suffix: string; disabled?: boolean; onCommit: (v: number) => void }) {
  const [v, setV] = useState(String(value))
  useEffect(() => { setV(String(value)) }, [value])
  const commit = () => { const n = parseInt(v, 10); if (!Number.isNaN(n) && n !== value) onCommit(n) }
  return (
    <div className="flex items-center gap-1 shrink-0">
      <input
        type="number" inputMode="numeric" value={v} disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className="h-6 w-14 rounded-control border border-input bg-background px-1.5 text-right text-xs tabular-nums focus:outline-none disabled:opacity-40"
      />
      <span className="text-[11px] text-muted-foreground w-5">{suffix}</span>
    </div>
  )
}

function GpuHealthCard() {
  const { health, config, saveConfig, resetBaseline } = useGpuHealth()
  const [showSettings, setShowSettings] = useState(false)
  // Hide entirely on machines with no NVIDIA GPU (feature N/A).
  if (!health || !health.supported) return null

  const missing = health.expected.filter((e) => !health.gpus.some((g) => g.uuid === e.uuid))
  const set = (patch: GpuAlertConfigPatch) => { void saveConfig(patch) }

  return (
    <Card variant="surface" className="border-border/50 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold flex items-center gap-1.5 text-muted-foreground uppercase tracking-wide">
          <MonitorCog className="size-3" /> GPU health
        </h3>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs"><RefreshCw className="size-2.5 mr-1" />live</Badge>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" onClick={() => setShowSettings((s) => !s)}>
            Alerts
          </Button>
        </div>
      </div>

      {health.issues.length > 0 && (
        <div className="space-y-1.5 rounded-control border border-warning/30 bg-warning/10 px-3 py-2">
          {health.issues.map((i) => (
            <p key={i.key} className={cn('flex items-start gap-1.5 text-xs', i.severity === 'error' ? 'text-destructive' : 'text-warning')}>
              <AlertTriangle className="size-3.5 shrink-0 mt-px" /> {i.message}
            </p>
          ))}
          {missing.length > 0 && (
            <button type="button" onClick={() => void resetBaseline()} className="text-[11px] text-muted-foreground underline hover:text-foreground">
              Removed a GPU on purpose? Reset the expected-GPU baseline.
            </button>
          )}
        </div>
      )}

      <div className="space-y-2.5">
        {health.gpus.map((g) => (
          <div key={g.uuid} className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-foreground truncate">{g.name}</span>
              <span className="tabular-nums text-muted-foreground">{g.temperatureC != null ? `${g.temperatureC}°C` : ''}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="text-[11px] text-muted-foreground">Utilization · {g.utilizationPct != null ? `${g.utilizationPct}%` : '—'}</div>
                <LoadBar value={g.utilizationPct ?? 0} max={100} />
              </div>
              <div className="space-y-1">
                <div className="text-[11px] text-muted-foreground">VRAM · {g.memUsedMb != null && g.memTotalMb ? `${(g.memUsedMb / 1024).toFixed(1)} / ${(g.memTotalMb / 1024).toFixed(1)} GB` : '—'}</div>
                <LoadBar value={g.memUsedMb ?? 0} max={g.memTotalMb ?? 1} />
              </div>
            </div>
          </div>
        ))}
        {missing.map((e) => (
          <div key={e.uuid} className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span className="truncate">{e.name}</span>
            <span className="text-muted-foreground">— not detected by CUDA</span>
          </div>
        ))}
      </div>

      {showSettings && config && (
        <div className="space-y-2 border-t border-border/50 pt-2.5">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Alert me when…</p>
          <AlertToggle label="A GPU goes missing or is ejected" checked={config.missing.enabled} onChange={(v) => set({ missing: { enabled: v } })} />
          <AlertToggle label="The GPU driver stops responding" checked={config.driver.enabled} onChange={(v) => set({ driver: { enabled: v } })} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-foreground">A GPU overheats</span>
            <div className="flex items-center gap-2">
              <ThresholdInput value={config.overheat.thresholdC} suffix="°C" disabled={!config.overheat.enabled} onCommit={(n) => set({ overheat: { thresholdC: n } })} />
              <Switch checked={config.overheat.enabled} onCheckedChange={(v) => set({ overheat: { enabled: v } })} />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-foreground">VRAM is nearly full</span>
            <div className="flex items-center gap-2">
              <ThresholdInput value={config.vram.thresholdPct} suffix="%" disabled={!config.vram.enabled} onCommit={(n) => set({ vram: { thresholdPct: n } })} />
              <Switch checked={config.vram.enabled} onCheckedChange={(v) => set({ vram: { enabled: v } })} />
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function AdminSystemTab() {
  const [config, setConfig] = useState<QueueConfig | null>(null)
  const [status, setStatus] = useState<QueueStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [globalMode, setGlobalMode] = useState<'online' | 'offline'>('online')
  const [globalModeSaving, setGlobalModeSaving] = useState(false)
  const [allowDownloads, setAllowDownloads] = useState(false)
  const [allowDownloadsSaving, setAllowDownloadsSaving] = useState(false)

  // Local editable state — initialised from config on load
  const [mode, setMode] = useState<'manual' | 'suggested' | 'dynamic'>('suggested')
  const [manualLimits, setManualLimits] = useState<QueueLimits>({ chat: 2, image: 1, vision: 1 })
  const [dynamicConfig, setDynamicConfig] = useState({ loadHighWatermark: 0.75, loadLowWatermark: 0.40 })

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    apiFetch<{ globalMode: 'online' | 'offline'; allowDownloads: boolean }>('/api/admin/connectivity').then(d => {
      if (d) { setGlobalMode(d.globalMode); setAllowDownloads(d.allowDownloads) }
    })
  }, [])

  // Load config once
  useEffect(() => {
    apiFetch<QueueConfig>('/api/admin/queue/config').then(c => {
      if (!c) return
      setConfig(c)
      setMode(c.mode)
      setManualLimits(c.limits.manual)
      setDynamicConfig({
        loadHighWatermark: c.dynamicConfig.loadHighWatermark,
        loadLowWatermark:  c.dynamicConfig.loadLowWatermark,
      })
    })
  }, [])

  // Poll status every 3 s
  useEffect(() => {
    const poll = () => apiFetch<QueueStatus>('/api/admin/queue/status').then(s => { if (s) setStatus(s) })
    poll()
    pollRef.current = setInterval(poll, 3_000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  async function save() {
    setSaving(true)
    await apiFetch('/api/admin/queue/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        manualLimits,
        dynamicConfig: {
          loadHighWatermark: dynamicConfig.loadHighWatermark,
          loadLowWatermark:  dynamicConfig.loadLowWatermark,
        },
      }),
    })
    setSaving(false)
    setSavedAt(new Date())
    // Re-fetch config to confirm
    apiFetch<QueueConfig>('/api/admin/queue/config').then(c => { if (c) setConfig(c) })
  }

  const effectiveLimits = mode === 'manual'
    ? manualLimits
    : mode === 'suggested'
    ? config?.limits.suggested ?? manualLimits
    : status?.limits ?? manualLimits

  const sys = status?.system

  return (
    <div className="space-y-3 p-4">

      <Card variant="surface" className="border-border/50 p-3 space-y-2">
        <h3 className="text-sm font-semibold">Global connectivity</h3>
        <p className="text-xs text-muted-foreground">
          Forcing local-only mode overrides all user settings — no one can access internet features.
          Use during maintenance or for fully air-gapped deployments.
        </p>
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-2">
            {globalMode === 'offline' ? (
              <WifiOff className="size-4 text-warning" />
            ) : (
              <Wifi className="size-4 text-success" />
            )}
            <span className="text-sm font-medium">
              {globalMode === 'offline' ? 'Local only — forced for all users' : 'Standard (users control their own mode)'}
            </span>
          </div>
          <Switch
            checked={globalMode === 'offline'}
            disabled={globalModeSaving}
            onCheckedChange={async (v) => {
              const newMode = v ? 'offline' : 'online'
              setGlobalModeSaving(true)
              setGlobalMode(newMode)
              await apiFetch('/api/admin/connectivity', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ globalMode: newMode }),
              })
              window.dispatchEvent(new CustomEvent('connectivity-changed'))
              setGlobalModeSaving(false)
            }}
          />
        </div>
        {globalMode === 'offline' && (
          <div className="flex items-center justify-between pt-1 pl-6 border-l-2 border-warning/30 ml-1">
            <div className="space-y-0.5">
              <span className="text-sm font-medium">Allow downloads</span>
              <p className="text-xs text-muted-foreground">
                Permit admin downloads (models, ZIM archives, maps) even in local-only mode.
              </p>
            </div>
            <Switch
              checked={allowDownloads}
              disabled={allowDownloadsSaving}
              onCheckedChange={async (v) => {
                setAllowDownloadsSaving(true)
                setAllowDownloads(v)
                await apiFetch('/api/admin/connectivity', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ allowDownloads: v }),
                })
                setAllowDownloadsSaving(false)
              }}
            />
          </div>
        )}
      </Card>

      {/* Device health + live queue side by side */}
      <div className="grid grid-cols-2 gap-3">
        {sys && (
          <Card variant="surface" className="border-border/50 p-3 space-y-2">
            <h3 className="text-xs font-semibold flex items-center gap-1.5 text-muted-foreground uppercase tracking-wide">
              <Activity className="size-3" />
              Device health
            </h3>
            <div className="space-y-2">
              <div className="space-y-1">
                <div className="flex items-center gap-1 text-xs text-muted-foreground"><Cpu className="size-3" /> CPU load</div>
                <LoadBar value={sys.loadNorm} />
                <p className="text-xs text-muted-foreground">{(sys.loadNorm * 100).toFixed(0)}% · {sys.cpuCount} cores</p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1 text-xs text-muted-foreground"><MemoryStick className="size-3" /> RAM</div>
                <LoadBar value={sys.totalRamGb - sys.freeRamGb} max={sys.totalRamGb} />
                <p className="text-xs text-muted-foreground">{sys.freeRamGb} GB free / {sys.totalRamGb} GB total</p>
              </div>
            </div>
          </Card>
        )}
        {status && (
          <Card variant="surface" className="border-border/50 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Active requests</h3>
              <Badge variant="secondary" className="text-xs">
                <RefreshCw className="size-2.5 mr-1" />
                live
              </Badge>
            </div>
            <div className="space-y-2">
              <SlotCounter label="Chat" running={status.running.chat} queued={status.queued.chat} limit={effectiveLimits.chat} />
              <SlotCounter label="Image" running={status.running.image} queued={status.queued.image} limit={effectiveLimits.image} />
              <SlotCounter label="Vision" running={status.running.vision} queued={status.queued.vision} limit={effectiveLimits.vision} />
            </div>
          </Card>
        )}
      </div>

      <GpuHealthCard />

      {/* Mode selector */}
      <Card variant="surface" className="border-border/50 p-3 space-y-2">
        <h3 className="text-sm font-semibold">How requests are handled</h3>
        <RichOptionSelect
          groups={[{
            options: [
              {
                value: 'suggested',
                label: 'Automatic (recommended)',
                description: 'Loki figures out the best limits for your device at startup. Works well for most setups.',
                recommended: true,
              },
              {
                value: 'manual',
                label: 'Custom',
                description: 'You decide exactly how many things can run at once. Best if you know your hardware.',
              },
              {
                value: 'dynamic',
                label: 'Adaptive',
                description: 'Limits adjust in real time based on how busy your device is. Backs off when things heat up.',
              },
            ],
          }]}
          value={mode}
          onChange={(v) => setMode(v as 'manual' | 'suggested' | 'dynamic')}
          placeholder="Select mode…"
        />
      </Card>

      {/* Suggested limits (read-only display) */}
      {config && (
        <Card variant="surface" className="border-border/50 p-3 space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Recommended for this device
            <span className="ml-2 font-normal normal-case">(based on your RAM and CPU)</span>
          </h3>
          <div className="grid grid-cols-3 gap-2">
            {(['chat', 'image', 'vision'] as const).map(type => (
              <div key={type} className="rounded-control bg-muted/50 p-2 text-center">
                <div className="text-xl font-bold tabular-nums">{config.limits.suggested[type]}</div>
                <div className="text-xs text-muted-foreground capitalize">{type} slots</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Manual limits (editable when mode = manual) */}
      {mode === 'manual' && (
        <Card variant="surface" className="border-border/50 p-3 space-y-2">
          <h3 className="text-sm font-semibold">Custom limits</h3>
          <div className="grid grid-cols-3 gap-3">
            {(['chat', 'image', 'vision'] as const).map(type => (
              <div key={type} className="flex flex-col gap-1">
                <label className="text-xs font-medium capitalize">{type}</label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setManualLimits(p => ({ ...p, [type]: Math.max(1, p[type] - 1) }))}
                    className="size-7 rounded-full border border-border bg-background hover:bg-muted flex items-center justify-center text-sm font-bold transition-colors"
                  >
                    −
                  </button>
                  <span className="w-8 text-center tabular-nums text-sm font-medium">{manualLimits[type]}</span>
                  <button
                    onClick={() => setManualLimits(p => ({ ...p, [type]: Math.min(type === 'chat' ? 8 : 4, p[type] + 1) }))}
                    className="size-7 rounded-full border border-border bg-background hover:bg-muted flex items-center justify-center text-sm font-bold transition-colors"
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Dynamic watermarks (editable when mode = dynamic) */}
      {mode === 'dynamic' && (
        <Card variant="surface" className="border-border/50 p-3 space-y-2">
          <h3 className="text-sm font-semibold">Adaptive settings</h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium">Slow down when load reaches</label>
              <div className="flex items-center gap-2">
                <input
                  type="range" min={0.5} max={1.0} step={0.05}
                  value={dynamicConfig.loadHighWatermark}
                  onChange={e => setDynamicConfig(p => ({ ...p, loadHighWatermark: parseFloat(e.target.value) }))}
                  className="flex-1"
                />
                <span className="w-10 text-right text-xs tabular-nums">{(dynamicConfig.loadHighWatermark * 100).toFixed(0)}%</span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium">Speed up when load drops below</label>
              <div className="flex items-center gap-2">
                <input
                  type="range" min={0.1} max={0.7} step={0.05}
                  value={dynamicConfig.loadLowWatermark}
                  onChange={e => setDynamicConfig(p => ({ ...p, loadLowWatermark: parseFloat(e.target.value) }))}
                  className="flex-1"
                />
                <span className="w-10 text-right text-xs tabular-nums">{(dynamicConfig.loadLowWatermark * 100).toFixed(0)}%</span>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Save */}
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving} size="sm">
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        {savedAt && (
          <p className="text-xs text-muted-foreground">
            Saved at {savedAt.toLocaleTimeString()}
          </p>
        )}
      </div>
    </div>
  )
}
