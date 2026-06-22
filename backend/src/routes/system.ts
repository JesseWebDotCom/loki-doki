import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { existsSync } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { execSync, spawn } from 'node:child_process'
import { getModel, getWarmupPromise } from '@/lib/models'
import { seedHardwareDefaults, detectHardware, resolveComfyUILaunchConfig } from '@/lib/hwfit'
import {
  pullOllama,
  downloadHfFile,
  downloadAndStartOllama,
  setupComfyUIBase,
  downloadTaesdModels,
  isTaesdInstalled,
  downloadSdxlVae,
  isSdxlVaeInstalled,
  downloadEsrganModel,
  isEsrganInstalled,
  isWeatherIconsInstalled,
  downloadWeatherIcons,
  dataDir,
  OLLAMA_BIN_DEST,
  findSystemOllama,
  isWakewordCoreInstalled,
} from '@/lib/download'
import { killByCommandLine } from '@/lib/platform'
import { isVoiceServerInstalled, maybeSpawnVoiceServer, getVoiceServerState } from '@/lib/voiceServer'
import {
  spawnComfyUI,
  restartComfyUI,
  markComfyUIReady,
  getComfyUIState,
  isComfyUIInstalled,
  isLaunchVersionStale,
  comfyUrl,
  venvPython,
} from '@/lib/comfyui'
import { CATALOG } from '@/lib/catalog'
import { getAppSetting } from '@/lib/settings'
import { INSTALL_COMPONENTS, getInstalledLedger, recordInstalled, IMAGE_ROLES } from '@/lib/installRegistry'
import { enqueueBackground } from '@/lib/downloadJobs'
import type { AppEnv } from '@/types'

const system = new Hono<AppEnv>()

type StepStatus = 'running' | 'ok' | 'warn' | 'error'

interface BootStep {
  key: string
  label: string
  status: StepStatus
  detail?: string
}

function ollamaUrl() {
  return (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')
}

// ── Boot singleton ────────────────────────────────────────────────────────────
// The boot sequence runs exactly once per server process. Clients that connect
// mid-boot receive a replay of past events then subscribe to live ones.
// Refreshing the page does NOT restart downloads.

type BootEventPayload = { event: string; data: string }
type BroadcastFn = (event: string, data: string) => void

const boot = {
  started:     false,
  done:        false,
  events:      [] as BootEventPayload[],
  subscribers: new Set<(e: BootEventPayload) => void>(),
}

function broadcastBoot(event: string, data: string) {
  const e: BootEventPayload = { event, data }
  boot.events.push(e)
  for (const sub of boot.subscribers) sub(e)
}

// ── Boot helpers ──────────────────────────────────────────────────────────────

function step(broadcast: BroadcastFn, s: BootStep) {
  broadcast('step', JSON.stringify(s))
}

async function repairOllama(broadcast: BroadcastFn, key: string, tag: string): Promise<void> {
  await pullOllama(tag, (p) => {
    broadcast('repair', JSON.stringify({ key, ...p }))
  })
}

// ── Full reconcile ────────────────────────────────────────────────────────────
// Repair anything the user previously installed that has gone missing — without
// ever installing something they never chose. Two passes:
//   (a) Ollama role models recorded in app_settings (router LLM, vision).
//   (b) Registry components recorded in the install ledger.
// Healthy items are (re)recorded so they are protected on future boots.

async function reconcileInstalls(_broadcast: BroadcastFn): Promise<void> {
  // Repair-of-missing is now NON-BLOCKING: we hand it to the background download-job
  // manager so the app boots immediately. Boot only blocks on the truly-core models
  // (steps 4–5: chat LLM + embeddings + router), handled inline above. Everything the
  // user previously installed that went missing is enqueued and shown in the global
  // background-setup widget.
  const bgModelIds: string[] = []
  const bgComponentIds: string[] = []

  // (a) Configured Ollama role models that have gone missing → background.
  try {
    const tagsRes = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5_000) })
    const { models } = await tagsRes.json() as { models: { name: string }[] }
    const have = (tag: string) => {
      const prefix = tag.split(':')[0] ?? tag
      return models.some((m) => m.name === tag || m.name.startsWith(prefix))
    }
    for (const settingKey of ['router_llm_model', 'vision_model']) {
      const modelId = await getAppSetting(settingKey) as string | null
      if (!modelId) continue
      const cat = CATALOG.find((m) => m.id === modelId && m.backend === 'ollama' && m.ollamaTag)
      if (!cat?.ollamaTag || have(cat.ollamaTag)) continue
      bgModelIds.push(modelId)
    }
  } catch { /* Ollama unreachable — skip model reconcile */ }

  // (b) Registry components recorded in the install ledger → background if missing.
  try {
    const ledgerSet = new Set(await getInstalledLedger())
    for (const comp of INSTALL_COMPONENTS) {
      let installed = false
      try { installed = comp.isInstalled() } catch { installed = false }
      if (installed) {
        if (!ledgerSet.has(comp.id)) { try { await recordInstalled(comp.id) } catch { /* ignore */ } }
        continue
      }
      if (!ledgerSet.has(comp.id)) continue // never chosen — leave alone
      bgComponentIds.push(comp.id)
    }
  } catch { /* ledger unreadable — skip */ }

  if (bgModelIds.length || bgComponentIds.length) {
    await enqueueBackground({ modelIds: bgModelIds, componentIds: bgComponentIds })
  }
}

