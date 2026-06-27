// Build + flash Pod firmware from the app — the engine behind Admin → Devices →
// "Add a device". Stages the ESPHome template (firmware/atom-echo/), injects the
// home Wi-Fi + this server's address as build-time substitutions, and drives the
// managed ESPHome CLI to compile and flash a device plugged into the SERVER's USB.
//
// Server-side USB flashing (vs browser Web Serial) is deliberate: it needs no
// secure browser context (Web Serial requires https/localhost), so the whole flow
// is one click with nothing for a non-technical user to configure. After flashing,
// the device auto-joins Wi-Fi and announces itself for the one-tap Claim flow
// (lib/pod/pending.ts) — no per-device Wi-Fi step.

import { join, resolve } from 'node:path'
import { existsSync, readdirSync, mkdirSync, cpSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { runEsphome, isESPHomeInstalled } from '@/lib/esphome'

const TEMPLATE_DIR = resolve(import.meta.dir, '../../../../firmware/atom-echo')
const BUILD_ROOT = join(dataDir, 'esphome')
const BUILD_DIR = join(BUILD_ROOT, 'atom-echo')
const CONFIG_NAME = 'atom-echo.yaml'

const WIFI_SSID_KEY = 'pod.wifi_ssid'
const WIFI_PASS_KEY = 'pod.wifi_password'
const HOST_KEY = 'pod.server_host'

const GATEWAY_PORT = process.env.POD_GATEWAY_PORT ?? '10700'

// ── Wi-Fi + server-host settings ───────────────────────────────────────────────

export interface PodWifi { ssid: string; password: string }

export async function getPodWifi(): Promise<PodWifi> {
  const ssid = ((await getAppSetting(WIFI_SSID_KEY)) as string | null) ?? ''
  const password = ((await getAppSetting(WIFI_PASS_KEY)) as string | null) ?? ''
  return { ssid, password }
}

export async function setPodWifi(ssid: string, password: string): Promise<void> {
  await setAppSetting(WIFI_SSID_KEY, ssid)
  await setAppSetting(WIFI_PASS_KEY, password)
}

/** This server's LAN address the device should reach the gateway on. Saved override,
 *  else the first non-internal IPv4 (preferring private ranges). */
export async function getServerHost(): Promise<string> {
  const saved = (await getAppSetting(HOST_KEY)) as string | null
  if (saved && saved.trim()) return saved.trim()
  return detectLanIp() ?? '127.0.0.1'
}

export async function setServerHost(host: string): Promise<void> {
  await setAppSetting(HOST_KEY, host)
}

function detectLanIp(): string | null {
  const ifaces = networkInterfaces()
  const candidates: string[] = []
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      candidates.push(a.address)
    }
  }
  // Prefer private LAN ranges (the device is on the home network).
  const priv = candidates.find((ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip))
  return priv ?? candidates[0] ?? null
}

// ── serial port detection ──────────────────────────────────────────────────────

/** USB-serial devices that look like an ESP32 dev board (CH9102/CP210x/etc.). */
export function detectSerialPorts(): string[] {
  let entries: string[]
  try { entries = readdirSync('/dev') } catch { return [] }
  const out: string[] = []
  for (const name of entries) {
    // macOS callout devices and common Linux USB-UART nodes.
    if (/^cu\.(usbserial|wchusbserial|usbmodem|SLAB_USBtoUART)/i.test(name)) out.push(join('/dev', name))
    else if (/^ttyUSB\d+$/.test(name) || /^ttyACM\d+$/.test(name)) out.push(join('/dev', name))
  }
  return out.sort()
}

// ── flash state machine (one build/flash at a time) ────────────────────────────

export type FlashState = 'idle' | 'staging' | 'compiling' | 'flashing' | 'done' | 'failed'
const flash = { state: 'idle' as FlashState, error: '' }
export function getFlashState(): FlashState { return flash.state }
export function getFlashError(): string { return flash.error }
export function isFlashBusy(): boolean {
  return flash.state === 'staging' || flash.state === 'compiling' || flash.state === 'flashing'
}

// ── staging ────────────────────────────────────────────────────────────────────

/** Copy the read-only template into a writable build dir (ESPHome writes .esphome/ there). */
function stageTemplate(): void {
  if (!existsSync(TEMPLATE_DIR)) throw new Error(`firmware template missing at ${TEMPLATE_DIR}`)
  mkdirSync(BUILD_ROOT, { recursive: true })
  // Refresh the config + component each build so template edits always take effect;
  // leave any existing .esphome/ build cache in place for fast rebuilds.
  cpSync(TEMPLATE_DIR, BUILD_DIR, {
    recursive: true,
    filter: (src) => !src.includes(`${BUILD_DIR}/.esphome`),
  })
}

