import { useEffect, useRef, useState } from 'react'
import { Activity, Cpu, MemoryStick, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { RichOptionSelect } from '@/components/shared/RichOptionSelect'

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
