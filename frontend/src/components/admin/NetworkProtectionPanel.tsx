import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DnsConfig {
  enabled: boolean
  port: number
  upstreams: string[]
  categories: string[]
  kidsCategories: string[]
}

interface Category {
  id: string
  label: string
  description: string
  downloaded: boolean
  count: number
}

interface Device {
  ip: string
  label: string
  profile: string
  lastSeenAt: string | null
  queries: number
  blocked: number
}

interface Rule {
  id: string
  domain: string
  action: 'allow' | 'deny'
}

interface Payload {
  config: DnsConfig
  running: boolean
  bindError: string | null
  categories: Category[]
  devices: Device[]
  rules: Rule[]
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/admin/network-protection${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  try {
    return (await r.json()) as T
  } catch {
    throw new Error(`Unexpected response (${r.status})`)
  }
}

const PROFILES = [
  { value: 'default', label: 'Standard' },
  { value: 'kids', label: 'Kids' },
  { value: 'unfiltered', label: 'Unfiltered' },
] as const

// ── Panel ─────────────────────────────────────────────────────────────────────

export function NetworkProtectionPanel() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [busyList, setBusyList] = useState<string | null>(null)
  const [newDomain, setNewDomain] = useState('')
  const [newAction, setNewAction] = useState<'allow' | 'deny'>('deny')

