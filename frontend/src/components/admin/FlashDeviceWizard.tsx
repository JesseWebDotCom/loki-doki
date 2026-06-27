import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, Wifi, CheckCircle2, AlertTriangle, Sparkles } from 'lucide-react'
import { GENERIC_DEVICE_IMAGE } from '@/lib/deviceCatalog'

// Admin → Devices → "Add a device": a friendly, step-by-step setup flow.
// Connect → Wi-Fi → Set up → Done. No jargon, no device picker (the make/model is
// recognized automatically once the device powers on and registers — shown on the
// card afterward). The technical build log is tucked behind "Show details".

interface FirmwareStatus {
  esphomeInstalled: boolean
  wifiConfigured: boolean
  wifiSsid: string
  serverHost: string
  ports: string[]
}

type Phase = 'connect' | 'wifi' | 'setup' | 'done'

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

async function streamSSE(
  url: string,
  body: unknown,
  onEvent: (event: string, data: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { ...opts, method: 'POST', headers: J, body: JSON.stringify(body), signal })
  if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let event = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) {
        const raw = line.slice(5).trim()
        if (!raw) continue
        try { onEvent(event, JSON.parse(raw)) } catch { /* malformed frame */ }
      }
    }
  }
}

// Map a raw build/flash log line to a friendly status sentence (best-effort).
function friendlyFor(line: string): string | null {
  if (/pip install|virtualenv|Installing ESPHome|Resolving Python/i.test(line)) return 'Setting things up for the first time…'
  if (/Downloading|Unpacking|platformio|toolchain|Tool Manager|Library Manager/i.test(line)) return 'Getting the tools ready (first time only)…'
  if (/Compiling|Generating|Linking|Building/i.test(line)) return 'Building your device’s software…'
  if (/Connecting\.\.\.|Chip is|Uploading|esptool|Writing at|Hash of data verified/i.test(line)) return 'Installing it on your device…'
  if (/Successfully created|SUCCESS|Flash complete/i.test(line)) return 'Almost done…'
  return null
}

