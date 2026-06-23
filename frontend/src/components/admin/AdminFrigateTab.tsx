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
  getFrigateConfig, saveFrigateConfig, generateShimToken, testFrigate,
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

  async function genToken() {
    try {
      const t = await generateShimToken()
      setShimToken(t); setShimTokenSet(true)
      toast.success('Token generated — copy it into Frigate')
    } catch { toast.error('Failed to generate token') }
  }

  async function runTest() {
    setTesting(true)
    try { setTest(await testFrigate()) } catch { toast.error('Test failed') } finally { setTesting(false) }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://this-app:PORT'
  const yaml = `genai:
  provider: openai
  api_key: ${shimToken || (shimTokenSet ? '<your-generated-token>' : '<generate-a-token-first>')}
  base_url: ${origin}/api/frigate/v1

cameras:
  front_door:           # repeat per camera
    objects:
      genai:
        enabled: true
        objects: [person, car]`

  function copyYaml() {
    void navigator.clipboard.writeText(yaml).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
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
          <CardDescription>Frigate must send this as its <code>api_key</code>. Generate one, then paste it into Frigate's config.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={genToken}><KeyRound className="size-4 mr-1.5" />Generate token</Button>
            {shimTokenSet && !shimToken && <span className="text-xs text-muted-foreground flex items-center gap-1"><Check className="size-3.5 text-green-500" />A token is set</span>}
          </div>
          {shimToken && (
            <div className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all select-all">{shimToken}</div>
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
            <CardDescription>Add to your Frigate <code>config.yaml</code> (0.18+ supports <code>base_url</code> natively; on 0.17 set <code>OPENAI_BASE_URL</code> env instead).</CardDescription></div>
          <Button variant="ghost" size="sm" onClick={copyYaml}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button>
        </CardHeader>
        <CardContent>
          <pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto whitespace-pre">{yaml}</pre>
        </CardContent>
      </Card>
    </div>
  )
}
