import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Wifi, CheckCircle2, AlertTriangle, Sparkles } from 'lucide-react'
import { GENERIC_DEVICE_IMAGE, DEVICE_MODELS } from '@/lib/deviceCatalog'

// Devices we can build + flash over USB (those with a firmware template). The board
// is auto-identified by its chip; this list is the fallback picker / override.
const FLASHABLE = DEVICE_MODELS.filter((m) => m.firmware)
const flashableName = (id: string) => {
  const m = FLASHABLE.find((x) => x.id === id)
  return m ? `${m.make} ${m.model}` : 'device'
}

// Admin → Devices → "Add a device": a friendly, step-by-step setup flow.
// Connect → Wi-Fi → Set up → Done. No jargon, no device picker (the make/model is
// recognized automatically once the device powers on and registers, shown on the
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

// The key stages we surface during setup (Apple-style: a few clear milestones, not
// a wall of log lines). `prepare` is the one-time ESPHome install; the rest mirror
// the flash pipeline (fetch firmware → compile → flash over USB).
type SetupStage = 'prepare' | 'download' | 'build' | 'install'
const SETUP_STAGES: { id: SetupStage; label: string }[] = [
  { id: 'prepare', label: 'Preparing tools' },
  { id: 'download', label: 'Downloading firmware' },
  { id: 'build', label: 'Building firmware' },
  { id: 'install', label: 'Installing on device' },
]
const STAGE_ORDER: SetupStage[] = SETUP_STAGES.map((s) => s.id)