export function FlashDeviceWizard({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [status, setStatus] = useState<FirmwareStatus | null>(null)
  const [phase, setPhase] = useState<Phase>('connect')
  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState('Getting your device ready…')
  const [log, setLog] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [error, setError] = useState('')

  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [host, setHost] = useState('')
  const [deviceName, setDeviceName] = useState('')

  const logRef = useRef<HTMLDivElement | null>(null)
  const appendLog = useCallback((line: string) => setLog((l) => [...l.slice(-400), line]), [])

  const refetch = useCallback(async () => {
    try {
      const r = await fetch('/api/pod/firmware/status', opts)
      if (r.ok) {
        const s = (await r.json()) as FirmwareStatus
        setStatus(s)
        setHost((h) => h || s.serverHost)
        return s
      }
    } catch { /* ignore */ }
    return null
  }, [])

  // Reset + load when opened.
  useEffect(() => {
    if (!open) return
    setPhase('connect'); setError(''); setLog([]); setShowLog(false); setBusy(false)
    void refetch()
  }, [open, refetch])

  // Poll for a freshly-plugged device while idle.
  useEffect(() => {
    if (!open || busy) return
    const t = setInterval(() => { void refetch() }, 2500)
    return () => clearInterval(t)
  }, [open, busy, refetch])

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [log])

  const connected = (status?.ports.length ?? 0) > 0

  function continueFromConnect() {
    if (status?.wifiConfigured) setPhase('setup')
    else setPhase('wifi')
  }

  async function saveWifiAndContinue() {
    if (!ssid.trim()) { setError('Please enter your Wi-Fi network name'); return }
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/pod/firmware/wifi', {
        ...opts, method: 'PUT', headers: J,
        body: JSON.stringify({ ssid: ssid.trim(), password, host: host.trim() || undefined }),
      })
      if (!r.ok) throw new Error('Failed to save Wi-Fi')
      await refetch()
      setPhase('setup')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  // Run install (if needed) then flash — all under the friendly "setup" screen.
  const runSetup = useCallback(async () => {
    setBusy(true); setError(''); setLog([]); setStatusMsg('Getting your device ready…')
    try {
      const cur = await refetch()
      if (cur && !cur.esphomeInstalled) {
        setStatusMsg('Setting things up for the first time… this can take a few minutes.')
        let installErr = ''
        await streamSSE('/api/admin/install/repair', { componentId: 'esphome' }, (ev, d) => {
          if (ev === 'progress' && typeof d.status === 'string') { appendLog(d.status); const f = friendlyFor(d.status); if (f) setStatusMsg(f) }
          else if (ev === 'error') installErr = String(d.error ?? 'Setup failed')
        })
        if (installErr) { setError('We couldn’t finish the one-time setup. You can try again.'); return }
      }

      setStatusMsg('Building your device’s software…')
      let flashErr = ''
      let ok = false
      await streamSSE('/api/pod/firmware/flash', { name: deviceName || undefined }, (ev, d) => {
        if (ev === 'log' && typeof d.line === 'string') { appendLog(d.line); const f = friendlyFor(d.line); if (f) setStatusMsg(f) }
        else if (ev === 'error') flashErr = String(d.error ?? 'Setup failed')
        else if (ev === 'done') ok = true
      })
      if (flashErr) {
        setError(/device|port|plug/i.test(flashErr)
          ? 'We lost track of your device. Make sure it’s plugged in, then try again.'
          : 'Something went wrong while setting up your device. You can try again.')
        return
      }
      if (ok) setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }, [appendLog, deviceName, refetch])

  // Kick off setup automatically when we reach that screen — exactly once
  // (a ref guard survives React StrictMode's double-effect in dev).
  const setupStartedRef = useRef(false)
  useEffect(() => {
    if (!open) { setupStartedRef.current = false; return }
    if (phase === 'setup' && !setupStartedRef.current) {
      setupStartedRef.current = true
      void runSetup()
    }
    if (phase !== 'setup') setupStartedRef.current = false
  }, [open, phase, runSetup])

  const stepIndex = phase === 'connect' ? 0 : phase === 'wifi' ? 1 : 2

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-center">Add a device</DialogTitle>
        </DialogHeader>

        {/* Step dots */}
        {phase !== 'done' && (
          <div className="flex items-center justify-center gap-2">
            {['Connect', 'Wi-Fi', 'Set up'].map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <span className={`flex items-center gap-1.5 text-xs ${i === stepIndex ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                  <span className={`size-1.5 rounded-full ${i < stepIndex ? 'bg-emerald-500' : i === stepIndex ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
                  {label}
                </span>
                {i < 2 && <span className="text-muted-foreground/40">—</span>}
              </div>
            ))}
          </div>
        )}

        {/* ── Connect ── */}
        {phase === 'connect' && (
          <div className="flex flex-col items-center gap-4 px-2 py-3 text-center">
            <DeviceHero />
            <div>
              <p className="text-base font-semibold">Let’s set up your device</p>
              <p className="mt-1 text-sm text-muted-foreground">Plug it into this computer with a USB cable to begin.</p>
            </div>
            <div className={`flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium ${
              connected ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted/60 text-muted-foreground'}`}>
              {connected
                ? <><CheckCircle2 className="size-4" /> Found your device!</>
                : <><Loader2 className="size-4 animate-spin" /> Looking for your device…</>}
            </div>
            <Button className="w-full" disabled={!connected} onClick={continueFromConnect}>Continue</Button>
          </div>
        )}

        {/* ── Wi-Fi ── */}
        {phase === 'wifi' && (
          <div className="flex flex-col gap-3 px-2 py-2">
            <div className="text-center">
              <p className="text-base font-semibold">Connect it to your Wi-Fi</p>
              <p className="mt-1 text-sm text-muted-foreground">Your device uses this to reach LokiDoki. You only set it once.</p>
            </div>
            <div className="flex items-center gap-2 rounded-lg border px-3">
              <Wifi className="size-4 text-muted-foreground" />
              <Input className="border-0 px-1 focus-visible:ring-0" placeholder="Wi-Fi network name" value={ssid} onChange={(e) => setSsid(e.target.value)} autoFocus />
            </div>
            <Input type="password" placeholder="Wi-Fi password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Input placeholder="Name this device (optional, e.g. Kitchen)" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Advanced</summary>
              <Input className="mt-1" placeholder="Server address" value={host} onChange={(e) => setHost(e.target.value)} />
            </details>
            <div className="flex gap-2 pt-1">
              <Button variant="ghost" onClick={() => setPhase('connect')} disabled={busy}>Back</Button>
              <Button className="flex-1" onClick={saveWifiAndContinue} disabled={busy || !ssid.trim()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : 'Continue'}
              </Button>
            </div>
          </div>
        )}

        {/* ── Set up (install + flash) ── */}
        {phase === 'setup' && (
          <div className="flex flex-col items-center gap-4 px-2 py-4 text-center">
            <DeviceHero pulsing={!error} />
            {!error ? (
              <>
                <div>
                  <p className="text-base font-semibold">Getting your device ready</p>
                  <p className="mt-1 text-sm text-muted-foreground">{statusMsg}</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Keep your device plugged in — this can take a minute or two.
                </div>
              </>
            ) : (
              <>
                <div>
                  <p className="text-base font-semibold">Hmm, that didn’t work</p>
                  <p className="mt-1 text-sm text-muted-foreground">{error}</p>
                </div>
                <Button onClick={() => { setError(''); void runSetup() }}>Try again</Button>
              </>
            )}
          </div>
        )}

        {/* ── Done ── */}
        {phase === 'done' && (
          <div className="flex flex-col items-center gap-4 px-2 py-4 text-center">
            <DeviceHero done />
            <div>
              <p className="text-base font-semibold">All set! <Sparkles className="inline size-4 text-amber-400" /></p>
              <p className="mt-1 text-sm text-muted-foreground">
                Unplug your device and put it wherever you like. It’ll connect on its own and pop up here in a moment to finish.
              </p>
            </div>
            <Button className="w-full" onClick={() => onOpenChange(false)}>Done</Button>
          </div>
        )}

        {/* Technical details (collapsed) */}
        {log.length > 0 && (
          <div className="px-2">
            <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShowLog((v) => !v)}>
              {showLog ? 'Hide details' : 'Show details'}
            </button>
            {showLog && (
              <div ref={logRef} className="mt-1 max-h-32 overflow-auto rounded-lg bg-black/90 p-2 font-mono text-[10px] leading-relaxed text-emerald-200/90">
                {log.map((l, i) => <div key={i} className="whitespace-pre-wrap break-words">{l}</div>)}
              </div>
            )}
          </div>
        )}

        {error && phase !== 'setup' && (
          <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {error}
          </p>
        )}

        {phase === 'connect' && (
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Friendly device illustration used across the wizard screens.
function DeviceHero({ pulsing, done }: { pulsing?: boolean; done?: boolean }) {
  return (
    <div className="relative">
      {done && <span className="absolute -right-1 -top-1 z-10 grid size-7 place-items-center rounded-full bg-emerald-500 text-white shadow"><CheckCircle2 className="size-4" /></span>}
      <div className={`grid size-28 place-items-center rounded-3xl bg-gradient-to-br from-muted/70 to-muted/20 ${pulsing ? 'animate-pulse' : ''}`}>
        <img src={GENERIC_DEVICE_IMAGE} alt="" className="size-20" />
      </div>
    </div>
  )
}
