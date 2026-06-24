import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { requireAdmin } from '@/middleware/auth'
import { CATALOG, ROLE_SETTINGS_KEY } from '@/lib/catalog'
import { setAppSetting } from '@/lib/settings'
import { invalidateRouterModelCache } from '@/lib/models'
import { pullOllama, dataDir, isWeatherIconsInstalled } from '@/lib/download'
import { isComfyUIInstalled, COMFYUI_DIR } from '@/lib/comfyui'
import { isSearXNGInstalled } from '@/lib/searxng'
import { isKiwixInstalled } from '@/lib/kiwix'
import { isWakewordCoreInstalled, isWakewordTrainInstalled } from '@/lib/download'
import { isVoiceServerInstalled } from '@/lib/voiceServer'
import { isMapsToolchainInstalled } from '@/lib/maps/toolchain'
import { isEsrganInstalled, isCodeFormerInstalled, isGFPGANInstalled, isFaceRestoreNodeInstalled, isBiRefNetNodeInstalled } from '@/lib/download'
import { IMAGE_ROLES, isTesseractInstalled, getInstallComponent, recordInstalled, removeFromLedger } from '@/lib/installRegistry'
import { isGloballyOffline, isDownloadBlocked } from '@/lib/connectivity'
import type { AppEnv } from '@/types'

const adminInstall = new Hono<AppEnv>()

// ── Component list + install state ────────────────────────────────────────────

adminInstall.get('/', requireAdmin, (c) => {
  const comfyInstalled = isComfyUIInstalled()

  const nodesInstalled = comfyInstalled &&
    existsSync(join(COMFYUI_DIR, 'custom_nodes', 'ComfyUI_IPAdapter_plus')) &&
    isBiRefNetNodeInstalled()

  const imageModels = CATALOG.filter((m) => IMAGE_ROLES.has(m.role))

  const components = [
    {
      id: 'weather-icons',
      label: 'Weather Icons',
      description: 'Animated SVG weather icons for the weather app (amCharts CC-BY 4.0)',
      installed: isWeatherIconsInstalled(),
      approxBytes: 68_000,
    },
    {
      id: 'kiwix-tools',
      label: 'Offline Library Runtime',
      description: 'libzim — ZIM reader required to browse offline Wikipedia, iFixit, Khan Academy, and more',
      installed: isKiwixInstalled(),
      approxBytes: 15_000_000,
    },
    {
      id: 'searxng',
      label: 'Web Search Engine (SearXNG)',
      description: 'Local SearXNG metasearch — aggregates Google/Brave/Startpage server-side so web search works where direct scraping is blocked. Self-updates weekly. Source: github.com/searxng/searxng (AGPL-3.0).',
      installed: isSearXNGInstalled(),
      approxBytes: 300_000_000,
    },
    {
      id: 'voice-core',
      label: 'Voice (Kokoro TTS + Whisper STT)',
      description: 'Local speech synthesis + recognition models for read-aloud and hands-free voice',
      installed: isVoiceServerInstalled(),
      approxBytes: 320_000_000,
    },
    {
      id: 'wakeword-core',
      label: 'Wake Word Engine',
      description: 'OpenWakeWord feature models + a default "Hey Jarvis" detector for hands-free activation',
      installed: isWakewordCoreInstalled(),
      approxBytes: 6_000_000,
    },
    {
      id: 'wakeword-train',
      label: 'Wake Word Training',
      description: 'Python packages (onnxruntime, scikit-learn, scipy) to train custom ONNX detectors from typed phrases',
      installed: isWakewordTrainInstalled(),
      approxBytes: 160_000_000,
    },
    {
      id: 'maps-toolchain',
      label: 'Maps Runtime',
      description: 'Java runtime + planetiler (vector tiles), GraphHopper (routing), and map font glyphs — required before downloading map regions',
      installed: isMapsToolchainInstalled(),
      approxBytes: 480_000_000,
    },
    {
      id: 'tesseract',
      label: 'Tesseract OCR',
      description: 'Tesseract 5 OCR engine — used by Home Inventory to accurately read text from device label photos without AI hallucination',
      installed: isTesseractInstalled(),
      approxBytes: 30_000_000,
    },
    {
      id: 'comfyui-base',
      label: 'ComfyUI Runtime',
      description: 'Python venv + ComfyUI server',
      installed: comfyInstalled,
      approxBytes: 0,
    },
    {
      id: 'comfyui-nodes',
      label: 'ComfyUI Extensions',
      description: 'IP-Adapter, ControlNet, AnimateDiff, Impact Pack, BiRefNet, Upscale',
      installed: nodesInstalled,
      approxBytes: 0,
    },
    {
      id: 'esrgan',
      label: 'ESRGAN Upscale Model',
      description: '4x-NMKD-Siax 200k — required for Upscale 4× image editing',
      installed: isEsrganInstalled(),
      approxBytes: 67_000_000,
    },
    {
      id: 'comfyui-facerestore',
      label: 'FaceRestore ComfyUI Node',
      description: 'ComfyUI custom node required to run CodeFormer and GFPGAN within image workflows',
      installed: isFaceRestoreNodeInstalled(),
      approxBytes: 0,
    },
    {
      id: 'codeformer',
      label: 'CodeFormer',
      description: 'Face restoration — repairs blurry, old, or AI-generated faces with adjustable fidelity',
      installed: isCodeFormerInstalled(),
      approxBytes: 352_000_000,
    },
    {
      id: 'gfpgan',
      label: 'GFPGAN',
      description: 'Face restoration — faster alternative to CodeFormer, great for old photos',
      installed: isGFPGANInstalled(),
      approxBytes: 348_000_000,
    },
    ...imageModels.map((m) => {
      const dest = m.url?.dest ?? m.hf?.dest ?? m.hfFiles?.[0]?.dest
      return {
        id: m.id,
        label: m.label,
        description: m.description,
        installed: dest ? existsSync(join(dataDir, dest)) : false,
        approxBytes: m.approxBytes,
        role: m.role,
      }
    }),
  ]

  return c.json({ components })
})

