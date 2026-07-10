// Central install registry — single source of truth for installable/repairable
// components. Every install path (Admin → Features repair, first-run setup wizard,
// and boot auto-reconcile) dispatches through this module so coverage stays in
// lockstep and there is no duplicated component logic.
//
// A "component" here is anything installed outside the Ollama model registry:
// runtimes (ComfyUI, kiwix, maps toolchain), helper models (ESRGAN, CodeFormer),
// system tools (Tesseract), and the ComfyUI image-role models from the catalog.
// Plain Ollama models (llm/vision/router_llm/embeddings) are reconciled separately
// from app_settings — they are not components.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  dataDir,
  setupComfyUIBase,
  installComfyUINodes,
  installFaceRestoreNode,
  downloadComfyUIModel,
  isWeatherIconsInstalled,
  downloadWeatherIcons,
  isWakewordCoreInstalled,
  downloadWakewordCore,
  isWakewordTrainInstalled,
  installWakewordTrainDeps,
  isWakewordRirInstalled,
  downloadWakewordRirPack,
  isSileroVadInstalled,
  downloadSileroVad,
  isEsrganInstalled,
  downloadEsrganModel,
  isCodeFormerInstalled,
  downloadCodeFormerModel,
  isGFPGANInstalled,
  downloadGFPGANModel,
  isFaceRestoreNodeInstalled,
  isBiRefNetNodeInstalled,
  isStingerSoundfontInstalled,
  downloadStingerSoundfont,
  isSdxlVaeInstalled,
  downloadSdxlVae,
  type DownloadProgress,
} from '@/lib/download'
import { isComfyUIInstalled, COMFYUI_DIR, restartComfyUI, venvPython } from '@/lib/comfyui'
import { isGpuTuningApplied, installGpuTuning } from '@/lib/gpuTuning'
import { isVtracerInstalled, ensureVtracer } from '@/lib/vtracer'
import { isSearXNGInstalled, installSearXNG, maybeSpawnSearXNG, searxngVenvPython } from '@/lib/searxng'
import { isStemAudioInstalled, installStemAudio, stemVenvPython, isRoformerGuitarInstalled, installRoformerGuitar, roformerVenvPython } from '@/lib/stems/pyenv'
import { isESPHomeInstalled, installESPHome, esphomeVenvBin } from '@/lib/esphome'
import { warmUpToolchain } from '@/lib/pod/firmware'
import { isKiwixInstalled, installKiwixTools } from '@/lib/kiwix'
import { isVoiceServerInstalled, installVoiceModels, maybeSpawnVoiceServer } from '@/lib/voiceServer'
import { isMapsToolchainInstalled, installMapsToolchain } from '@/lib/maps/toolchain'
import { isClaudeCodeInstalled, installClaudeCode } from '@/lib/claudeCode'
import { isChromiumInstalled, installChromium } from '@/lib/bookmarks/chromiumInstall'
import { isSandboxUserInstalled, installSandboxUser } from '@/lib/codingSandboxUser'
import { detectHardware, resolveComfyUILaunchConfig } from '@/lib/hwfit'
import { CATALOG, type CatalogModel, type ModelRole } from '@/lib/catalog'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

// Shared across setup.ts, system.ts and adminInstall.ts — previously copy-pasted
// (and `video_gen` was missing from two of the three copies, breaking svd-xt).
export const IMAGE_ROLES = new Set<ModelRole>([
  'image_gen', 'face_id', 'face_embed', 'video_motion', 'video_gen', 'bg_remove',
])

export type InstallProgressFn = (p: DownloadProgress) => void | Promise<void>

export interface InstallComponent {
  id: string
  /** Feature-group key used to label boot reconcile steps (chat/image/voice/library/maps/home-inventory). */
  group: string
  label: string
  isInstalled: () => boolean
  /** Deeper async health probe for components whose files can survive an OS wipe on the
   *  data drive but still be broken (a venv whose pyvenv.cfg points at a wiped base
   *  interpreter). Only consulted when isInstalled() is true; false means "present but
   *  broken — treat as missing and repair". */
  verify?: () => Promise<boolean>
  /** Rough download size of a repair — lets boot decide silent background heal vs.
   *  asking the admin first (see reconcileInstalls / the restore plan). */
  approxBytes?: number
  /** Repair triggers an interactive OS-admin approval (password / UAC / pkexec) — never
   *  auto-run it; surface it as an attention item instead. */
  needsElevation?: boolean
  /** Repair shells out to a system package manager (winget/choco/brew/apt) which may
   *  itself be gone after an OS wipe — pre-check availability before enqueueing. */
  needsPackageManager?: boolean
  /** Runs the install/repair, streaming byte/status progress; throws on failure; honors the abort signal. */
  repair: (onProgress: InstallProgressFn, signal: AbortSignal) => Promise<void>
}

