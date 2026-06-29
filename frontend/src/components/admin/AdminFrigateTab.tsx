// Admin → Integrations → Frigate. Four tabs: Connection, Announcements, Plate Log, Events.

import { useEffect, useState } from 'react'
import { Loader2, Camera, Copy, Check, KeyRound, Wifi, WifiOff, Car, ListVideo } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import {
  getFrigateConfig, saveFrigateConfig, testFrigate, listEvents,
  type FrigateConfig, type FrigateTestResult, type FrigateEvent,
} from '@/lib/frigate/api'

type Tab = 'connection' | 'announcements' | 'plates' | 'events'
const TABS: [Tab, string][] = [
  ['connection',    'Connection'],
  ['announcements', 'Announcements'],
  ['plates',        'Plate Log'],
  ['events',        'Events'],
]

const ANNOUNCE_LABELS: Record<string, string> = {
  person:     'Person detected',
  delivery:   'Delivery vehicle (FedEx, UPS, Amazon…)',
  plate:      'License plate recognised',
  suspicious: 'Suspicious activity (review summaries)',
}

function platesToText(plates: Record<string, string>): string {
  return Object.entries(plates).map(([p, n]) => `${p} = ${n}`).join('\n')
}
function textToPlates(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.split('=')
    if (m.length >= 2) {
      const plate = m[0]!.trim()
      const name = m.slice(1).join('=').trim()
      if (plate && name) out[plate] = name
    }
  }
  return out
}

function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60)    return `${s}s ago`
  if (s < 3600)  return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

