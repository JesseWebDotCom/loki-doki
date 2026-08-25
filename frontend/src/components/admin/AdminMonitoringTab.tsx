// Admin → Integrations → Monitoring (Uptime Kuma). Plug in the Kuma URL + API key,
// generate a webhook token to paste into Kuma, and pick alert preferences, including
// which monitors the companion announces aloud. Mirrors AdminFrigateTab conventions.

import { useEffect, useState } from 'react'
import { Activity, Copy, Check, KeyRound, Wifi, WifiOff, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import {
  getMonitoringConfig, saveMonitoringConfig, generateWebhookToken, testMonitoring,
  type MonitoringConfig, type MonitorState,
} from '@/lib/monitoring/api'

export function AdminMonitoringTab() {
  const [cfg, setCfg] = useState<MonitoringConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [apiKey, setApiKey] = useState('')       // write-only; blank keeps the stored key
  const [testing, setTesting] = useState(false)
  const [monitors, setMonitors] = useState<MonitorState[] | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => { void load() }, [])
  async function load() {
    setLoading(true)
    try { setCfg(await getMonitoringConfig()) } catch { toast.error('Failed to load monitoring config') }
    setLoading(false)
  }

  function patch(p: Partial<MonitoringConfig>) { setCfg((c) => (c ? { ...c, ...p } : c)) }

  async function save() {
    if (!cfg) return
    setSaving(true)
    try {
      await saveMonitoringConfig({
        enabled: cfg.enabled,
        announceEnabled: cfg.announceEnabled,
        notifyOn: cfg.notifyOn,
        cooldownMinutes: cfg.cooldownMinutes,
        criticalMonitors: cfg.criticalMonitors,
        reconcileEnabled: cfg.reconcileEnabled,
        reconcileMinutes: cfg.reconcileMinutes,
        baseUrl: cfg.baseUrl,
        ...(apiKey ? { apiKey } : {}),
      })
      setApiKey('')
      await load()
      toast.success('Monitoring settings saved')
    } catch { toast.error('Save failed') }
    setSaving(false)
  }

  async function genToken() {
    try { await generateWebhookToken(); await load(); toast.success('Webhook token generated') }
    catch { toast.error('Could not generate token') }
  }

  async function runTest() {
    setTesting(true); setMonitors(null)
    try {
      const r = await testMonitoring()
      if (r.ok) { setMonitors(r.monitors ?? []); toast.success(`Connected: ${r.count} monitor(s) found`) }
      else toast.error(r.error || 'Connection failed')
    } catch { toast.error('Connection failed') }
    setTesting(false)
  }

  async function copyWebhook() {
    if (!cfg?.webhookUrl) return
    await navigator.clipboard.writeText(cfg.webhookUrl)
    setCopied(true); setTimeout(() => setCopied(false), 1500)
  }

  function toggleEvent(ev: string, on: boolean) {
    if (!cfg) return
    const set = new Set(cfg.notifyOn)
    if (on) set.add(ev); else set.delete(ev)
    patch({ notifyOn: [...set] })
  }
  function toggleCritical(name: string, on: boolean) {
    if (!cfg) return
    const set = new Set(cfg.criticalMonitors)
    if (on) set.add(name); else set.delete(name)
    patch({ criticalMonitors: [...set] })
  }

  if (loading || !cfg) return <div className="flex justify-center p-12"><Spinner /></div>

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Enable */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              <div>
                <CardTitle>Uptime Kuma monitoring</CardTitle>
                <CardDescription>Get told when a service or server goes down; the companion can announce it.</CardDescription>
              </div>
            </div>
            <Switch checked={cfg.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
          </div>
        </CardHeader>
      </Card>

      {/* Connection */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connection</CardTitle>
          <CardDescription>Point at your Kuma instance and paste an API key (Kuma → Settings → API Keys). Used to discover your monitors and as a reconcile safety net.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Kuma URL</Label>
            <Input value={cfg.baseUrl} placeholder="http://192.0.2.20:3001"
              onChange={(e) => patch({ baseUrl: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>API key {cfg.apiKeySet && <span className="text-xs text-muted-foreground">(saved, leave blank to keep)</span>}</Label>
            <Input type="password" value={apiKey} placeholder={cfg.apiKeySet ? '••••••••' : 'uk1_…'}
              onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={runTest} disabled={testing}>
              {testing ? <Spinner className="h-4 w-4" /> : <Wifi className="h-4 w-4" />}
              Test connection
            </Button>
            {monitors && (
              <span className="text-sm text-muted-foreground">{monitors.length} monitor(s) discovered</span>
            )}
          </div>
          {monitors && monitors.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {monitors.map((m) => (
                <span key={m.name} className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs',
                  m.up ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')}>
                  {m.up ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}{m.name}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Webhook (real-time push) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Real-time webhook</CardTitle>
          <CardDescription>Add this URL as a <strong>Webhook</strong> notification in Kuma (Settings → Notifications), then enable it on your monitors. This is how alerts arrive instantly.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {cfg.webhookUrl ? (
            <div className="flex items-center gap-2">
              <Input readOnly value={cfg.webhookUrl} className="font-mono text-xs" />
              <Button variant="outline" size="icon" onClick={copyWebhook}>
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Generate a token to get your webhook URL.</p>
          )}
          <Button variant="outline" onClick={genToken}>
            <KeyRound className="h-4 w-4" />{cfg.webhookTokenSet ? 'Regenerate token' : 'Generate token'}
          </Button>
        </CardContent>
      </Card>

      {/* Alert preferences */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Alert preferences</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <div><Label>Alert when a service goes down</Label></div>
            <Switch checked={cfg.notifyOn.includes('down')} onCheckedChange={(v) => toggleEvent('down', v)} />
          </div>
          <div className="flex items-center justify-between">
            <div><Label>Alert when it recovers</Label></div>
            <Switch checked={cfg.notifyOn.includes('up')} onCheckedChange={(v) => toggleEvent('up', v)} />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2"><Volume2 className="h-4 w-4" /><Label>Companion announces aloud</Label></div>
            <Switch checked={cfg.announceEnabled} onCheckedChange={(v) => patch({ announceEnabled: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>Cooldown (minutes)</Label>
            <Input type="number" min={0} className="w-32" value={cfg.cooldownMinutes}
              onChange={(e) => patch({ cooldownMinutes: Math.max(0, Number(e.target.value) || 0) })} />
            <p className="text-xs text-muted-foreground">Suppress repeat alerts for the same service within this window.</p>
          </div>

          {/* Critical monitors (spoken aloud) */}
          <div className="space-y-2">
            <Label>Announce these aloud</Label>
            <p className="text-xs text-muted-foreground">Pick which monitors the companion speaks about. Leave empty to announce all of them. (Run “Test connection” above to load the list.)</p>
            {monitors && monitors.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 pt-1">
                {monitors.map((m) => (
                  <label key={m.name} className="flex items-center gap-2 text-sm">
                    <Switch checked={cfg.criticalMonitors.includes(m.name)} onCheckedChange={(v) => toggleCritical(m.name, v)} />
                    {m.name}
                  </label>
                ))}
              </div>
            ) : cfg.criticalMonitors.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {cfg.criticalMonitors.map((n) => (
                  <span key={n} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs">{n}
                    <button onClick={() => toggleCritical(n, false)} className="text-muted-foreground hover:text-foreground">×</button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {/* Reconcile safety net */}
          <div className="flex items-center justify-between border-t pt-4">
            <div>
              <Label>Reconcile safety net</Label>
              <p className="text-xs text-muted-foreground">Periodically poll Kuma to catch any events missed while the app was down (needs the API key).</p>
            </div>
            <Switch checked={cfg.reconcileEnabled} onCheckedChange={(v) => patch({ reconcileEnabled: v })} />
          </div>
          {cfg.reconcileEnabled && (
            <div className="space-y-1.5">
              <Label>Reconcile every (minutes)</Label>
              <Input type="number" min={1} className="w-32" value={cfg.reconcileMinutes}
                onChange={(e) => patch({ reconcileMinutes: Math.max(1, Number(e.target.value) || 5) })} />
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>{saving ? <Spinner className="h-4 w-4" /> : null}Save settings</Button>
      </div>
    </div>
  )
}