// Adapt a status-message-only installer (kiwix/voice/maps) to the byte-progress shape.
const statusAdapter = (onProgress: InstallProgressFn) => (msg: string): void => {
  void onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: msg })
}

async function comfyConfig() {
  return resolveComfyUILaunchConfig(await detectHardware())
}

/** Package managers usable for repairs on this machine right now. After an OS wipe the
 *  manager itself is often gone (choco/scoop/brew), so components flagged
 *  needsPackageManager must pre-check this before being auto-enqueued — otherwise their
 *  repair just throws in the background where nobody sees it. */
/** Full path to winget, or null. winget.exe under WindowsApps is an app-execution alias
 *  (IO_REPARSE_TAG_APPEXECLINK reparse point) — stat/existsSync FAILS on those under
 *  Bun (EACCES → false), so listing the parent directory is the only reliable presence
 *  check. Spawning still works when the command runs through cmd.exe (exec), which is
 *  how installTesseract invokes it. Verified on Win11 26200 / Bun 1.3. */
export function wingetPath(): string | null {
  if (process.platform !== 'win32') return null
  const winApps = `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps`
  try { if (readdirSync(winApps).includes('winget.exe')) return `${winApps}\\winget.exe` } catch { /* dir missing */ }
  if (existsSync('C:\\Windows\\System32\\winget.exe')) return 'C:\\Windows\\System32\\winget.exe'
  return null
}

export function availablePackageManagers(): string[] {
  const found: string[] = []
  if (process.platform === 'win32') {
    if (wingetPath()) found.push('winget')
    if (existsSync('C:\\ProgramData\\chocolatey\\bin\\choco.exe')) found.push('choco')
    if (existsSync(`${process.env.USERPROFILE}\\scoop\\shims\\scoop.cmd`)) found.push('scoop')
  } else {
    if (existsSync('/opt/homebrew/bin/brew') || existsSync('/usr/local/bin/brew')) found.push('brew')
    if (existsSync('/usr/bin/apt-get')) found.push('apt-get')
  }
  return found
}

// Functional probe: does this executable actually run? existsSync passes for a venv
// whose base interpreter was wiped with the OS drive; actually executing it is the only
// honest check. Memoized briefly so repeated reconcile passes don't re-spawn processes.
const probeCache = new Map<string, { ok: boolean; at: number }>()
const PROBE_CACHE_MS = 60_000

async function probeRuns(bin: string, args: string[]): Promise<boolean> {
  const key = `${bin} ${args.join(' ')}`
  const hit = probeCache.get(key)
  if (hit && Date.now() - hit.at < PROBE_CACHE_MS) return hit.ok
  let ok = false
  try {
    await execFileAsync(bin, args, { timeout: 10_000, windowsHide: true })
    ok = true
  } catch { ok = false }
  probeCache.set(key, { ok, at: Date.now() })
  return ok
}

export function isTesseractInstalled(): boolean {
  if (process.platform === 'win32') {
    return existsSync('C:\\Program Files\\Tesseract-OCR\\tesseract.exe') ||
           existsSync('C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe')
  }
  return existsSync('/opt/homebrew/bin/tesseract') ||
         existsSync('/usr/local/bin/tesseract') ||
         existsSync('/usr/bin/tesseract')
}

