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

import { join, resolve, dirname } from 'node:path'
import { existsSync, readdirSync, mkdirSync, cpSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dataDir, downloadDirectUrl } from '@/lib/download'
import { logger } from '@/lib/logger'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { runEsphome, isESPHomeInstalled, run, esphomeVenvBin } from '@/lib/esphome'

const BUILD_ROOT = join(dataDir, 'esphome')

// Firmware templates are NOT shipped with the app. They're fetched on demand from
// the project repo (mirroring how models/toolchains are downloaded) into BUILD_ROOT
// and compiled there, so a distributed build contains no device firmware. In a dev
// checkout the firmware/ tree is present, so we prefer it (local edits take effect
// without a GitHub round-trip); otherwise each file is downloaded.
const FIRMWARE_REF = process.env.LOKIDOKI_FIRMWARE_REF ?? 'main'
const FIRMWARE_RAW_BASE = `https://raw.githubusercontent.com/JesseWebDotCom/loki-doki/${FIRMWARE_REF}/firmware`
const LOCAL_FIRMWARE_DIR = resolve(import.meta.dir, '../../../../firmware')

// The shared Wyoming/Loki-Doki satellite runtime (referenced by every device YAML
// as `../components`). Listed explicitly because we fetch the tree file-by-file.
const SHARED_COMPONENT_FILES = [
  'components/lokidoki_satellite/__init__.py',
  'components/lokidoki_satellite/lokidoki_satellite.cpp',
  'components/lokidoki_satellite/lokidoki_satellite.h',
  // Hardware-JPEG display source (Tab5 / P4 screen devices).
  'components/hw_jpeg/__init__.py',
  'components/hw_jpeg/hw_jpeg.cpp',
  'components/hw_jpeg/hw_jpeg.h',
  // ST7123 integrated touch (Tab5 new/V2 revision — GT911 is absent on that panel).
  'components/st7123/__init__.py',
  'components/st7123/touchscreen/__init__.py',
  'components/st7123/touchscreen/st7123_touchscreen.h',
  'components/st7123/touchscreen/st7123_touchscreen.cpp',
]

// Per-device firmware. `id` matches the device.model in the frontend catalog
// (lib/deviceCatalog.ts) and what a flashed device announces; `chip` is the family
// esptool reports, used to auto-select the right firmware from the plugged-in board.
interface FirmwareModel {
  /** Device YAML path relative to firmware/ (e.g. 'tab5/tab5.yaml'). */
  configRel: string
  /** ESP chip family esptool reports (e.g. 'ESP32', 'ESP32-P4'). */
  chip: string
  /** Extra non-component files the YAML references (images, etc.), relative to
   *  firmware/, that must be synced into the build dir alongside the config. */
  assets?: string[]
}

const FIRMWARE_MODELS: Record<string, FirmwareModel> = {
  'atom-echo': { configRel: 'atom-echo/atom-echo.yaml', chip: 'ESP32' },
  // placeholder.png backs the LVGL camera image widget (repointed at the live HW-JPEG
  // buffer at runtime); it must be present in the build dir for ESPHome to bake it in.
  tab5: { configRel: 'tab5/tab5.yaml', chip: 'ESP32-P4', assets: ['tab5/placeholder.png', 'tab5/logo.png', 'tab5/ic_mic.png', 'tab5/ic_micoff.png', 'tab5/ic_speaker.png', 'tab5/ic_speakeroff.png', 'tab5/weather_fx.h',
    'tab5/bg/clear_day.png', 'tab5/bg/clear_night.png', 'tab5/bg/partly_day.png', 'tab5/bg/partly_night.png',
    'tab5/bg/cloudy_day.png', 'tab5/bg/cloudy_night.png', 'tab5/bg/fog_day.png', 'tab5/bg/fog_night.png',
    'tab5/bg/drizzle_day.png', 'tab5/bg/drizzle_night.png', 'tab5/bg/rain_day.png', 'tab5/bg/rain_night.png',
    'tab5/bg/snow_day.png', 'tab5/bg/snow_night.png', 'tab5/bg/storm_day.png', 'tab5/bg/storm_night.png',
    'tab5/sun_rays.png',
    'tab5/spr/balloon.png', 'tab5/spr/ufo.png', 'tab5/spr/kite.png',
    'tab5/spr/airplane.png', 'tab5/spr/bird.png', 'tab5/spr/satellite.png',
    'tab5/spr/petal.png', 'tab5/spr/leaf.png', 'tab5/spr/bird2.png',
    'tab5/spr/airplane_a.png', 'tab5/spr/airplane_b.png',
    'tab5/spr/airplane_a2.png', 'tab5/spr/airplane_b2.png', 'tab5/spr/cloud.png',
    'tab5/spr/pine.png', 'tab5/spr/wear_sun.png', 'tab5/spr/wear_jacket.png',
    'tab5/spr/wear_umbrella.png', 'tab5/spr/wear_scarf.png', 'tab5/spr/wear_tee.png',
    'tab5/spr/cow.png', 'tab5/spr/comet.png', 'tab5/spr/blimp.png', 'tab5/spr/beam.png',
    'tab5/spr/tractor.png', 'tab5/spr/barn.png', 'tab5/spr/helicopter.png',
    'tab5/spr/house.png'] },
}