// ── Boot sequence (runs once per server process) ──────────────────────────────

async function sweepTempDirs(): Promise<void> {
  const dirs = [
    join(dataDir, 'temp', 'input-images'),
    join(dataDir, 'tmp'),
  ]
  for (const dir of dirs) {
    try {
      const files = await readdir(dir)
      await Promise.all(files.map((f) => unlink(join(dir, f)).catch(() => {})))
    } catch { /* dir may not exist */ }
  }
}

async function runBoot(broadcast: BroadcastFn): Promise<void> {
  // ── 0a. Sweep temp directories from previous session ─────────────────────────
  await sweepTempDirs()

  // ── 0. Kill stale project-owned Ollama binary ────────────────────────────────
  // The extracted CLI binary (data/bin/ollama) lacks the runner binaries that
  // modern Ollama needs. Kill it so the system Ollama.app takes over cleanly.
  const staleBin = join(dataDir, OLLAMA_BIN_DEST)
  if (existsSync(staleBin)) {
    killByCommandLine(staleBin)
    // Give the process time to exit before we try to connect
    await new Promise<void>((r) => setTimeout(r, 800))
  }
  // Ensure system Ollama server is running — spawn the binary directly so the
  // GUI app window doesn't open. Only start if not already reachable.
  try {
    const ping = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(1_500) })
    if (!ping.ok) throw new Error('not ready')
  } catch {
    const systemBin = findSystemOllama()
    if (systemBin) {
      spawn(systemBin, ['serve'], { detached: true, stdio: 'ignore' }).unref()
      // `ollama serve` takes a few seconds to bind — wait for it to accept connections
      // so step 3 below doesn't falsely report "Ollama unreachable".
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 1_000))
        try { const r = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(1_500) }); if (r.ok) break } catch { /* keep waiting */ }
      }
    } else {
      // No Ollama binary present (never installed, or removed). It's core, so restore it
      // here — same installer the setup wizard uses — with progress on the boot screen.
      step(broadcast, { key: 'ollama', label: 'Installing Ollama runtime…', status: 'running' })
      try {
        await downloadAndStartOllama((p) => broadcast('repair', JSON.stringify({ key: 'ollama', ...p })))
      } catch { /* step 3 below will report unreachable and let the user continue */ }
    }
  }

  // ── Weather icons (silent pre-step: repair if missing from served dir) ───────
  if (!isWeatherIconsInstalled()) {
    try {
      await downloadWeatherIcons((p) => {
        broadcast('repair', JSON.stringify({ key: 'weather-icons', ...p }))
      })
    } catch { /* non-fatal — app works without icons */ }
  }

  // ── 1. Database ─────────────────────────────────────────────────────────────
  step(broadcast, { key: 'db', label: 'Database', status: 'running' })
  step(broadcast, { key: 'db', label: 'Database ready', status: 'ok' })

  // ── 2. Hardware detection ────────────────────────────────────────────────────
  step(broadcast, { key: 'hw', label: 'Detecting hardware', status: 'running' })
  try {
    const hw = await seedHardwareDefaults()
    const detail = `${hw.totalRamGb} GB${hw.isAppleSilicon ? ' · Apple Silicon' : ''}`
    step(broadcast, { key: 'hw', label: 'Hardware detected', status: 'ok', detail })
  } catch {
    step(broadcast, { key: 'hw', label: 'Hardware detection skipped', status: 'warn' })
  }

  // ── 3. Ollama ────────────────────────────────────────────────────────────────
  step(broadcast, { key: 'ollama', label: 'Connecting to Ollama', status: 'running' })
  let ollamaOk = false
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) })
    ollamaOk = res.ok
    step(broadcast, {
      key: 'ollama',
      label: ollamaOk ? 'Ollama connected' : 'Ollama unreachable',
      status: ollamaOk ? 'ok' : 'warn',
      detail: ollamaOk ? ollamaUrl() : 'Start Ollama to enable AI features',
    })
  } catch {
    step(broadcast, {
      key: 'ollama',
      label: 'Ollama unreachable',
      status: 'warn',
      detail: 'Start Ollama to enable AI features',
    })
  }

  // ── 4. LLM model ─────────────────────────────────────────────────────────────
  if (ollamaOk) {
    const model = await getModel()

    step(broadcast, { key: 'llm', label: `Checking ${model}`, status: 'running' })
    try {
      const tagsRes = await fetch(`${ollamaUrl()}/api/tags`)
      const { models } = await tagsRes.json() as { models: { name: string }[] }
      const prefix = model.split(':')[0] ?? model
      const available = models.some(
        (m) => m.name === model || m.name.startsWith(prefix),
      )

      if (!available) {
        step(broadcast, { key: 'llm', label: `Restoring ${model}…`, status: 'running' })
        try {
          await repairOllama(broadcast, 'llm', model)
          step(broadcast, { key: 'llm', label: `${model} ready`, status: 'ok', detail: 'Restored' })
        } catch {
          step(broadcast, { key: 'llm', label: `${model} could not be restored`, status: 'error' })
        }
      } else {
        // warmupModel() in index.ts is already loading the model into VRAM in parallel.
        // Await that shared promise instead of firing a duplicate generate request.
        step(broadcast, { key: 'llm', label: `Loading ${model} into memory`, status: 'running' })
        try {
          await (getWarmupPromise() ?? Promise.resolve())
          step(broadcast, { key: 'llm', label: `${model} ready`, status: 'ok', detail: 'Resident in memory' })
        } catch {
          step(broadcast, { key: 'llm', label: `${model} warm-up timed out`, status: 'warn', detail: 'Will load on first request' })
        }
      }
    } catch {
      step(broadcast, { key: 'llm', label: `${model} warm-up timed out`, status: 'warn', detail: 'Will load on first request' })
    }

    // ── 5. Embeddings ─────────────────────────────────────────────────────────
    // warmupModel() already warmed nomic-embed-text, all-minilm, and called initRouter().
    // Just verify the models are installed; repair if missing. Skip redundant embed calls.
    step(broadcast, { key: 'embed', label: 'Checking embedding models', status: 'running' })

    let embedInstalled = false
    let routerEmbedInstalled = false
    try {
      const tagsRes = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5_000) })
      const { models } = await tagsRes.json() as { models: { name: string }[] }
      embedInstalled = models.some((m) => m.name === 'nomic-embed-text' || m.name.startsWith('nomic-embed'))
      routerEmbedInstalled = models.some((m) => m.name === 'all-minilm' || m.name.startsWith('all-minilm'))
    } catch { /* Ollama unreachable */ }

    if (!embedInstalled) {
      step(broadcast, { key: 'embed', label: 'Restoring nomic-embed-text…', status: 'running' })
      try {
        await repairOllama(broadcast, 'embed', 'nomic-embed-text')
        embedInstalled = true
      } catch {
        step(broadcast, { key: 'embed', label: 'Embedding model could not be restored', status: 'error' })
      }
    }

    if (!routerEmbedInstalled) {
      step(broadcast, { key: 'router', label: 'Restoring all-minilm…', status: 'running' })
      try {
        await repairOllama(broadcast, 'router', 'all-minilm')
        routerEmbedInstalled = true
      } catch {
        step(broadcast, { key: 'router', label: 'Router model could not be restored', status: 'warn' })
      }
    }

    if (embedInstalled) {
      step(broadcast, { key: 'embed', label: 'Embedding model ready', status: 'ok', detail: 'nomic-embed-text' })
    }

    if (routerEmbedInstalled) {
      step(broadcast, { key: 'router', label: 'Semantic router indexed', status: 'ok' })
    }
  }

  // ── 6. Image generation (ComfyUI) ────────────────────────────────────────────
  // ComfyUI is spawned eagerly by index.ts at backend startup via maybeSpawnComfyUI().
  // The boot sequence handles two remaining cases:
  //   a) venv Python < 3.10 — rebuild in-place with progress streamed to the boot screen
  //   b) partial model downloads — resume them
  step(broadcast, { key: 'image', label: 'Checking image generation', status: 'running' })

  const comfyAlive = await fetch(`${comfyUrl()}/system_stats`, { signal: AbortSignal.timeout(2_000) })
    .then(r => { if (r.ok) markComfyUIReady(); return r.ok })
    .catch(() => false)

  const comfyInstalled = isComfyUIInstalled()
  let imgOk = comfyAlive || getComfyUIState() === 'warming'

  // Restart ComfyUI if it's alive but was spawned with outdated launch args.
  // This happens when the backend restarts after a code change that bumped
  // LAUNCH_VERSION (e.g. adding --preview-method auto).
  if (comfyAlive && isLaunchVersionStale()) {
    step(broadcast, { key: 'image', label: 'Restarting image generation with updated config…', status: 'running' })
    try {
      await restartComfyUI()
      imgOk = true
    } catch { /* non-fatal — old instance keeps running */ }
  }

  // (a) Venv Python version repair — only needed if ComfyUI failed to start
  if (!comfyAlive && comfyInstalled) {
    let venvCompatible = true
    try {
      const minor = execSync(
        `"${venvPython()}" -c "import sys; print(sys.version_info.minor)"`,
        { encoding: 'utf8', timeout: 5_000 },
      ).trim()
      if (parseInt(minor, 10) < 10) venvCompatible = false
    } catch { /* assume compatible */ }

    if (!venvCompatible) {
      step(broadcast, { key: 'image', label: 'Upgrading Python environment for image generation…', status: 'running' })
      const hw     = detectHardware()
      const config = await resolveComfyUILaunchConfig(hw)
      try {
        await setupComfyUIBase(config, (p) => {
          if (p.status) broadcast('repair', JSON.stringify({ key: 'image', label: p.status }))
        })
        // Venv rebuilt — spawn now
        spawnComfyUI(config)
        imgOk = true
      } catch (err) {
        step(broadcast, { key: 'image', label: `Image generation repair failed: ${err}`, status: 'warn' })
      }
    }
  }

  // (b) Resume any partial image-model downloads in the BACKGROUND — never block boot.
  // The download-job manager owns large optional assets (it resumes .part files itself),
  // so we just enqueue and move on. The app boots on essentials; the global widget shows
  // this finishing.
  if (comfyInstalled) {
    const partialImageIds = CATALOG.filter((m) => {
      if (!IMAGE_ROLES.has(m.role)) return false
      const dest = m.url?.dest ?? m.hf?.dest ?? m.hfFiles?.[0]?.dest
      if (!dest) return false
      const fullPath = join(dataDir, dest)
      return !existsSync(fullPath) && existsSync(fullPath + '.part')
    }).map((m) => m.id)
    if (partialImageIds.length) await enqueueBackground({ componentIds: partialImageIds })
  }

  // (c) Download TAESD preview models if missing — tiny (~5 MB each), non-fatal
  if (comfyInstalled && !isTaesdInstalled()) {
    step(broadcast, { key: 'image', label: 'Downloading preview models…', status: 'running' })
    try {
      await downloadTaesdModels((p) => {
        broadcast('repair', JSON.stringify({ key: 'image', label: p.label }))
      })
    } catch { /* non-fatal — latent2rgb previews still work */ }
  }

  // Check if the image_gen model file actually exists on disk
  let missingImageModel = false
  if (imgOk) {
    const imageGenModel = CATALOG.find((m) => m.role === 'image_gen')
    if (imageGenModel) {
      const dest = imageGenModel.url?.dest ?? imageGenModel.hf?.dest
      if (dest && !existsSync(join(dataDir, dest))) missingImageModel = true
    }
  }

  const comfyState = getComfyUIState()
  const imageReady = imgOk && !missingImageModel
  // Image generation is OPTIONAL and installs in the background — never a boot warning
  // that pauses the app. Only show a green/neutral status here.
  step(broadcast, {
    key: 'image',
    label: imageReady
      ? (comfyState === 'ready' ? 'Image generation ready' : 'Image generation warming up…')
      : 'Image generation will set up in the background',
    status: 'ok',
    detail: imageReady ? comfyUrl() : 'Optional · manage in Features',
  })

  // ── Voice (Kokoro TTS + Whisper STT) ──────────────────────────────────────────
  // Lightweight: don't auto-download (~320 MB) at boot — that's an admin opt-in via
  // the Features panel. Just spawn the sidecar if installed and report status.
  step(broadcast, { key: 'voice', label: 'Checking voice', status: 'running' })
  if (isVoiceServerInstalled()) {
    await maybeSpawnVoiceServer()
    const vState = getVoiceServerState()
    const wake = isWakewordCoreInstalled()
    step(broadcast, {
      key: 'voice',
      label: vState === 'ready' ? 'Voice ready' : 'Voice warming up…',
      status: 'ok',
      detail: wake ? 'TTS + STT + wake word' : 'TTS + STT (wake word not installed)',
    })
  } else {
    // Optional — not a warning. Set up in the background / Features when wanted.
    step(broadcast, { key: 'voice', label: 'Voice — set up in the background', status: 'ok', detail: 'Optional · manage in Features' })
  }

  // ── Reconcile: repair any previously-installed item that has gone missing ──────
  await reconcileInstalls(broadcast)

  // ── Done ──────────────────────────────────────────────────────────────────────
  broadcast('done', '')
}