async function installTesseract(onProgress: InstallProgressFn): Promise<void> {
  const status = statusAdapter(onProgress)
  let cmd: string
  let mgr: string
  if (process.platform === 'win32') {
    const winget    = wingetPath()
    const hasChoco  = existsSync('C:\\ProgramData\\chocolatey\\bin\\choco.exe')
    const hasScoop  = existsSync(`${process.env.USERPROFILE}\\scoop\\shims\\scoop.cmd`)
    // Full quoted path: the backend's PATH may lack WindowsApps (spawn-chain dependent),
    // and cmd.exe launches app-execution aliases fine when given the explicit path.
    if (winget)        { cmd = `"${winget}" install --id UB-Mannheim.TesseractOCR -e --accept-package-agreements --accept-source-agreements`; mgr = 'winget' }
    else if (hasChoco) { cmd = 'choco install tesseract -y'; mgr = 'Chocolatey' }
    else if (hasScoop) { cmd = 'scoop install tesseract'; mgr = 'Scoop' }
    else throw new Error('No package manager found (winget/choco/scoop). Install Tesseract manually from https://github.com/UB-Mannheim/tesseract/wiki')
  } else {
    const hasBrew = existsSync('/opt/homebrew/bin/brew') || existsSync('/usr/local/bin/brew')
    const hasApt  = existsSync('/usr/bin/apt-get')
    if (hasBrew)     { cmd = 'brew install tesseract'; mgr = 'Homebrew' }
    else if (hasApt) { cmd = 'apt-get install -y tesseract-ocr'; mgr = 'apt-get' }
    else throw new Error('No package manager found (brew/apt-get). Install Tesseract manually: https://tesseract-ocr.github.io/tessdoc/Installation.html')
  }
  status(`Installing Tesseract via ${mgr}…`)
  await execAsync(cmd, { timeout: 120_000, windowsHide: true })
  status('Tesseract installed')
}

export function isTmuxInstalled(): boolean {
  if (process.platform === 'win32') return false // tmux isn't available on Windows; Coding falls back same as sandbox isolation
  return existsSync('/opt/homebrew/bin/tmux') ||
         existsSync('/usr/local/bin/tmux') ||
         existsSync('/usr/bin/tmux')
}

async function installTmux(onProgress: InstallProgressFn): Promise<void> {
  const status = statusAdapter(onProgress)
  if (process.platform === 'win32') throw new Error('tmux (and Coding\'s split-pane terminal) is not available on Windows.')
  const hasBrew = existsSync('/opt/homebrew/bin/brew') || existsSync('/usr/local/bin/brew')
  const hasApt  = existsSync('/usr/bin/apt-get')
  let cmd: string
  let mgr: string
  if (hasBrew)     { cmd = 'brew install tmux'; mgr = 'Homebrew' }
  else if (hasApt) { cmd = 'apt-get install -y tmux'; mgr = 'apt-get' }
  else throw new Error('No package manager found (brew/apt-get). Install tmux manually: https://github.com/tmux/tmux/wiki/Installing')
  status(`Installing tmux via ${mgr}…`)
  await execAsync(cmd, { timeout: 120_000 })
  status('tmux installed')
}

/** Install the Coding CLI (+ Node runtime, via installClaudeCode) AND ensure the coding model,
 *  so installing "Coding" from the setup wizard OR Admin → Features yields a runnable app rather
 *  than a CLI pointed at a model that was never downloaded. The model is enqueued to the durable
 *  background queue (idempotent — a present model / existing job is left alone) and surfaced by the
 *  setup widget like every other download. Dynamic import of the queue avoids a static import cycle
 *  (downloadJobs imports this module). */
