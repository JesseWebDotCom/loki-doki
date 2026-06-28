// Admin → Integrations → Frigate. Connection settings (Frigate base URL, MQTT
// broker, shim token), announce preferences, known plates, a connection test, and
// the copy-paste Frigate genai config block. Remote-first: every address is the
// remote Frigate box, nothing is assumed to be localhost.

import { useEffect, useState } from 'react'
import { Loader2, Camera, Copy, Check, KeyRound, Wifi, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { toast } from '@/lib/toast'
import {
  getFrigateConfig, saveFrigateConfig, testFrigate,
  type FrigateConfig, type FrigateTestResult,
} from '@/lib/frigate/api'

const ANNOUNCE_LABELS: Record<string, string> = {
  person: 'Person detected',
  delivery: 'Delivery vehicle (FedEx, UPS, Amazon…)',
  plate: 'Recognized license plate',
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

export function AdminFrigateTab() {
  const [cfg, setCfg] = useState<FrigateConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<FrigateTestResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedToken, setCopiedToken] = useState(false)

  // editable fields
  const [baseUrl, setBaseUrl] = useState('')
  const [mqttHost, setMqttHost] = useState('')
  const [mqttPort, setMqttPort] = useState('1883')
  const [mqttUsername, setMqttUsername] = useState('')
  const [mqttPassword, setMqttPassword] = useState('')
  const [shimToken, setShimToken] = useState('')      // shown only right after generation
  const [shimTokenSet, setShimTokenSet] = useState(false)
  const [announce, setAnnounce] = useState<string[]>([])
  const [platesText, setPlatesText] = useState('')
  const [enabled, setEnabled] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const c = await getFrigateConfig()
      setCfg(c)
      setBaseUrl(c.baseUrl); setMqttHost(c.mqttHost); setMqttPort(String(c.mqttPort))
      setMqttUsername(c.mqttUsername); setAnnounce(c.announce); setEnabled(c.enabled)
      setShimTokenSet(c.shimTokenSet); setPlatesText(platesToText(c.knownPlates))
    } catch { toast.error('Failed to load Frigate config') } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  async function save() {
    setSaving(true)
    try {
      await saveFrigateConfig({
        enabled, baseUrl, mqttHost, mqttPort: Number(mqttPort),
        mqttUsername, announce, knownPlates: textToPlates(platesText),
        ...(mqttPassword ? { mqttPassword } : {}),
        ...(shimToken ? { shimToken } : {}),
      })
      toast.success('Saved')
      setMqttPassword(''); setShimToken('')
      await load()
    } catch { toast.error('Failed to save') } finally { setSaving(false) }
  }

  // Generate client-side (crypto.getRandomValues works even on a plain-HTTP LAN,
  // unlike crypto.randomUUID). It's persisted when you hit Save — same as a pasted one.
  function genToken() {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    const t = 'fg_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    setShimToken(t)
    toast.success('Token generated — click Save to store it')
  }

  async function runTest() {
    setTesting(true)
    try { setTest(await testFrigate()) } catch { toast.error('Test failed') } finally { setTesting(false) }
  }

  const shimBaseUrl = cfg?.shimBaseUrl || 'http://<this-app-ip>:3000/api/frigate/v1'
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
      objects: [person, car]      # which tracked objects to describe
      # Optional — customise the prompts the companion gets:
      # prompt: "Describe the {label} in this scene."
      # object_prompts:
      #   person: "Describe the person: clothing, and what they're doing."`

  function copyYaml() {
    void navigator.clipboard.writeText(yaml).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }

  function copyToken() {
    if (!shimToken) return
    void navigator.clipboard.writeText(shimToken).then(() => { setCopiedToken(true); setTimeout(() => setCopiedToken(false), 1500) })
  }

  function toggleAnnounce(t: string) {
    setAnnounce((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])
  }

  if (loading) return <div className="flex items-center justify-center p-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>

  const announceTypes = cfg?.allAnnounceTypes ?? ['person', 'delivery', 'plate', 'suspicious']

  return (
    <div className="space-y-5 p-5 max-w-3xl">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-muted p-2"><Camera className="size-5 text-muted-foreground" /></div>
        <div className="flex-1">
          <h2 className="text-base font-semibold">Frigate NVR</h2>
          <p className="text-sm text-muted-foreground">
            Use this app's local vision model as Frigate's GenAI provider, and turn camera events
            (people, delivery vehicles, plates, suspicious activity) into notifications and companion announcements.
            Your Frigate runs remotely — all addresses below point at it over the LAN.
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable Frigate" />
      </div>

      {/* Connection */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Connection</CardTitle>
          <CardDescription>Where your Frigate box lives.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Frigate URL</Label>
            <Input placeholder="http://192.168.1.50:5000" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <p className="text-xs text-muted-foreground">Used to fetch event snapshots/clips and to verify the connection.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>MQTT broker host</Label>
              <Input placeholder="192.168.1.50" value={mqttHost} onChange={(e) => setMqttHost(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>MQTT port</Label>
              <Input placeholder="1883" value={mqttPort} onChange={(e) => setMqttPort(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>MQTT username <span className="text-muted-foreground">(optional)</span></Label>
              <Input value={mqttUsername} onChange={(e) => setMqttUsername(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>MQTT password {cfg?.mqttPasswordSet && <span className="text-muted-foreground">(set — leave blank to keep)</span>}</Label>
              <Input type="password" placeholder={cfg?.mqttPasswordSet ? '••••••••' : ''} value={mqttPassword} onChange={(e) => setMqttPassword(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Shim token */}
      <Card>
        <CardHeader><CardTitle className="text-sm">GenAI shim token</CardTitle>
          <CardDescription>
            A password Frigate sends (as its <code>genai.api_key</code>) so only it can use this app's vision model.
            <span className="font-medium"> Generate</span> a new one, or <span className="font-medium">paste a token you already
            have in Frigate</span> — handy when you reinstall this app and want to keep your existing Frigate config working.
            Either way, click <span className="font-medium">Save</span> to store it.
          </CardDescription></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={shimToken}
              onChange={(e) => setShimToken(e.target.value)}
              placeholder={shimTokenSet ? '•••••• — a token is set; paste or generate to replace' : 'fg_…  paste your existing token, or generate →'}
              className="font-mono text-xs"
            />
            <Button variant="outline" size="sm" onClick={genToken} className="shrink-0"><KeyRound className="size-4 mr-1.5" />Generate</Button>
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
              Keep a copy (it's also in your Frigate config) — for security it isn't shown again after you leave this page.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Announce prefs */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Speak aloud</CardTitle>
          <CardDescription>Which events the companion announces. Everything is still stored and notified.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {announceTypes.map((t) => (
            <div key={t} className="flex items-center justify-between">
              <Label className="font-normal">{ANNOUNCE_LABELS[t] ?? t}</Label>
              <Switch checked={announce.includes(t)} onCheckedChange={() => toggleAnnounce(t)} />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Known plates */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Known plates</CardTitle>
          <CardDescription>Map plates to names so the companion says "Mom just pulled up". One per line: <code>PLATE = Name</code>.</CardDescription></CardHeader>
        <CardContent>
          <textarea
            className="w-full min-h-24 rounded-md border bg-transparent px-3 py-2 text-sm font-mono"
            placeholder={'ABC1234 = Mom\'s car\nXYZ7890 = Dad\'s truck'}
            value={platesText}
            onChange={(e) => setPlatesText(e.target.value)}
          />
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="size-4 animate-spin mr-1.5" /> : null}Save</Button>
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

      {/* Frigate config block */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div><CardTitle className="text-sm">Paste into Frigate</CardTitle>
            <CardDescription>Your token and this app's address are already filled in — copy the whole block into Frigate's <code>config.yaml</code>.</CardDescription></div>
          <Button variant="ghost" size="sm" onClick={copyYaml} className="shrink-0">{copied ? <Check className="size-4 mr-1.5 text-green-500" /> : <Copy className="size-4 mr-1.5" />}{copied ? 'Copied' : 'Copy all'}</Button>
        </CardHeader>
        <CardContent>
          <pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto whitespace-pre leading-relaxed">{yaml}</pre>
        </CardContent>
      </Card>
    </div>
  )
}