  const load = useCallback(async () => {
    try {
      setData(await api<Payload>(''))
    } catch {
      toast.error('Could not load network protection settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function saveConfig(patch: Partial<DnsConfig>) {
    if (!data) return
    const next = { ...data.config, ...patch }
    setData({ ...data, config: next })
    setSaving(true)
    try {
      const res = await api<{ ok: boolean; error?: string; running?: boolean; bindError?: string | null }>('/config', {
        method: 'PUT',
        body: JSON.stringify(next),
      })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save settings')
        await load()
        return
      }
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function downloadList(id: string) {
    setBusyList(id)
    try {
      const res = await api<{ ok: boolean; count?: number; error?: string }>(`/blocklist/${id}/download`, { method: 'POST' })
      if (res.ok) toast.success(`Downloaded ${res.count?.toLocaleString()} domains`)
      else toast.error(res.error ?? 'Download failed')
      await load()
    } finally {
      setBusyList(null)
    }
  }

  async function setDeviceProfile(ip: string, profile: string) {
    if (!data) return
    setData({ ...data, devices: data.devices.map((d) => (d.ip === ip ? { ...d, profile } : d)) })
    const res = await api<{ ok: boolean; error?: string }>(`/device/${encodeURIComponent(ip)}`, {
      method: 'PUT',
      body: JSON.stringify({ profile }),
    })
    if (!res.ok) {
      toast.error(res.error ?? 'Could not update the device')
      await load()
    }
  }

  async function addRule() {
    if (!newDomain.trim()) return
    const res = await api<{ ok: boolean; error?: string }>('/rule', {
      method: 'POST',
      body: JSON.stringify({ domain: newDomain.trim(), action: newAction }),
    })
    if (!res.ok) {
      toast.error(res.error ?? 'Could not add the rule')
      return
    }
    setNewDomain('')
    await load()
  }

  async function deleteRule(id: string) {
    await api(`/rule/${id}`, { method: 'DELETE' })
    await load()
  }

  if (loading) return <div className="flex justify-center py-10"><Spinner /></div>
  if (!data) return <div className="text-sm text-destructive">Could not load network protection settings.</div>

  const { config } = data

  return (
    <div className="space-y-6 max-w-3xl">
      {/* ── Master toggle ── */}
      <section className="rounded-card border border-border bg-card p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-medium flex items-center gap-2">
              <ShieldCheck className="size-4 text-brand" /> Network-wide protection
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Blocks ads, trackers, and malware for every device that uses this server for DNS.
              Point your router's DNS at this machine to cover the whole house.
            </p>
          </div>
          <Switch
            checked={config.enabled}
            onCheckedChange={(v) => void saveConfig({ enabled: v })}
            aria-label="Enable network protection"
          />
        </div>

        {config.enabled && !data.running && (
          <div className="rounded-control border border-warning/50 bg-warning/10 p-3 text-sm flex items-start gap-2">
            <AlertTriangle className="size-4 text-warning shrink-0 mt-0.5" />
            <div>
              <div className="font-medium">The DNS server is not running.</div>
              <p className="text-muted-foreground">
                {data.bindError
                  ? `Could not bind port ${config.port}: ${data.bindError}. Port 53 usually needs elevated privileges, or another DNS service (like systemd-resolved) may already own it.`
                  : 'Enable it above and make sure port 53 is free.'}
              </p>
            </div>
          </div>
        )}
        {config.enabled && data.running && (
          <div className="text-sm text-success flex items-center gap-2">
            <span className="size-2 rounded-full bg-success" /> Listening on port {config.port}
          </div>
        )}

        <label className="flex items-center gap-3 text-sm pt-1">
          <span className="text-muted-foreground w-40">Upstream resolvers</span>
          <Input
            value={config.upstreams.join(', ')}
            onChange={(e) => void saveConfig({ upstreams: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            placeholder="1.1.1.1, 9.9.9.9"
            className="flex-1"
          />
        </label>
      </section>

      {/* ── Blocklists ── */}
      <section className="space-y-2">
        <h3 className="font-medium">Blocklists</h3>
        {data.categories.map((cat) => {
          const inStandard = config.categories.includes(cat.id)
          const inKids = config.kidsCategories.includes(cat.id)
          return (
            <div key={cat.id} className="rounded-card border border-border bg-card p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{cat.label}</div>
                  <p className="text-xs text-muted-foreground">{cat.description}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {cat.downloaded ? `${cat.count.toLocaleString()} domains` : 'Not downloaded yet'}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => void downloadList(cat.id)} disabled={busyList === cat.id}>
                  {busyList === cat.id ? <Spinner className="size-4" /> : <Download className="size-4" />}
                  {cat.downloaded ? 'Update' : 'Download'}
                </Button>
              </div>
              <div className="flex items-center gap-4 text-sm pt-1 border-t border-border/60">
                <label className="flex items-center gap-2 pt-2">
                  <Switch
                    checked={inStandard}
                    onCheckedChange={(v) => void saveConfig({
                      categories: v ? [...config.categories, cat.id] : config.categories.filter((x) => x !== cat.id),
                    })}
                    aria-label={`Use ${cat.label} for the standard profile`}
                  />
                  <span className="text-muted-foreground">Standard</span>
                </label>
                <label className="flex items-center gap-2 pt-2">
                  <Switch
                    checked={inKids}
                    onCheckedChange={(v) => void saveConfig({
                      kidsCategories: v ? [...config.kidsCategories, cat.id] : config.kidsCategories.filter((x) => x !== cat.id),
                    })}
                    aria-label={`Use ${cat.label} for the kids profile`}
                  />
                  <span className="text-muted-foreground">Kids</span>
                </label>
              </div>
            </div>
          )
        })}
      </section>

      {/* ── Custom rules ── */}
      <section className="space-y-2">
        <h3 className="font-medium">Custom rules</h3>
        <div className="flex items-center gap-2">
          <select
            value={newAction}
            onChange={(e) => setNewAction(e.target.value as 'allow' | 'deny')}
            className="h-9 rounded-control border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="deny">Block</option>
            <option value="allow">Allow</option>
          </select>
          <Input
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addRule() }}
            placeholder="example.com"
            className="flex-1"
          />
          <Button size="sm" onClick={() => void addRule()}><Plus className="size-4" /> Add</Button>
        </div>
        <div className="space-y-1.5">
          {data.rules.map((rule) => (
            <div key={rule.id} className="flex items-center gap-3 rounded-control border border-border bg-card px-3 py-2 text-sm">
              <span className={cn('text-xs rounded-full px-2 py-0.5', rule.action === 'deny' ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success')}>
                {rule.action === 'deny' ? 'Blocked' : 'Allowed'}
              </span>
              <span className="flex-1 truncate">{rule.domain}</span>
              <Button size="icon" variant="ghost" aria-label="Delete rule" onClick={() => void deleteRule(rule.id)}>
                <Trash2 className="size-4 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
      </section>

      {/* ── Devices ── */}
      <section className="space-y-2">
        <h3 className="font-medium">Devices</h3>
        {data.devices.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Devices appear here as they make DNS requests through the server.
          </p>
        )}
        <div className="rounded-card border border-border divide-y divide-border overflow-hidden">
          {data.devices.map((device) => (
            <div key={device.ip} className="flex items-center gap-3 px-4 py-2.5 bg-card">
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{device.label}</div>
                <div className="text-xs text-muted-foreground">
                  {device.queries.toLocaleString()} queries, {device.blocked.toLocaleString()} blocked
                </div>
              </div>
              <select
                value={device.profile}
                onChange={(e) => void setDeviceProfile(device.ip, e.target.value)}
                className="h-8 rounded-control border border-input bg-transparent px-2 text-sm"
              >
                {PROFILES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          ))}
        </div>
      </section>

      {saving && <div className="text-xs text-muted-foreground">Saving</div>}
    </div>
  )
}