// ── Repair a single component — streams SSE ───────────────────────────────────

adminInstall.post('/repair', requireAdmin, async (c) => {
  if (await isDownloadBlocked()) return c.json({ error: 'Offline mode is active — downloads are unavailable.' }, 503)
  const { componentId } = await c.req.json() as { componentId: string }

  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController()
    stream.onAbort(() => ctrl.abort())

    const base = { id: componentId }
    const emit = async (event: string, extra?: object) =>
      stream.writeSSE({ event, data: JSON.stringify({ ...base, ...extra }) })

    const component = getInstallComponent(componentId)
    if (!component) {
      await emit('start', { status: 'downloading' })
      await emit('error', { status: 'error', error: `Unknown component: ${componentId}` })
      return
    }

    await emit('start', { status: 'downloading' })

    try {
      await component.repair(async (p) => emit('progress', p), ctrl.signal)
      await recordInstalled(componentId)
      await emit('complete', { status: 'complete' })
      await stream.writeSSE({ event: 'done', data: '{}' })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        await emit('cancelled', { status: 'cancelled' })
        return
      }
      await emit('error', { status: 'error', error: String(err) })
    }
  })
})

// Uninstall is file-system level elsewhere; here we just keep the ledger honest
// so a deliberately-removed component is not "repaired" back on next boot.
adminInstall.post('/forget', requireAdmin, async (c) => {
  const { componentId } = await c.req.json() as { componentId: string }
  await removeFromLedger(componentId)
  return c.json({ ok: true })
})

// Pull a single Ollama model by catalog ID and set its role setting.
// Used by the Features tab to install model-type feature items (e.g. router_llm).
adminInstall.post('/model', requireAdmin, async (c) => {
  if (await isDownloadBlocked()) return c.json({ error: 'Offline mode is active — downloads are unavailable.' }, 503)
  const { modelId } = await c.req.json() as { modelId: string }
  const model = CATALOG.find((m) => m.id === modelId && m.backend === 'ollama' && m.ollamaTag)
  if (!model || !model.ollamaTag) return c.json({ error: `Unknown Ollama model: ${modelId}` }, 400)

  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController()
    stream.onAbort(() => ctrl.abort())
    const base = { id: modelId }
    const emit = async (event: string, extra?: object) =>
      stream.writeSSE({ event, data: JSON.stringify({ ...base, ...extra }) })

    await emit('start', { status: 'downloading' })
    try {
      await pullOllama(model.ollamaTag!, async (p) => emit('progress', p), ctrl.signal)
      const settingsKey = ROLE_SETTINGS_KEY[model.role]
      if (settingsKey) {
        await setAppSetting(settingsKey, model.id)
        if (model.role === 'router_llm') invalidateRouterModelCache()
      }
      await emit('complete', { status: 'complete' })
      await stream.writeSSE({ event: 'done', data: '{}' })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        await emit('cancelled', { status: 'cancelled' }); return
      }
      await emit('error', { status: 'error', error: String(err) })
    }
  })
})

export { adminInstall }