// Quick check: is the boot sequence finished?
system.get('/ready', (c) => {
  return boot.done ? c.json({ done: true }) : c.json({ done: false }, 503)
})

// Boot sequence — no auth required (service status is not sensitive)
system.get('/boot', async (c) => {
  return streamSSE(c, async (stream) => {
    if (boot.done) {
      // Replay everything except 'done', then do a live image-gen recheck before
      // sending done — sd.cpp loads slowly and may now be up since boot finished.
      for (const e of boot.events) {
        if (e.event !== 'done') await stream.writeSSE(e)
      }
      try {
        const r = await fetch(`${comfyUrl()}/system_stats`, { signal: AbortSignal.timeout(2_000) })
        if (r.ok) {
          await stream.writeSSE({
            event: 'step',
            data: JSON.stringify({ key: 'image', label: 'Image generation ready', status: 'ok', detail: comfyUrl() }),
          })
        }
      } catch { /* still offline — keep original warning */ }
      await stream.writeSSE({ event: 'done', data: '' })
      return
    }

    // Replay all events emitted so far to catch up the reconnecting client
    for (const e of boot.events) {
      await stream.writeSSE(e)
    }

    // Subscribe to live events from this point forward
    let settle!: () => void
    const settled = new Promise<void>((r) => { settle = r })

    const sub = (e: BootEventPayload) => {
      stream.writeSSE(e).catch(() => {
        boot.subscribers.delete(sub)
        settle()
      })
      if (e.event === 'done') settle()
    }
    boot.subscribers.add(sub)
    stream.onAbort(() => {
      boot.subscribers.delete(sub)
      settle()
    })

    // Kick off the boot sequence once — subsequent clients just subscribe above
    if (!boot.started) {
      boot.started = true
      runBoot(broadcastBoot)
        .catch(console.error)
        .finally(() => {
          boot.done = true
          boot.subscribers.clear()
          // SDXL fp16-fix VAE and ESRGAN upscaler — quality improvements (~400 MB
          // total), not blockers. Deferred until after boot completes so they
          // cannot affect the boot sequence in any way.
          if (isComfyUIInstalled()) {
            if (!isSdxlVaeInstalled()) setTimeout(() => downloadSdxlVae(() => {}).catch(() => {}), 500)
            if (!isEsrganInstalled()) setTimeout(() => downloadEsrganModel(() => {}).catch(() => {}), 1_000)
          }
        })
    }

    await settled
  })
})

export { system }