// Best-effort classify a build/flash log line into the stage it belongs to.
function stageFor(line: string): SetupStage | null {
  if (/Connecting\.\.\.|esptool|Uploading|Writing at|Hash of data verified|Flash complete/i.test(line)) return 'install'
  if (/Building .*firmware|Compiling|Generating|Linking|platformio|toolchain|Tool Manager|Library Manager/i.test(line)) return 'build'
  if (/Fetching firmware|Downloading firmware/i.test(line)) return 'download'
  if (/pip install|virtualenv|Installing ESPHome|Resolving Python|Creating Python|Upgrading pip/i.test(line)) return 'prepare'
  return null
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

export function FlashDeviceWizard({ open, onOpenChange, onFlashed, reflash }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onFlashed?: () => void
  // When set, run streamlined "reinstall" mode for an existing device: its model is
  // known and Wi-Fi is already saved, so we skip detection, the Wi-Fi step, and naming.
  reflash?: { name: string; model: string | null } | null
}) {
  const isReflash = !!reflash
  const [status, setStatus] = useState<FirmwareStatus | null>(null)
  const [phase, setPhase] = useState<Phase>('connect')
  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState('Getting your device ready…')
  const [stage, setStage] = useState<SetupStage>('download')
  const [log, setLog] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [error, setError] = useState('')

  // Aborts the in-flight install/flash SSE when the wizard closes; otherwise the fetch
  // keeps streaming, the backend keeps compiling, and it holds the one-flash lock so the
  // next open 409s ("a flash is already in progress").
  const flashAbortRef = useRef<AbortController | null>(null)

  const [ssid, setSsid] = useState('')
  const [password, setPassword] = useState('')
  const [host, setHost] = useState('')
  const [deviceName, setDeviceName] = useState('')
  // Firmware is auto-selected by identifying the plugged-in board (see detect()).
  // `model` is only chosen by hand if detection can't map the chip, or the installer
  // overrides it.
  const [model, setModel] = useState(FLASHABLE[0]?.id ?? 'atom-echo')
  const [detect, setDetect] = useState<{ chip: string; model: string | null } | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [override, setOverride] = useState(false)
  // Which serial port to flash. Only needed when MORE THAN ONE is present (the backend
  // auto-picks when there's exactly one); without this, multiple ports were an
  // unrecoverable "multiple serial ports found" dead-end with no way to choose.
  const [selectedPort, setSelectedPort] = useState('')
  const detectedPortRef = useRef('')

  const logRef = useRef<HTMLDivElement | null>(null)
  const appendLog = useCallback((line: string) => setLog((l) => [...l.slice(-400), line]), [])
  // Only ever move stages forward (log lines can interleave).
  const advanceStage = useCallback((s: SetupStage) => {
    setStage((cur) => (STAGE_ORDER.indexOf(s) > STAGE_ORDER.indexOf(cur) ? s : cur))
  }, [])

  const refetch = useCallback(async () => {
    try {
      const r = await fetch('/api/pod/firmware/status', opts)
      if (r.ok) {
        const s = (await r.json()) as FirmwareStatus
        setStatus(s)
        setHost((h) => h || s.serverHost)
        // Pre-fill the saved Wi-Fi network so the user can confirm/change it (the
        // password is never returned, so it stays blank = "keep what's saved").
        setSsid((cur) => cur || s.wifiSsid)
        return s
      }
    } catch { /* ignore */ }
    return null
  }, [])

  // Default the port choice to the first when several are present (so the flash body
  // always carries a concrete port); clear it when there's 0–1 (backend auto-picks).
  useEffect(() => {
    const ports = status?.ports ?? []
    if (ports.length > 1 && !ports.includes(selectedPort)) setSelectedPort(ports[0]!)
    else if (ports.length <= 1 && selectedPort) setSelectedPort('')
  }, [status?.ports, selectedPort])

  // Abort any in-flight install/flash stream when the wizard closes or unmounts, so it
  // releases the backend's one-flash lock (otherwise the next open 409s).
  useEffect(() => {
    if (!open) flashAbortRef.current?.abort()
  }, [open])
  useEffect(() => () => flashAbortRef.current?.abort(), [])

  // Reset + load when opened.
  useEffect(() => {
    if (!open) return
    setPhase('connect'); setError(''); setLog([]); setShowLog(false); setBusy(false); setStage('download')
    setDetect(null); setDetecting(false); setOverride(false); detectedPortRef.current = ''
    // Reinstall mode: the device + its firmware are already known, so preset the model
    // and skip auto-detection.
    if (reflash?.model) setModel(reflash.model)
    void refetch()
  }, [open, refetch, reflash])

  // Once a board is plugged in, identify it (reads its ESP chip family) and
  // auto-select the matching firmware so the installer can't pick the wrong one.
  // Re-runs if the connected port changes (a different board swapped in).
  const connectedPort = status?.ports[0] ?? ''
  useEffect(() => {
    if (isReflash || !open || busy || !connectedPort || detectedPortRef.current === connectedPort) return
    detectedPortRef.current = connectedPort
    setDetecting(true)
    ;(async () => {
      try {
        const r = await fetch('/api/pod/firmware/detect', opts)
        if (r.ok) {
          const d = (await r.json()) as { chip: string; model: string | null }
          setDetect(d)
          if (d.model) { setModel(d.model); setOverride(false) }
          else setOverride(true) // couldn't map it → let them choose
        }
      } catch { setOverride(true) } finally { setDetecting(false) }
    })()
  }, [open, busy, connectedPort])

  // Poll for a freshly-plugged device while idle.
  useEffect(() => {
    if (!open || busy) return
    const t = setInterval(() => { void refetch() }, 2500)
    return () => clearInterval(t)
  }, [open, busy, refetch])

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [log])

  const connected = (status?.ports.length ?? 0) > 0

  // Always stop at the Wi-Fi + name step so the installer can confirm/change the
  // network and name the device, even when Wi-Fi was saved on a previous flash
  // (otherwise wrong saved creds silently get baked in with no way to fix them).
  function continueFromConnect() {
    // Reinstall: model known + Wi-Fi already saved → straight to flashing.
    setPhase(isReflash ? 'setup' : 'wifi')
  }

  async function saveWifiAndContinue() {
    if (!ssid.trim()) { setError('Please enter your Wi-Fi network name'); return }
    setBusy(true); setError('')
    try {
      // Keep the saved password when the network is unchanged and the field's blank;
      // only PUT when something actually changed (so we don't wipe a saved password).
      const keepSaved = !!status?.wifiConfigured && !password && ssid.trim() === status.wifiSsid
      if (!keepSaved) {
        const r = await fetch('/api/pod/firmware/wifi', {
          ...opts, method: 'PUT', headers: J,
          body: JSON.stringify({ ssid: ssid.trim(), password, host: host.trim() || undefined }),
        })
        if (!r.ok) throw new Error('Failed to save Wi-Fi')
        await refetch()
      }
      setPhase('setup')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  // Run install (if needed) then flash, all under the friendly "setup" screen.
  const runSetup = useCallback(async () => {
    setBusy(true); setError(''); setLog([]); setStatusMsg('Getting your device ready…')
    flashAbortRef.current?.abort()
    const ac = new AbortController()
    flashAbortRef.current = ac
    try {
      const cur = await refetch()
      if (cur && !cur.esphomeInstalled) {
        setStage('prepare')
        setStatusMsg('Setting things up for the first time… this can take a few minutes.')
        let installErr = ''
        await streamSSE('/api/admin/install/repair', { componentId: 'esphome' }, (ev, d) => {
          if (ev === 'progress' && typeof d.status === 'string') { appendLog(d.status); const f = friendlyFor(d.status); if (f) setStatusMsg(f) }
          else if (ev === 'error') installErr = String(d.error ?? 'Setup failed')
        }, ac.signal)
        if (installErr) { setError('We couldn’t finish the one-time setup. You can try again.'); return }
      }

      setStage('download')
      setStatusMsg('Getting your device’s firmware…')
      // A just-plugged-in (or just-reset) board enumerates its serial port a beat after
      // it appears, so the first flash can fast-fail with a "no device / port" error even
      // though the device is fine. Auto-retry those transient cases a few times (waiting
      // for the port to settle) instead of bouncing the installer to the error screen.
      let flashErr = ''
      let ok = false
      // Transient = worth a silent retry (port settling, a stuck prior flash, a network
      // blip fetching firmware). Connect-fail = the board didn't enter the bootloader
      // (often needs the BOOT button): retry a couple times, then guide the user.
      const TRANSIENT = /device|port|plug|in progress|409|resource busy|could not open|firmware|download|network|ENOTFOUND|ETIMEDOUT|timed out/i
      const CONNECT_FAIL = /failed to connect|wrong boot mode|no serial data received|timed out waiting for packet|chip stopped|md5/i
      const retryable = (e: string) => TRANSIENT.test(e) || CONNECT_FAIL.test(e)
      const MAX_TRIES = 4
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        flashErr = ''
        try {
          await streamSSE('/api/pod/firmware/flash', { name: deviceName || undefined, model, port: selectedPort || undefined }, (ev, d) => {
            if (ev === 'log' && typeof d.line === 'string') {
              appendLog(d.line)
              const st = stageFor(d.line); if (st) advanceStage(st)
              const f = friendlyFor(d.line); if (f) setStatusMsg(f)
            }
            else if (ev === 'error') flashErr = String(d.error ?? 'Setup failed')
            else if (ev === 'done') ok = true
          }, ac.signal)
        } catch (e) {
          if (ac.signal.aborted) return            // wizard closed mid-flash: stop quietly
          flashErr = e instanceof Error ? e.message : String(e)
        }
        if (ok || !flashErr || !retryable(flashErr) || attempt === MAX_TRIES) break
        appendLog(`[retry ${attempt}/${MAX_TRIES - 1}] ${flashErr}`)
        setStatusMsg('Waiting for your device to connect…')
        await new Promise((r) => setTimeout(r, 2500))
        await refetch()
      }
      if (flashErr) {
        setError(
          CONNECT_FAIL.test(flashErr)
            ? 'Couldn’t talk to your device. Unplug it, hold its BOOT button, plug it back in (keep holding for a second), then Try again.'
            : /permission denied|resource busy|could not open/i.test(flashErr)
              ? 'The USB port is busy. Unplug the device, wait a few seconds, plug it back in, then Try again.'
              : /device|port|plug/i.test(flashErr)
                ? 'We lost track of your device. Make sure it’s plugged in, then try again.'
                : `Setup failed: ${flashErr}`, // show the REAL error, not a vague sentence
        )
        return
      }
      if (ok) {
        setPhase('done')
        // Tell the parent to start refreshing now: the device will announce itself
        // for Claim within seconds of powering up, so don't wait on the next poll.
        onFlashed?.()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }, [appendLog, advanceStage, deviceName, model, selectedPort, onFlashed, refetch])

  // Kick off setup automatically when we reach that screen, exactly once
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

  const steps = isReflash ? ['Connect', 'Update'] : ['Connect', 'Wi-Fi', 'Set up']
  const stepIndex = phase === 'connect' ? 0 : phase === 'wifi' ? 1 : steps.length - 1

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-center">{isReflash ? `Reinstall ${reflash?.name ?? 'device'}` : 'Add a device'}</DialogTitle>
        </DialogHeader>

        {/* Step dots */}
        {phase !== 'done' && (
          <div className="flex items-center justify-center gap-2">
            {steps.map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <span className={`flex items-center gap-1.5 text-xs ${i === stepIndex ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                  <span className={`size-1.5 rounded-full ${i < stepIndex ? 'bg-success' : i === stepIndex ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
                  {label}
                </span>
                {i < steps.length - 1 && <span className="text-muted-foreground/40">—</span>}
              </div>
            ))}
          </div>
        )}

        {/* ── Connect ── */}
        {phase === 'connect' && (
          <div className="flex flex-col items-center gap-4 px-2 py-3 text-center">
            <DeviceHero />
            <div>
              <p className="text-base font-semibold">{isReflash ? `Reinstall ${reflash?.name ?? 'your device'}` : 'Let’s set up your device'}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {isReflash
                  ? 'Plug it into this computer to reinstall its software. Your Wi-Fi, companion and settings are kept.'
                  : 'Plug it into this computer with a USB cable to begin.'}
              </p>
            </div>
            {/* Connection + auto-identification status. An unflashed board can't
                announce itself, so we read its chip over USB and pick the matching
                firmware automatically (no chance to choose the wrong one). Reinstall
                already knows the device, so it just checks it's plugged in. */}
            <div className={`flex w-full items-center justify-center gap-2 rounded-card px-3 py-2.5 text-sm font-medium ${
              connected ? 'bg-success/10 text-success' : 'bg-muted/60 text-muted-foreground'}`}>
              {!connected
                ? <><Spinner className="size-4" /> Looking for your device…</>
                : isReflash
                  ? <><CheckCircle2 className="size-4" /> Found your device!</>
                  : detecting
                    ? <><Spinner className="size-4" /> Identifying your device…</>
                    : detect?.model
                      ? <><CheckCircle2 className="size-4" /> {`Found your ${flashableName(detect.model)}!`}</>
                      : <><CheckCircle2 className="size-4" /> Found your device!</>}
            </div>

            {/* More than one USB serial device → let the installer pick which to flash
                (otherwise it's an unrecoverable "multiple serial ports" error). */}
            {(status?.ports.length ?? 0) > 1 && (
              <div className="w-full text-left">
                <p className="mb-1 text-xs font-medium text-muted-foreground">Multiple devices are plugged in — pick the one to flash:</p>
                <select
                  value={selectedPort}
                  onChange={(e) => setSelectedPort(e.target.value)}
                  className="h-9 w-full rounded-control border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {(status?.ports ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            )}

            {/* Auto-detected → show what we'll flash + a quiet override. Couldn't map
                the chip → fall back to a manual picker. (New device only.) */}
            {!isReflash && connected && !detecting && (
              (override || !detect?.model) ? (
                <div className="w-full text-left">
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    {detect && !detect.model
                      ? 'We couldn’t identify it automatically — pick your device:'
                      : 'Choose your device:'}
                  </p>
                  <div className="grid gap-2">
                    {FLASHABLE.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setModel(m.id)}
                        className={`flex items-center gap-3 rounded-card border px-3 py-2 text-left transition-colors ${
                          model === m.id ? 'border-primary bg-primary/5' : 'border-border/60 hover:border-border'}`}
                      >
                        <m.icon className="size-5 shrink-0 text-muted-foreground" />
                        <span className="flex-1">
                          <span className="block text-sm font-medium">{m.make} {m.model}</span>
                          <span className="block text-xs text-muted-foreground">{m.tagline}</span>
                        </span>
                        {model === m.id && <CheckCircle2 className="size-4 text-primary" />}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setOverride(true)}
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Not a {flashableName(model)}? Choose manually
                </button>
              )
            )}

            <Button className="w-full" disabled={!connected || detecting} onClick={continueFromConnect}>Continue</Button>
          </div>
        )}

        {/* ── Wi-Fi ── */}
        {phase === 'wifi' && (
          <div className="flex flex-col gap-3 px-2 py-2">
            <div className="text-center">
              <p className="text-base font-semibold">{status?.wifiConfigured ? 'Confirm your Wi-Fi' : 'Connect it to your Wi-Fi'}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {status?.wifiConfigured
                  ? 'This gets baked into the device. Change the network here if it’s wrong.'
                  : 'Your device uses this to reach Loki Doki. You only set it once.'}
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-control border px-3">
              <Wifi className="size-4 text-muted-foreground" />
              <Input className="border-0 px-1 focus-visible:ring-0" placeholder="Wi-Fi network name" value={ssid} onChange={(e) => setSsid(e.target.value)} autoFocus />
            </div>
            <Input type="password" placeholder={status?.wifiConfigured ? 'Wi-Fi password (leave blank to keep saved)' : 'Wi-Fi password'} value={password} onChange={(e) => setPassword(e.target.value)} />
            <Input placeholder="Name this device (optional, e.g. Kitchen)" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Advanced</summary>
              <Input className="mt-1" placeholder="Server address" value={host} onChange={(e) => setHost(e.target.value)} />
            </details>
            <div className="flex gap-2 pt-1">
              <Button variant="ghost" onClick={() => setPhase('connect')} disabled={busy}>Back</Button>
              <Button className="flex-1" onClick={saveWifiAndContinue} disabled={busy || !ssid.trim()}>
                {busy ? <Spinner className="size-4" /> : 'Continue'}
              </Button>
            </div>
          </div>
        )}

        {/* ── Set up (install + flash) — key stages, Apple-style ── */}
        {phase === 'setup' && (
          <div className="flex flex-col items-center gap-5 px-2 py-4">
            {!error ? (
              <>
                <div className="text-center">
                  <p className="text-base font-semibold">{isReflash ? 'Reinstalling software' : 'Setting up your device'}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{statusMsg}</p>
                </div>
                <StageList stage={stage} />
                <p className="text-center text-xs text-muted-foreground">
                  Keep your device plugged in — this can take a minute or two.
                </p>
              </>
            ) : (
              <div className="flex flex-col items-center gap-4 py-2 text-center">
                <span className="grid size-12 place-items-center rounded-full bg-destructive/10 text-destructive">
                  <AlertTriangle className="size-6" />
                </span>
                <div>
                  <p className="text-base font-semibold">Hmm, that didn’t work</p>
                  <p className="mt-1 text-sm text-muted-foreground">{error}</p>
                </div>
                <Button onClick={() => { setError(''); void runSetup() }}>Try again</Button>
              </div>
            )}
          </div>
        )}

        {/* ── Done ── */}
        {phase === 'done' && (
          <div className="flex flex-col items-center gap-4 px-2 py-4 text-center">
            <DeviceHero done />
            <div>
              <p className="text-base font-semibold">All set! <Sparkles className="inline size-4 text-brand" /></p>
              <p className="mt-1 text-sm text-muted-foreground">
                {isReflash
                  ? 'All updated. Unplug it and put it back — it’ll reconnect on its own in a moment.'
                  : 'Unplug your device and put it wherever you like. It’ll connect on its own and pop up here in a moment to finish.'}
              </p>
            </div>
            <Button className="w-full" onClick={() => onOpenChange(false)}>Done</Button>
          </div>
        )}

        {/* Technical details (collapsed). min-w-0 lets this grid item shrink below its
            content width so a long, space-less log line wraps instead of widening the
            whole dialog; break-all wraps those unbreakable tokens inside the fixed box. */}
        {log.length > 0 && (
          <div className="min-w-0 px-2">
            <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShowLog((v) => !v)}>
              {showLog ? 'Hide details' : 'Show details'}
            </button>
            {showLog && (
              <div ref={logRef} className="mt-1 max-h-32 w-full overflow-auto rounded-card bg-black/90 p-2 font-mono text-[10px] leading-relaxed text-success/90">
                {log.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all">{l}</div>)}
              </div>
            )}
          </div>
        )}

        {error && phase !== 'setup' && (
          <p className="flex items-start gap-2 rounded-card bg-destructive/10 px-3 py-2 text-xs text-destructive">
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

// The key-stages checklist shown while a device is being set up. Each stage is
// done / in-progress / pending — a calm, legible alternative to a scrolling log.
function StageList({ stage }: { stage: SetupStage }) {
  const active = STAGE_ORDER.indexOf(stage)
  return (
    <div className="w-full max-w-xs space-y-1">
      {SETUP_STAGES.map((s, i) => {
        const state = i < active ? 'done' : i === active ? 'active' : 'pending'
        return (
          <div
            key={s.id}
            className={`flex items-center gap-3 rounded-control px-3 py-2.5 transition-colors ${
              state === 'active' ? 'bg-primary/5' : ''}`}
          >
            <span className="grid size-5 shrink-0 place-items-center">
              {state === 'done' ? (
                <CheckCircle2 className="size-5 text-success" />
              ) : state === 'active' ? (
                <Spinner className="size-4" />
              ) : (
                <span className="size-2 rounded-full bg-muted-foreground/30" />
              )}
            </span>
            <span className={`text-sm ${
              state === 'pending' ? 'text-muted-foreground/60'
                : state === 'active' ? 'font-medium text-foreground' : 'text-foreground'}`}>
              {s.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// Friendly device illustration used across the wizard screens.
function DeviceHero({ pulsing, done }: { pulsing?: boolean; done?: boolean }) {
  return (
    <div className="relative">
      {done && <span className="absolute -right-1 -top-1 z-10 grid size-7 place-items-center rounded-full bg-success text-white shadow"><CheckCircle2 className="size-4" /></span>}
      {/* design-ok(adhoc-pulse): connecting-in-progress illustration glow, same intent as BootScreen's repair-in-progress icon pulse */}
      <div className={`grid size-28 place-items-center rounded-sheet bg-gradient-to-br from-muted/70 to-muted/20 ${pulsing ? 'animate-pulse' : ''}`}>
        <img src={GENERIC_DEVICE_IMAGE} alt="" className="size-20" />
      </div>
    </div>
  )
}
