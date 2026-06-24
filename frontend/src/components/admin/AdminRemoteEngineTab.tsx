import { useEffect, useState, useCallback } from 'react'
import { Cpu, Loader2, CheckCircle2, XCircle, Server } from 'lucide-react'
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

const inputCls = 'w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/40'

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
    return <div className="flex justify-center py-16 text-muted-foreground"><Loader2 className="size-6 animate-spin" /></div>
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <Cpu className="size-6 text-violet-500" />
        <div>
          <h2 className="text-lg font-black">Inference Engine</h2>
          <p className="text-sm text-muted-foreground">Run the LLM on a remote Ollama host instead of this device.</p>
        </div>
      </div>

      {/* Current status */}
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
        <Server className="size-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{enabled ? 'Using remote engine' : 'Using local engine'}</p>
          <p className="truncate text-xs text-muted-foreground">{enabled ? (baseUrl || '—') : localUrl}</p>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${enabled ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground'}`}>
          {enabled ? 'Remote' : 'Local'}
        </span>
      </div>

      {/* Pairing form */}
      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Remote Ollama URL</label>
          <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://192.168.1.50:11434" />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void runProbe()}
            disabled={probing || !baseUrl.trim()}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {probing ? <Loader2 className="size-4 animate-spin" /> : <Server className="size-4" />} Test connection
          </button>
          {probe && (
            probe.ok
              ? <span className="inline-flex items-center gap-1 text-sm text-emerald-600"><CheckCircle2 className="size-4" /> {probe.models.length} models · {probe.latencyMs}ms</span>
              : <span className="inline-flex items-center gap-1 text-sm text-destructive"><XCircle className="size-4" /> {ERR_MSG[probe.error ?? ''] ?? 'Failed'}</span>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Model</label>
          {probe?.ok && probe.models.length ? (
            <select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Select a model…</option>
              {probe.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. llama3.1:8b" />
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => void save(false)}
          disabled={saving}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          Save (keep local)
        </button>
        {enabled ? (
          <button
            onClick={() => void save(false)}
            disabled={saving}
            className="rounded-lg bg-muted px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {saving && <Loader2 className="mr-1 inline size-4 animate-spin" />} Switch to local
          </button>
        ) : (
          <button
            onClick={() => void save(true)}
            disabled={saving || !baseUrl.trim() || !model.trim()}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving && <Loader2 className="mr-1 inline size-4 animate-spin" />} Enable remote engine
          </button>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        The remote host must be a reachable Ollama server with the chosen model pulled. Changes apply to new messages immediately.
      </p>
    </div>
  )
}
