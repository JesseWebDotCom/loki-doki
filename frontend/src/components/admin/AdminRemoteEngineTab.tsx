import { useEffect, useState, useCallback } from 'react'
import { Cpu, CheckCircle2, XCircle, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot } from '@/components/shared/StatusDot'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { toast } from '@/lib/toast'

interface ProbeResult {
  ok: boolean
  models: string[]
  latencyMs: number | null
  error: 'auth' | 'unreachable' | 'invalid_response' | null
}
interface EngineState {
  enabled: boolean
  baseUrl: string | null
  model: string | null
  localUrl: string
  probe: ProbeResult | null
}

const selectCls = 'h-9 w-full rounded-control border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

const ERR_MSG: Record<string, string> = {
  auth: 'Authentication failed.',
  unreachable: 'Host is unreachable.',
  invalid_response: 'Not a valid Ollama host.',
}

export function AdminRemoteEngineTab() {
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [localUrl, setLocalUrl] = useState('')
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmSwitchToLocal, setConfirmSwitchToLocal] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/remote-engine', { credentials: 'include' })
      if (!r.ok) throw new Error()
      const d = (await r.json()) as EngineState
      setEnabled(d.enabled)
      setBaseUrl(d.baseUrl ?? '')
      setModel(d.model ?? '')
      setLocalUrl(d.localUrl)
      setProbe(d.probe)
    } catch {
      toast.error('Could not load engine settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const runProbe = useCallback(async () => {
    if (!baseUrl.trim()) return
    setProbing(true)
    setProbe(null)
    try {
      const r = await fetch('/api/admin/remote-engine/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ baseUrl }),
      })
      const d = (await r.json()) as ProbeResult
      setProbe(d)
      if (d.ok && d.models.length && !model) setModel(d.models[0]!)
    } catch {
      setProbe({ ok: false, models: [], latencyMs: null, error: 'unreachable' })
    } finally {
      setProbing(false)
    }
  }, [baseUrl, model])

  const save = useCallback(async (nextEnabled: boolean) => {
    setSaving(true)
    try {
      const r = await fetch('/api/admin/remote-engine', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ baseUrl: baseUrl.trim() || null, model: model.trim() || null, enabled: nextEnabled }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((d as { error?: string }).error ?? 'Save failed')
      setEnabled((d as EngineState).enabled)
      toast.success(nextEnabled ? 'Remote engine enabled' : 'Saved')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }, [baseUrl, model])

  if (loading) {
    return <div className="flex justify-center py-16"><Spinner size="lg" /></div>
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <Cpu className="size-6 text-brand" />
        <div>
          <h2 className="text-title">Inference Engine</h2>
          <p className="text-sm text-muted-foreground">Run the LLM on a remote Ollama host instead of this device.</p>
        </div>
      </div>

      {/* Current status */}
      <Card variant="surface" className="flex items-center gap-3 p-4">
        <Server className="size-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{enabled ? 'Using remote engine' : 'Using local engine'}</p>
          <p className="truncate text-xs text-muted-foreground">{enabled ? (baseUrl || '—') : localUrl}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${enabled ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'}`}>
          <StatusDot status={enabled ? 'ok' : 'off'} />
          {enabled ? 'Remote' : 'Local'}
        </span>
      </Card>

      {/* Pairing form */}
      <Card variant="surface" className="space-y-4 p-4">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Remote Ollama URL</label>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://192.168.1.50:11434" className="h-10 px-4 py-2.5" />
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runProbe()}
            disabled={probing || !baseUrl.trim()}
            className="gap-2"
          >
            {probing ? <Spinner size="sm" className="text-current" /> : <Server className="size-4" />} Test connection
          </Button>
          {probe && (
            probe.ok
              ? <span className="inline-flex items-center gap-1 text-sm text-success"><CheckCircle2 className="size-4" /> {probe.models.length} models, {probe.latencyMs}ms</span>
              : <span className="inline-flex items-center gap-1 text-sm text-destructive"><XCircle className="size-4" /> {ERR_MSG[probe.error ?? ''] ?? 'Failed'}</span>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Model</label>
          {probe?.ok && probe.models.length ? (
            <select className={selectCls} value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Select a model…</option>
              {probe.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. llama3.1:8b" className="h-10 px-4 py-2.5" />
          )}
        </div>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          onClick={() => void save(false)}
          disabled={saving}
        >
          Save (keep local)
        </Button>
        {enabled ? (
          <Button
            variant="secondary"
            onClick={() => setConfirmSwitchToLocal(true)}
            disabled={saving}
            className="gap-1.5"
          >
            {saving && <Spinner size="sm" className="text-current" />} Switch to local
          </Button>
        ) : (
          <Button
            onClick={() => void save(true)}
            disabled={saving || !baseUrl.trim() || !model.trim()}
            className="gap-1.5"
          >
            {saving && <Spinner size="sm" className="text-current" />} Enable remote engine
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        The remote host must be a reachable Ollama server with the chosen model pulled. Changes apply to new messages immediately.
      </p>

      <ConfirmDialog
        open={confirmSwitchToLocal}
        onOpenChange={setConfirmSwitchToLocal}
        title="Switch to the local engine?"
        description="This disconnects the remote Ollama host. New messages will run on this device instead."
        confirmLabel="Switch to local"
        destructive
        onConfirm={() => void save(false)}
      />
    </div>
  )
}