function subsArgs(opts: { ssid: string; password: string; host: string; name?: string }): string[] {
  const args = [
    '-s', 'wifi_ssid', opts.ssid,
    '-s', 'wifi_password', opts.password,
    '-s', 'lokidoki_host', opts.host,
    '-s', 'lokidoki_port', GATEWAY_PORT,
  ]
  // ESPHome node names must be lowercase [a-z0-9-]; sanitize a friendly name.
  if (opts.name) {
    const clean = opts.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
    if (clean) args.push('-s', 'name', clean)
  }
  return args
}

// ── warm-up (pre-download the PlatformIO/ESP32 toolchain) ──────────────────────

/**
 * Compile the template once with placeholder creds so ESPHome's first toolchain
 * download (~1 GB under ~/.platformio) happens at install time, not on the user's
 * first real flash. Best-effort: callers should not fail install if this throws.
 */
export async function warmUpToolchain(onLine: (l: string) => void = () => {}, signal?: AbortSignal): Promise<void> {
  if (!isESPHomeInstalled()) throw new Error('ESPHome is not installed')
  stageTemplate()
  onLine('Downloading the ESP32 build toolchain (first time only, ~1 GB)…')
  await runEsphome(
    [...subsArgs({ ssid: 'warmup', password: 'warmup123', host: '127.0.0.1' }), 'compile', CONFIG_NAME],
    { cwd: BUILD_DIR, onLine, signal, timeoutMs: 30 * 60_000 },
  )
  onLine('Toolchain ready.')
}

// ── build + flash ──────────────────────────────────────────────────────────────

export interface FlashOptions {
  /** Serial device path; auto-selected if exactly one is present. */
  port?: string
  /** Optional device name (becomes the ESPHome node name / mDNS host). */
  name?: string
  onLine?: (line: string) => void
  signal?: AbortSignal
}

/**
 * Compile the firmware (home Wi-Fi + server address baked in) and flash the device
 * on the server's USB. Streams CLI output line-by-line. Throws on any failure;
 * the device, once flashed, auto-joins Wi-Fi and announces itself for Claim.
 */
export async function buildAndFlash(opts: FlashOptions): Promise<void> {
  const onLine = (l: string) => { try { opts.onLine?.(l) } catch { /* ignore sink errors */ } }
  if (isFlashBusy()) throw new Error('a flash is already in progress')
  if (!isESPHomeInstalled()) throw new Error('ESPHome is not installed — install it first')

  const { ssid, password } = await getPodWifi()
  if (!ssid) throw new Error('home Wi-Fi is not configured')

  const ports = detectSerialPorts()
  const port = opts.port ?? (ports.length === 1 ? ports[0] : undefined)
  if (!port) {
    throw new Error(
      ports.length === 0
        ? 'no device detected — plug the device into this server via USB'
        : 'multiple serial ports found — pick which one to flash',
    )
  }

  const host = await getServerHost()

  flash.state = 'staging'
  flash.error = ''
  try {
    stageTemplate()

    flash.state = 'compiling'
    onLine(`Building firmware (server ${host}:${GATEWAY_PORT}, Wi-Fi "${ssid}")…`)
    // `run --device <port>` compiles then uploads over serial; --no-logs so the CLI
    // exits after flashing instead of tailing the device forever.
    await runEsphome(
      [
        ...subsArgs({ ssid, password, host, name: opts.name }),
        'run', CONFIG_NAME, '--device', port!, '--no-logs',
      ],
      {
        cwd: BUILD_DIR,
        signal: opts.signal,
        timeoutMs: 30 * 60_000,
        onLine: (line) => {
          // Flip to "flashing" once esptool starts writing.
          if (flash.state === 'compiling' && /Uploading|esptool|Writing at|Connecting\.\.\./i.test(line)) {
            flash.state = 'flashing'
          }
          onLine(line)
        },
      },
    )

    flash.state = 'done'
    onLine('Flash complete — power the device on and it will appear under "Unclaimed devices".')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    flash.state = 'failed'
    flash.error = msg
    logger.warn(`[pod-firmware] flash failed: ${msg}`)
    throw err
  }
}

// ── status snapshot for the wizard ─────────────────────────────────────────────

export interface FirmwareStatus {
  esphomeInstalled: boolean
  flashState: FlashState
  flashError: string
  wifiConfigured: boolean
  wifiSsid: string
  serverHost: string
  ports: string[]
}

export async function getFirmwareStatus(): Promise<FirmwareStatus> {
  const { ssid } = await getPodWifi()
  return {
    esphomeInstalled: isESPHomeInstalled(),
    flashState: flash.state,
    flashError: flash.error,
    wifiConfigured: !!ssid,
    wifiSsid: ssid,
    serverHost: await getServerHost(),
    ports: detectSerialPorts(),
  }
}