export function AdminFrigateTab() {
  const [tab, setTab] = useState<Tab>('connection')
  const [cfg, setCfg] = useState<FrigateConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<FrigateTestResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedToken, setCopiedToken] = useState(false)

  // connection fields
  const [enabled, setEnabled] = useState(true)
  const [baseUrl, setBaseUrl] = useState('')
  const [mqttHost, setMqttHost] = useState('')
  const [mqttPort, setMqttPort] = useState('1883')
  const [mqttUsername, setMqttUsername] = useState('')
  const [mqttPassword, setMqttPassword] = useState('')
  const [shimToken, setShimToken] = useState('')
  const [shimTokenSet, setShimTokenSet] = useState(false)

  // announce fields
  const [announceEnabled, setAnnounceEnabled] = useState(true)
  const [cooldownMinutes, setCooldownMinutes] = useState(0)
  const [announce, setAnnounce] = useState<string[]>([])

  // known plates
  const [platesText, setPlatesText] = useState('')

  // log data
  const [plates, setPlates] = useState<FrigateEvent[]>([])
  const [events, setEvents] = useState<FrigateEvent[]>([])
  const [loadingLog, setLoadingLog] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const c = await getFrigateConfig()
      setCfg(c)
      setEnabled(c.enabled)
      setBaseUrl(c.baseUrl)
      setMqttHost(c.mqttHost)
      setMqttPort(String(c.mqttPort))
      setMqttUsername(c.mqttUsername)
      setShimTokenSet(c.shimTokenSet)
      setAnnounceEnabled(c.announceEnabled)
      setCooldownMinutes(c.cooldownMinutes)
      setAnnounce(c.announce)
      setPlatesText(platesToText(c.knownPlates))
    } catch { toast.error('Failed to load Frigate config') } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (tab === 'plates') void loadLog('plate')
    else if (tab === 'events') void loadLog()
  }, [tab])

  async function loadLog(kind?: string) {
    setLoadingLog(true)
    try {
      const rows = await listEvents(100, kind)
      if (kind === 'plate') setPlates(rows)
      else setEvents(rows)
    } catch { /* silent */ } finally { setLoadingLog(false) }
  }

  async function save() {
    setSaving(true)
    try {
      await saveFrigateConfig({
        enabled, announceEnabled, cooldownMinutes,
        baseUrl, mqttHost, mqttPort: Number(mqttPort),
        mqttUsername, announce, knownPlates: textToPlates(platesText),
        ...(mqttPassword ? { mqttPassword } : {}),
        ...(shimToken ? { shimToken } : {}),
      })
      toast.success('Saved')
      setMqttPassword(''); setShimToken('')
      await load()
    } catch { toast.error('Failed to save') } finally { setSaving(false) }
  }

  function genToken() {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    setShimToken('fg_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''))
    toast.success('Token generated — click Save to store it')
  }

  async function runTest() {
    setTesting(true)
    try { setTest(await testFrigate()) } catch { toast.error('Test failed') } finally { setTesting(false) }
  }

  function toggleAnnounce(t: string) {
    setAnnounce(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
  }

  function copyYaml() {
    void navigator.clipboard.writeText(yaml).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  function copyToken() {
    if (!shimToken) return
    void navigator.clipboard.writeText(shimToken).then(() => { setCopiedToken(true); setTimeout(() => setCopiedToken(false), 1500) })
  }

  const shimBaseUrl = cfg?.shimBaseUrl ?? 'http://<this-app-ip>:3000/api/frigate/v1'
  const tokenForYaml = shimToken || '<paste-or-generate-a-token-above>'
  const yaml = `# ─────────────────────────────────────────────────────────────
# Add to your Frigate config.yaml, then restart Frigate.
# ─────────────────────────────────────────────────────────────

# 1) Point Frigate's GenAI provider at this app (top level):
genai:
  provider: openai
  api_key: ${tokenForYaml}
  base_url: ${shimBaseUrl}
  model: gpt-4o          # any value — this app ignores it and uses your local vision model

# 2) Turn descriptions on for each camera you want (repeat per camera):
cameras:
  front_door:            # ← your camera's name
    genai:
      enabled: true
      objects: [person, car]      # which tracked objects to describe`

  if (loading) return (
    <div className="flex items-center justify-center p-10">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  )

  const announceTypes = cfg?.allAnnounceTypes ?? ['person', 'delivery', 'plate', 'suspicious']

  return (
    <div className="flex flex-col max-w-3xl">
      {/* Page header */}
      <div className="flex items-start gap-3 p-5 pb-0">
        <div className="rounded-lg bg-muted p-2 shrink-0"><Camera className="size-5 text-muted-foreground" /></div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold">Frigate NVR</h2>
          <p className="text-sm text-muted-foreground">
            Use this app's local vision model as Frigate's GenAI provider, and turn camera events into
            notifications and companion announcements.
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={v => { setEnabled(v); void saveFrigateConfig({ enabled: v }).catch(() => {}) }} aria-label="Enable Frigate" />
      </div>

      {/* Tab bar */}
      <div className="sticky top-0 z-10 bg-background border-b border-border/60 flex gap-5 px-5 mt-4">
        {TABS.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={cn('relative -mb-px border-b-2 py-3 text-sm font-semibold transition-colors',
              tab === key
                ? 'border-brand text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
          </button>
        ))}
      </div>

      <div className="p-5 space-y-5">

        {/* ── Connection ─────────────────────────────────────────── */}
        {tab === 'connection' && <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Connection</CardTitle>
              <CardDescription>Where your Frigate box lives.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Frigate URL</Label>
                <Input placeholder="http://192.168.1.50:5000" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
                <p className="text-xs text-muted-foreground">Used to fetch snapshots/clips and verify the connection.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>MQTT broker host</Label>
                  <Input placeholder="192.168.1.50" value={mqttHost} onChange={e => setMqttHost(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>MQTT port</Label>
                  <Input placeholder="1883" value={mqttPort} onChange={e => setMqttPort(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>MQTT username <span className="text-muted-foreground">(optional)</span></Label>
                  <Input value={mqttUsername} onChange={e => setMqttUsername(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>MQTT password {cfg?.mqttPasswordSet && <span className="text-muted-foreground">(set)</span>}</Label>
                  <Input type="password" placeholder={cfg?.mqttPasswordSet ? '••••••••' : ''} value={mqttPassword} onChange={e => setMqttPassword(e.target.value)} />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">GenAI shim token</CardTitle>
              <CardDescription>
                The password Frigate sends as its <code>genai.api_key</code> so only it can use this app's vision model.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  value={shimToken}
                  onChange={e => setShimToken(e.target.value)}
                  placeholder={shimTokenSet ? '•••••• — a token is set; paste or generate to replace' : 'fg_… paste your existing token, or generate →'}
                  className="font-mono text-xs"
                />
                <Button variant="outline" size="sm" onClick={genToken} className="shrink-0">
                  <KeyRound className="size-4 mr-1.5" />Generate
                </Button>
                <Button variant="outline" size="sm" onClick={copyToken} disabled={!shimToken} className="shrink-0" aria-label="Copy token">
                  {copiedToken ? <Check className="size-4 text-green-500" /> : <Copy className="size-4" />}
                </Button>
              </div>
              {shimTokenSet && !shimToken && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Check className="size-3.5 text-green-500" />A token is already set — leave blank to keep it.
                </p>
              )}
              {shimToken && (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  Keep a copy — it isn't shown again after you leave this page.
                </p>
              )}
            </CardContent>
          </Card>

          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin mr-1.5" /> : null}Save
            </Button>
            <Button variant="outline" onClick={runTest} disabled={testing}>
              {testing ? <Loader2 className="size-4 animate-spin mr-1.5" /> : null}Test connection
            </Button>
            {test && (
              <div className="flex items-center gap-3 text-xs">
                <span className="flex items-center gap-1">
                  {test.frigate.ok ? <Wifi className="size-3.5 text-green-500" /> : <WifiOff className="size-3.5 text-red-500" />}
                  Frigate {test.frigate.ok ? `ok${test.frigate.version ? ` (v${test.frigate.version})` : ''}` : (test.frigate.error ?? 'unreachable')}
                </span>
                <span className="flex items-center gap-1">
                  {test.mqtt.connected ? <Wifi className="size-3.5 text-green-500" /> : <WifiOff className="size-3.5 text-amber-500" />}
                  MQTT {test.mqtt.connected ? 'connected' : (test.mqtt.configured ? 'connecting…' : 'not set')}
                </span>
              </div>
            )}
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle className="text-sm">Paste into Frigate</CardTitle>
                <CardDescription>Your token and this app's address are pre-filled — copy into Frigate's <code>config.yaml</code>.</CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={copyYaml} className="shrink-0">
                {copied ? <Check className="size-4 mr-1.5 text-green-500" /> : <Copy className="size-4 mr-1.5" />}
                {copied ? 'Copied' : 'Copy all'}
              </Button>
            </CardHeader>
            <CardContent>
              <pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto whitespace-pre leading-relaxed">{yaml}</pre>
            </CardContent>
          </Card>
        </>}

        {/* ── Announcements ──────────────────────────────────────── */}
        {tab === 'announcements' && <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Spoken announcements</CardTitle>
              <CardDescription>
                Whether camera events are spoken aloud by the active companion. Events are always logged and notified
                regardless of this setting.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="font-medium">Enable spoken announcements</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Master toggle — off means no TTS for any camera event.</p>
                </div>
                <Switch checked={announceEnabled} onCheckedChange={setAnnounceEnabled} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Cooldown</CardTitle>
              <CardDescription>
                Minimum gap between announcements from the same camera and event type. Prevents repeated alerts during
                extended activity (e.g. someone at the door for 5 minutes).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5">
              <Label>Cooldown per camera (minutes)</Label>
              <div className="flex items-center gap-3">
                <Input
                  type="number" min="0" max="60" step="1"
                  value={cooldownMinutes}
                  onChange={e => setCooldownMinutes(Math.max(0, parseInt(e.target.value) || 0))}
                  className="w-28"
                />
                <span className="text-sm text-muted-foreground">
                  {cooldownMinutes === 0 ? 'No cooldown' : `Once per ${cooldownMinutes} min per camera`}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">What to announce</CardTitle>
              <CardDescription>Which event types the companion speaks aloud.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {announceTypes.map(t => (
                <div key={t} className="flex items-center justify-between">
                  <Label className="font-normal">{ANNOUNCE_LABELS[t] ?? t}</Label>
                  <Switch checked={announce.includes(t)} onCheckedChange={() => toggleAnnounce(t)} disabled={!announceEnabled} />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Known plates</CardTitle>
              <CardDescription>Map plates to friendly names so the companion says "Mom just pulled up". One per line: <code>PLATE = Name</code>.</CardDescription>
            </CardHeader>
            <CardContent>
              <textarea
                className="w-full min-h-24 rounded-md border bg-transparent px-3 py-2 text-sm font-mono"
                placeholder={"ABC1234 = Mom's car\nXYZ7890 = Dad's truck"}
                value={platesText}
                onChange={e => setPlatesText(e.target.value)}
              />
            </CardContent>
          </Card>

          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin mr-1.5" /> : null}Save
          </Button>
        </>}

        {/* ── Plate Log ──────────────────────────────────────────── */}
        {tab === 'plates' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">All detected license plates, most recent first.</p>
              <Button variant="outline" size="sm" onClick={() => void loadLog('plate')} disabled={loadingLog}>
                {loadingLog ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}Refresh
              </Button>
            </div>
            {loadingLog && plates.length === 0 ? (
              <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
            ) : plates.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <Car className="size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No plates detected yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {plates.map(ev => (
                  <div key={ev.id} className="flex items-center gap-3 px-4 py-3">
                    {ev.snapshotUrl ? (
                      <img src={ev.snapshotUrl} alt="snapshot" className="size-12 rounded object-cover shrink-0 bg-muted" />
                    ) : (
                      <div className="size-12 rounded bg-muted shrink-0 flex items-center justify-center">
                        <Car className="size-5 text-muted-foreground/40" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono font-semibold">{ev.plate ?? '—'}</p>
                      {ev.plateName && <p className="text-xs text-brand">{ev.plateName}</p>}
                      <p className="text-xs text-muted-foreground truncate">
                        {ev.camera?.replace(/[_-]+/g, ' ') ?? 'unknown camera'}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground shrink-0">{timeAgo(ev.createdAt)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Events ─────────────────────────────────────────────── */}
        {tab === 'events' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Recent detections from all cameras, most recent first.</p>
              <Button variant="outline" size="sm" onClick={() => void loadLog()} disabled={loadingLog}>
                {loadingLog ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}Refresh
              </Button>
            </div>
            {loadingLog && events.length === 0 ? (
              <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
            ) : events.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <ListVideo className="size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No events recorded yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {events.map(ev => (
                  <div key={ev.id} className="flex items-center gap-3 px-4 py-2.5">
                    {ev.snapshotUrl ? (
                      <img src={ev.snapshotUrl} alt="snapshot" className="size-10 rounded object-cover shrink-0 bg-muted" />
                    ) : (
                      <div className="size-10 rounded bg-muted shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{ev.title ?? ev.description ?? ev.kind}</p>
                      <p className="text-xs text-muted-foreground">
                        <span className="capitalize">{ev.kind}</span>
                        {ev.camera ? ` · ${ev.camera.replace(/[_-]+/g, ' ')}` : ''}
                        {ev.label ? ` · ${ev.label}` : ''}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground shrink-0">{timeAgo(ev.createdAt)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