const DEFAULT_MODEL = 'atom-echo'

/** Resolve a model id, falling back to the default. */
function resolveFirmwareModel(model?: string | null): { id: string } & FirmwareModel {
  const id = model && FIRMWARE_MODELS[model] ? model : DEFAULT_MODEL
  return { id, ...FIRMWARE_MODELS[id]! }
}

/** The build dir + config filename a model compiles in (mirrors the repo layout
 *  under BUILD_ROOT, so a YAML's `../components` resolves to BUILD_ROOT/components). */
function buildPaths(fw: FirmwareModel): { buildDir: string; configName: string } {
  return { buildDir: join(BUILD_ROOT, dirname(fw.configRel)), configName: fw.configRel.split('/').pop()! }
}

/** Bring a single firmware file into BUILD_ROOT — copied from the local checkout in
 *  dev, otherwise downloaded from the repo. */
async function fetchFirmwareFile(rel: string, onLine: (l: string) => void, signal?: AbortSignal): Promise<void> {
  const dest = join(BUILD_ROOT, rel)
  const localSrc = join(LOCAL_FIRMWARE_DIR, rel)
  if (existsSync(localSrc)) {
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(localSrc, dest)
    return
  }
  onLine(`Fetching firmware: ${rel}…`)
  // downloadDirectUrl writes relative to dataDir; BUILD_ROOT is dataDir/esphome.
  await downloadDirectUrl(`${FIRMWARE_RAW_BASE}/${rel}`, join('esphome', rel), () => {}, signal)
  if (!existsSync(dest)) throw new Error(`could not obtain firmware file: ${rel}`)
}

/** Ensure a model's YAML + the shared component are present under BUILD_ROOT. */
async function ensureFirmwareFiles(fw: FirmwareModel, onLine: (l: string) => void, signal?: AbortSignal): Promise<void> {
  for (const rel of [fw.configRel, ...(fw.assets ?? []), ...SHARED_COMPONENT_FILES]) {
    await fetchFirmwareFile(rel, onLine, signal)
  }
}

// ── auto-detect the plugged-in device ──────────────────────────────────────────

export interface DetectedDevice {
  port: string
  /** Chip family esptool reported, or 'unknown'. */
  chip: string
  /** Catalog model id matching the chip, or null if we can't map it. */
  model: string | null
}

/** Parse the chip family from esptool output (the "Detecting chip type" line gives
 *  the family; "Chip is …" is more specific but we key off the family). */
function parseChipFamily(out: string): string | null {
  const m = out.match(/Detecting chip type[.\s]*?(ESP32[\w-]*)/i)
  if (m) return m[1]!.toUpperCase()
  const c = out.match(/Chip is\s+(ESP32-?P4|ESP32-?S3|ESP32-?C\d|ESP32)/i)
  return c ? c[1]!.toUpperCase().replace(/^ESP32(?=[SPC]\d?)/, 'ESP32-') : null
}

/**
 * Identify the device on a USB port by reading its ESP chip family with esptool
 * (bundled in the ESPHome venv), then map that to a catalog model so the wizard can
 * pick the right firmware automatically. Returns null if no single port is present.
 */