async function installCodingPackage(onProgress: InstallProgressFn, signal?: AbortSignal): Promise<void> {
  await installClaudeCode(statusAdapter(onProgress), signal)
  try {
    const configured = (await getAppSetting('coding_model')) as string | null
    const codingId =
      (configured && CATALOG.find((m) => m.id === configured && m.role === 'coding')?.id) ||
      CATALOG.find((m) => m.role === 'coding' && m.backend === 'ollama' && m.ollamaTag)?.id
    if (codingId) {
      const { enqueueBackground } = await import('@/lib/downloadJobs')
      await enqueueBackground({ modelIds: [codingId] })
    }
  } catch (err) {
    logger.warn(`[coding] could not enqueue the coding model with Claude Code: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Component definitions ─────────────────────────────────────────────────────

const STATIC_COMPONENTS: InstallComponent[] = [
  {
    id: 'weather-icons', group: 'weather-icons', label: 'amCharts SVG Icons',
    approxBytes: 68_000,
    isInstalled: isWeatherIconsInstalled,
    repair: (onP, sig) => downloadWeatherIcons(onP, sig),
  },
  {
    id: 'kiwix-tools', group: 'library', label: 'Offline Library Runtime',
    approxBytes: 15_000_000,
    isInstalled: isKiwixInstalled,
    repair: (onP, sig) => installKiwixTools(statusAdapter(onP), sig),
  },
  {
    id: 'searxng', group: 'search', label: 'Web Search Engine (SearXNG)',
    approxBytes: 300_000_000,
    isInstalled: isSearXNGInstalled,
    verify: () => probeRuns(searxngVenvPython(), ['--version']),
    repair: async (onP, sig) => {
      await installSearXNG((msg) => statusAdapter(onP)(msg), sig)
      maybeSpawnSearXNG()
    },
  },
  {
    id: 'esphome', group: 'devices', label: 'Device Firmware Builder (ESPHome)',
    approxBytes: 1_000_000_000,
    isInstalled: isESPHomeInstalled,
    verify: () => probeRuns(esphomeVenvBin('python'), ['--version']),
    repair: async (onP, sig) => {
      await installESPHome((msg) => statusAdapter(onP)(msg), sig)
      // Best-effort: pre-download the ESP32 toolchain so the first flash is fast.
      // Non-fatal — if it's interrupted, the toolchain downloads on first flash.
      try { await warmUpToolchain((msg) => statusAdapter(onP)(msg), sig) }
      catch (e) { logger.warn(`[esphome] toolchain warm-up skipped: ${e instanceof Error ? e.message : String(e)}`) }
    },
  },
  {
    // Music Studio stem separation (Demucs) + analysis (Essentia). Big first install —
    // torch wheels + the htdemucs model dominate. The Studio falls back to "install
    // required" UI while absent, so repair is never blocking.
    id: 'stem-audio', group: 'music', label: 'Music Studio (Demucs + Essentia)',
    approxBytes: 2_500_000_000,
    isInstalled: isStemAudioInstalled,
    verify: () => probeRuns(stemVenvPython(), ['--version']),
    repair: (onP, sig) => installStemAudio((msg) => statusAdapter(onP)(msg), sig),
  },
  {
    // Optional guitar upgrade: a RoFormer model in its own venv. Depends on Music Studio
    // being installed; the Studio uses Demucs' guitar until this is added.
    id: 'stem-roformer-guitar', group: 'music', label: 'Music Studio: Enhanced Guitar (RoFormer)',
    approxBytes: 2_100_000_000,
    isInstalled: isRoformerGuitarInstalled,
    verify: () => probeRuns(roformerVenvPython(), ['--version']),
    repair: (onP, sig) => installRoformerGuitar((msg) => statusAdapter(onP)(msg), sig),
  },
  {
    id: 'voice-core', group: 'voice', label: 'Voice (Kokoro TTS + Whisper STT)',
    approxBytes: 320_000_000,
    isInstalled: isVoiceServerInstalled,
    repair: async (onP, sig) => {
      await installVoiceModels(statusAdapter(onP), sig)
      void maybeSpawnVoiceServer()
    },
  },
  {
    id: 'wakeword-core', group: 'voice', label: 'OpenWakeWord',
    approxBytes: 6_000_000,
    isInstalled: isWakewordCoreInstalled,
    repair: (onP, sig) => downloadWakewordCore(onP, sig),
  },
  {
    // Neural VAD for STT endpointing + browser barge-in. Rides along with Voice
    // (see the reconcile bridge in routes/system.ts); both consumers fall back
    // to energy-only VAD while it's absent, so repair is never blocking.
    id: 'silero-vad', group: 'voice', label: 'Silero Voice Detection',
    approxBytes: 2_300_000,
    isInstalled: isSileroVadInstalled,
    repair: (onP, sig) => downloadSileroVad(onP, sig),
  },
  {
    id: 'wakeword-train', group: 'voice', label: 'onnxruntime + scikit-learn',
    approxBytes: 160_000_000,
    isInstalled: isWakewordTrainInstalled,
    repair: (onP, sig) => installWakewordTrainDeps(onP, sig),
  },
  {
    // Bundled with Wake Word Training (installWakewordTrainDeps fetches it too), but
    // registered as its own component so boot reconcile can auto-repair it
    // independently — without re-running the training-deps pip install, and without
    // gating training itself (the trainer falls back to procedural reverb if absent).
    id: 'wakeword-train-rir', group: 'voice', label: 'Wake Word Reverb Pack',
    approxBytes: 50_000_000,
    isInstalled: isWakewordRirInstalled,
    repair: (onP, sig) => downloadWakewordRirPack(onP, sig),
  },
  {
    id: 'maps-toolchain', group: 'maps', label: 'Maps Runtime',
    approxBytes: 480_000_000,
    isInstalled: isMapsToolchainInstalled,
    repair: (onP, sig) => installMapsToolchain(statusAdapter(onP), sig),
  },
  {
    id: 'tesseract', group: 'home-inventory', label: 'Tesseract OCR',
    approxBytes: 30_000_000,
    needsPackageManager: true,
    isInstalled: isTesseractInstalled,
    repair: (onP) => installTesseract(onP),
  },
  {
    // Windows+NVIDIA only (repair throws elsewhere): imports a driver profile that
    // sets CUDA sysmem fallback to "prefer none" for python.exe, so VRAM over-commits
    // in ComfyUI fail fast instead of silently spilling to system RAM (minutes-long
    // 100%-util crawls, worst over Thunderbolt eGPUs). See lib/gpuTuning.ts.
    id: 'nvidia-gpu-tuning', group: 'image', label: 'NVIDIA Driver Tuning (VRAM overflow guard)',
    approxBytes: 450_000,
    needsElevation: true,   // the profile-inspector exe manifests requireAdministrator (UAC)
    isInstalled: isGpuTuningApplied,
    repair: (onP, sig) => installGpuTuning(statusAdapter(onP), sig),
  },
  {
    id: 'comfyui-base', group: 'image', label: 'ComfyUI Runtime',
    approxBytes: 2_500_000_000,  // venv + torch wheels dominate
    isInstalled: isComfyUIInstalled,
    verify: () => probeRuns(venvPython(), ['--version']),
    repair: async (onP, sig) => {
      const config = await comfyConfig()
      await setupComfyUIBase(config, onP, sig)
    },
  },
  {
    // Raster→SVG tracer for the image generator's "SVG (vector)" output mode. Small
    // standalone binary; the generator falls back to the raster artifact if it's absent,
    // so repair is never blocking.
    id: 'vtracer', group: 'image', label: 'Vector Tracer (vtracer)',
    approxBytes: 5_000_000,
    isInstalled: isVtracerInstalled,
    repair: (onP, sig) => ensureVtracer((msg) => statusAdapter(onP)(msg), sig),
  },
  {
    id: 'comfyui-nodes', group: 'image', label: 'ComfyUI Extensions',
    approxBytes: 200_000_000,
    isInstalled: () =>
      isComfyUIInstalled() &&
      existsSync(join(COMFYUI_DIR, 'custom_nodes', 'ComfyUI_IPAdapter_plus')) &&
      isBiRefNetNodeInstalled(),
    repair: async (onP, sig) => {
      await installComfyUINodes(onP, sig)
      void restartComfyUI()
    },
  },
  {
    id: 'comfyui-facerestore', group: 'image', label: 'FaceRestore ComfyUI Node',
    approxBytes: 10_000_000,
    isInstalled: isFaceRestoreNodeInstalled,
    repair: async (onP, sig) => {
      await installFaceRestoreNode(onP, sig)
      void restartComfyUI()
    },
  },
  {
    id: 'esrgan', group: 'image', label: 'ESRGAN Upscale Model',
    approxBytes: 67_000_000,
    isInstalled: isEsrganInstalled,
    repair: (onP, sig) => downloadEsrganModel(onP, sig),
  },
  {
    id: 'codeformer', group: 'image', label: 'CodeFormer',
    approxBytes: 352_000_000,
    isInstalled: isCodeFormerInstalled,
    repair: (onP, sig) => downloadCodeFormerModel(onP, sig),
  },
  {
    id: 'gfpgan', group: 'image', label: 'GFPGAN',
    approxBytes: 348_000_000,
    isInstalled: isGFPGANInstalled,
    repair: (onP, sig) => downloadGFPGANModel(onP, sig),
  },
  {
    id: 'sdxl-vae', group: 'image', label: 'SDXL VAE (fp16-fix)',
    approxBytes: 335_000_000,
    isInstalled: isSdxlVaeInstalled,
    repair: (onP, sig) => downloadSdxlVae(onP, sig),
  },
  {
    id: 'podcast-stinger-sf', group: 'podcast', label: 'Podcast Stinger SoundFont',
    approxBytes: 40_000_000,
    isInstalled: isStingerSoundfontInstalled,
    repair: (onP, sig) => downloadStingerSoundfont(onP, sig),
  },
  {
    // Sessions are per-user and spawned on demand (see codingServer.ts): install
    // just needs the binary present; nothing to pre-warm here.
    id: 'claude-code', group: 'coding', label: 'Coding (Claude Code)',
    approxBytes: 60_000_000,
    isInstalled: isClaudeCodeInstalled,
    repair: (onP, sig) => installCodingPackage(onP, sig),
  },
  {
    // Session multiplexing (splits + reload-persistence) for the Coding app's
    // terminal — see codingServer.ts's ensureTmuxSession/paneControl.
    id: 'tmux', group: 'coding', label: 'Coding Terminal Multiplexer (tmux)',
    approxBytes: 1_000_000,
    needsPackageManager: true,
    isInstalled: isTmuxInstalled,
    repair: (onP) => installTmux(onP),
  },
  {
    // Real OS-level isolation for the coding sidecar (see codingSandboxUser.ts):
    // a restricted OS user with zero access to any home directory, since the
    // opencode-sandbox plugin's Seatbelt/bubblewrap wrapping was verified live to
    // fail open (sandbox-exec itself is non-functional on this machine). Requires
    // one-time OS admin approval (native password/Touch ID dialog on macOS,
    // pkexec on Linux); every later sidecar spawn is silent after that.
    id: 'coding-sandbox-user', group: 'coding', label: 'Coding Sandbox Isolation',
    needsElevation: true,
    isInstalled: isSandboxUserInstalled,
    repair: (onP) => installSandboxUser(statusAdapter(onP)),
  },
  {
    // Headless Chromium — powers the Reader offline archive AND Canvas → PDF export.
    // Previously lazy-installed on first use with no boot heal; now a first-class
    // component so the wizard provisions it and reconcileInstalls repairs it.
    id: 'chromium-render', group: 'chat', label: 'Document export (PDF)',
    approxBytes: 150_000_000,
    isInstalled: isChromiumInstalled,
    repair: (onP, sig) => installChromium(statusAdapter(onP), sig),
  },
]

function imageModelDest(model: CatalogModel): string | undefined {
  return model.url?.dest ?? model.hf?.dest ?? model.hfFiles?.[0]?.dest
}

const IMAGE_MODEL_COMPONENTS: InstallComponent[] = CATALOG
  .filter((m) => IMAGE_ROLES.has(m.role))
  .map((model) => {
    const dest = imageModelDest(model)
    return {
      id: model.id,
      group: 'image',
      label: model.label,
      approxBytes: model.approxBytes,
      isInstalled: () => (dest ? existsSync(join(dataDir, dest)) : false),
      repair: (onP, sig) => downloadComfyUIModel(model, onP, sig),
    }
  })

export const INSTALL_COMPONENTS: InstallComponent[] = [...STATIC_COMPONENTS, ...IMAGE_MODEL_COMPONENTS]

export function getInstallComponent(id: string): InstallComponent | undefined {
  return INSTALL_COMPONENTS.find((c) => c.id === id)
}

// ── Install ledger ────────────────────────────────────────────────────────────
// Persists which components the user has chosen to install, so boot can repair a
// previously-installed component that has gone missing — without ever installing
// something the user never opted into.

const LEDGER_KEY = 'installed_components'

export async function getInstalledLedger(): Promise<string[]> {
  const v = await getAppSetting(LEDGER_KEY)
  return Array.isArray(v) ? (v as string[]) : []
}

export async function recordInstalled(id: string): Promise<void> {
  const cur = await getInstalledLedger()
  if (!cur.includes(id)) await setAppSetting(LEDGER_KEY, [...cur, id])
}

export async function removeFromLedger(id: string): Promise<void> {
  const cur = await getInstalledLedger()
  if (cur.includes(id)) await setAppSetting(LEDGER_KEY, cur.filter((x) => x !== id))
}
