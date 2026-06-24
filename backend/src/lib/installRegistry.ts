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

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'node:child_process'
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
import { isComfyUIInstalled, COMFYUI_DIR, restartComfyUI } from '@/lib/comfyui'
import { isSearXNGInstalled, installSearXNG, maybeSpawnSearXNG } from '@/lib/searxng'
import { isKiwixInstalled, installKiwixTools } from '@/lib/kiwix'
import { isVoiceServerInstalled, installVoiceModels, maybeSpawnVoiceServer } from '@/lib/voiceServer'
import { isMapsToolchainInstalled, installMapsToolchain } from '@/lib/maps/toolchain'
import { detectHardware, resolveComfyUILaunchConfig } from '@/lib/hwfit'
import { CATALOG, type CatalogModel, type ModelRole } from '@/lib/catalog'
import { getAppSetting, setAppSetting } from '@/lib/settings'

const execAsync = promisify(exec)

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
  /** Runs the install/repair, streaming byte/status progress; throws on failure; honors the abort signal. */
  repair: (onProgress: InstallProgressFn, signal: AbortSignal) => Promise<void>
}

// Adapt a status-message-only installer (kiwix/voice/maps) to the byte-progress shape.
const statusAdapter = (onProgress: InstallProgressFn) => (msg: string): void => {
  void onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, status: msg })
}

async function comfyConfig() {
  return resolveComfyUILaunchConfig(detectHardware())
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
    const hasWinget = existsSync('C:\\Windows\\System32\\winget.exe') ||
                      existsSync(`${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\winget.exe`)
    const hasChoco  = existsSync('C:\\ProgramData\\chocolatey\\bin\\choco.exe')
    const hasScoop  = existsSync(`${process.env.USERPROFILE}\\scoop\\shims\\scoop.cmd`)
    if (hasWinget)     { cmd = 'winget install --id UB-Mannheim.TesseractOCR -e --accept-package-agreements --accept-source-agreements'; mgr = 'winget' }
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
  await execAsync(cmd, { timeout: 120_000 })
  status('Tesseract installed')
}

// ── Component definitions ─────────────────────────────────────────────────────

const STATIC_COMPONENTS: InstallComponent[] = [
  {
    id: 'weather-icons', group: 'weather-icons', label: 'amCharts SVG Icons',
    isInstalled: isWeatherIconsInstalled,
    repair: (onP, sig) => downloadWeatherIcons(onP, sig),
  },
  {
    id: 'kiwix-tools', group: 'library', label: 'Offline Library Runtime',
    isInstalled: isKiwixInstalled,
    repair: (onP, sig) => installKiwixTools(statusAdapter(onP), sig),
  },
  {
    id: 'searxng', group: 'search', label: 'Web Search Engine (SearXNG)',
    isInstalled: isSearXNGInstalled,
    repair: async (onP, sig) => {
      await installSearXNG((msg) => statusAdapter(onP)(msg), sig)
      maybeSpawnSearXNG()
    },
  },
  {
    id: 'voice-core', group: 'voice', label: 'Voice (Kokoro TTS + Whisper STT)',
    isInstalled: isVoiceServerInstalled,
    repair: async (onP, sig) => {
      await installVoiceModels(statusAdapter(onP), sig)
      void maybeSpawnVoiceServer()
    },
  },
  {
    id: 'wakeword-core', group: 'voice', label: 'OpenWakeWord',
    isInstalled: isWakewordCoreInstalled,
    repair: (onP, sig) => downloadWakewordCore(onP, sig),
  },
  {
    id: 'wakeword-train', group: 'voice', label: 'onnxruntime + scikit-learn',
    isInstalled: isWakewordTrainInstalled,
    repair: (onP, sig) => installWakewordTrainDeps(onP, sig),
  },
  {
    id: 'maps-toolchain', group: 'maps', label: 'Maps Runtime',
    isInstalled: isMapsToolchainInstalled,
    repair: (onP, sig) => installMapsToolchain(statusAdapter(onP), sig),
  },
  {
    id: 'tesseract', group: 'home-inventory', label: 'Tesseract OCR',
    isInstalled: isTesseractInstalled,
    repair: (onP) => installTesseract(onP),
  },
  {
    id: 'comfyui-base', group: 'image', label: 'ComfyUI Runtime',
    isInstalled: isComfyUIInstalled,
    repair: async (onP, sig) => {
      const config = await comfyConfig()
      await setupComfyUIBase(config, onP, sig)
    },
  },
  {
    id: 'comfyui-nodes', group: 'image', label: 'ComfyUI Extensions',
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
    isInstalled: isFaceRestoreNodeInstalled,
    repair: async (onP, sig) => {
      await installFaceRestoreNode(onP, sig)
      void restartComfyUI()
    },
  },
  {
    id: 'esrgan', group: 'image', label: 'ESRGAN Upscale Model',
    isInstalled: isEsrganInstalled,
    repair: (onP, sig) => downloadEsrganModel(onP, sig),
  },
  {
    id: 'codeformer', group: 'image', label: 'CodeFormer',
    isInstalled: isCodeFormerInstalled,
    repair: (onP, sig) => downloadCodeFormerModel(onP, sig),
  },
  {
    id: 'gfpgan', group: 'image', label: 'GFPGAN',
    isInstalled: isGFPGANInstalled,
    repair: (onP, sig) => downloadGFPGANModel(onP, sig),
  },
  {
    id: 'sdxl-vae', group: 'image', label: 'SDXL VAE (fp16-fix)',
    isInstalled: isSdxlVaeInstalled,
    repair: (onP, sig) => downloadSdxlVae(onP, sig),
  },
  {
    id: 'podcast-stinger-sf', group: 'podcast', label: 'Podcast Stinger SoundFont',
    isInstalled: isStingerSoundfontInstalled,
    repair: (onP, sig) => downloadStingerSoundfont(onP, sig),
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