export async function detectDevice(port?: string): Promise<DetectedDevice | null> {
  const ports = detectSerialPorts()
  const p = port ?? (ports.length === 1 ? ports[0] : undefined)
  if (!p) return null
  let out = ''
  try {
    await run(esphomeVenvBin('python'), ['-m', 'esptool', '--port', p, '--connect-attempts', '2', 'chip-id'],
      { onLine: (l) => { out += l + '\n' }, timeoutMs: 30_000 })
  } catch { /* esptool may exit non-zero, but the chip line still prints during connect */ }
  const chip = parseChipFamily(out)
  const model = chip
    ? (Object.entries(FIRMWARE_MODELS).find(([, m]) => m.chip.toUpperCase() === chip)?.[0] ?? null)
    : null
  return { port: p, chip: chip ?? 'unknown', model }
}

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
/** Force the flash state machine back to idle (used to take over a stuck/abandoned
 *  flash whose SSE client went away without releasing the lock). */
export function resetFlashState(): void {
  flash.state = 'idle'
  flash.error = ''
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
  // Warm the default (ESP32-classic) toolchain. Other chip families (e.g. the Tab5's
  // ESP32-P4) pull their toolchain on that device's first flash.
  const fw = resolveFirmwareModel(DEFAULT_MODEL)
  await ensureFirmwareFiles(fw, onLine, signal)
  const { buildDir, configName } = buildPaths(fw)
  onLine('Downloading the ESP32 build toolchain (first time only, ~1 GB)…')
  await runEsphome(
    [...subsArgs({ ssid: 'warmup', password: 'warmup123', host: '127.0.0.1' }), 'compile', configName],
    { cwd: buildDir, onLine, signal, timeoutMs: 30 * 60_000 },
  )
  onLine('Toolchain ready.')
}

// ── validate (config check, no compile/flash) ───────────────────────────────────

/**
 * Validate a device's firmware config WITHOUT compiling or flashing — runs
 * `esphome config` (YAML schema + external-component codegen + substitutions) on the
 * staged build and streams the CLI output. Fast (seconds; no toolchain download) and the
 * right pre-flight check after editing a device YAML or the shared component. Throws if
 * the config is invalid (the CLI exits non-zero) so the caller can surface the failure.
 */
export async function validateFirmware(
  model: string | undefined,
  onLine: (l: string) => void = () => {},
  signal?: AbortSignal,
): Promise<void> {
  if (!isESPHomeInstalled()) throw new Error('ESPHome is not installed — install it first')
  const fw = resolveFirmwareModel(model)
  onLine(`Staging ${fw.id} firmware…`)
  await ensureFirmwareFiles(fw, onLine, signal)
  const { buildDir, configName } = buildPaths(fw)
  // Structure validation doesn't need real Wi-Fi creds, but the wifi: component rejects
  // an empty SSID — use the configured creds when present, else placeholders (same trick
  // as the warm-up compile).
  const { ssid, password } = await getPodWifi().catch(() => ({ ssid: '', password: '' }))
  const host = await getServerHost().catch(() => '127.0.0.1')
  onLine(`Validating ${fw.id} firmware config…`)
  await runEsphome(
    [...subsArgs({ ssid: ssid || 'validate', password: password || 'validate123', host: host || '127.0.0.1' }), 'config', configName],
    { cwd: buildDir, onLine, signal, timeoutMs: 5 * 60_000 },
  )
  onLine('Configuration is valid.')
}

// ── build + flash ──────────────────────────────────────────────────────────────

export interface FlashOptions {
  /** Serial device path; auto-selected if exactly one is present. */
  port?: string
  /** Optional device name (becomes the ESPHome node name / mDNS host). */
  name?: string
  /** Device model to flash (catalog id, e.g. 'atom-echo' | 'tab5'). Defaults to the Echo. */
  model?: string
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

  const fw = resolveFirmwareModel(opts.model)

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
    // Fetch this device's firmware (local checkout in dev, else downloaded).
    await ensureFirmwareFiles(fw, onLine, opts.signal)
    const { buildDir, configName } = buildPaths(fw)

    flash.state = 'compiling'
    onLine(`Building ${fw.id} firmware (server ${host}:${GATEWAY_PORT}, Wi-Fi "${ssid}")…`)
    // `run --device <port>` compiles then uploads over serial; --no-logs so the CLI
    // exits after flashing instead of tailing the device forever.
    await runEsphome(
      [
        ...subsArgs({ ssid, password, host, name: opts.name }),
        'run', configName, '--device', port!, '--no-logs',
      ],
      {
        cwd: buildDir,
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
