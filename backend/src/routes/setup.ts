import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { eq } from 'drizzle-orm'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { db } from '@/db'
import { users } from '@/db/schema'
import { issueSession } from '@/lib/session'
import { requireAuth } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { warmupModel } from '@/lib/models'
import { detectHardware, resolveComfyUILaunchConfig } from '@/lib/hwfit'
import { CATALOG, TIERS, recommendedTier, ROLE_SETTINGS_KEY } from '@/lib/catalog'
import { ollamaList } from '@/llm/ollama'
import { pullOllama, downloadHfFile, downloadAndStartOllama, downloadComfyUIModel, setupComfyUIBase, installComfyUINodes, downloadTaesdModels, downloadSdxlVae, downloadEsrganModel, findSystemOllama, OLLAMA_BIN_APPROX_BYTES, dataDir, currentOllamaVersion } from '@/lib/download'
import { spawnComfyUI, isComfyUIInstalled } from '@/lib/comfyui'
import { maybeSpawnKiwix } from '@/lib/kiwix'
import { IMAGE_ROLES, getInstallComponent, recordInstalled } from '@/lib/installRegistry'
import { enqueueBackground } from '@/lib/downloadJobs'
import { zimArchives as zimArchivesTable } from '@/db/schema'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { AppEnv } from '@/types'

// ── Disk space helper ─────────────────────────────────────────────────────────

async function getDiskSpace(): Promise<{ freeBytes: number; totalBytes: number }> {
  try {
    // statfs is cross-platform (macOS/Linux/Windows) — no shelling out to df/wmic.
    // Measure the volume that actually holds our data, not always root.
    const s = await statfs(dataDir)
    return {
      totalBytes: s.bsize * s.blocks,
      freeBytes:  s.bsize * s.bavail,
    }
  } catch { /* ignore — UI just hides the disk estimate */ }
  return { freeBytes: 0, totalBytes: 0 }
}

// Ollama CLI binary size (~160 MB) — used for disk-space warning when not installed
const OLLAMA_INSTALL_BYTES = OLLAMA_BIN_APPROX_BYTES

const setup = new Hono<AppEnv>()

// ── Status ────────────────────────────────────────────────────────────────────

setup.get('/status', async (c) => {
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).limit(1)
  const firstRunComplete = (await getAppSetting('first_run_complete')) === true
  // Shown once, after first boot: the offline-content welcome wizard (library, maps,
  // home inventory). Decoupled from the install so the install stays fast.
  const welcomeComplete = (await getAppSetting('welcome_complete')) === true
  // Saved wizard progress (step + selections) so an interrupted setup resumes where
  // it left off — most importantly, straight back into the download.
  const state = (await getAppSetting('setup_state')) ?? null
  return c.json({ configured: !!admin, firstRunComplete, welcomeComplete, state })
})

// Mark the post-boot offline-content welcome wizard as seen so it never shows again.
// Called when the admin finishes or skips it; the actual downloads are enqueued
// separately via /api/jobs/enqueue.
setup.post('/welcome-complete', requireAuth, async (c) => {
  await setAppSetting('welcome_complete', true)
  return c.json({ ok: true })
})

// Finalize first run. In essentialOnly mode the /download stream installs the essentials
// inline and hands the rest to the durable background setup track, WITHOUT flipping
// first_run_complete. The wizard blocks on that track and calls this once every selected
// model + capability has finished downloading (or the admin explicitly opts to open the
// app before they finish). Idempotent - safe to call more than once. Keeping first_run
// gated here (not in /download) means a crash mid-download re-shows the wizard on its
// finishing screen and the queue resumes, instead of stranding the user in a half-install.
setup.post('/finish', requireAuth, async (c) => {
  await setAppSetting('first_run_complete', true)
  await setAppSetting('setup_state', null)
  await setAppSetting('consent_system_present', true)
  warmupModel()
  return c.json({ ok: true })
})

// Persist wizard progress. Called by the frontend as the user advances so a refresh,
// crash, or server restart can resume. Cleared once first run completes.
setup.put('/state', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null)
  await setAppSetting('setup_state', body)
  return c.json({ ok: true })
})

// ── Step 1: Create admin ───────────────────────────────────────────────────────

setup.post('/admin', async (c) => {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).limit(1)
  if (existing) return c.json({ error: 'Already configured' }, 400)

  const body = (await c.req.json()) as {
    firstName: string
    lastName: string
    birthdate: string
  }

  const now = new Date()
  const id = crypto.randomUUID()

  await db.insert(users).values({
    id,
    firstName: body.firstName,
    lastName: body.lastName,
    nickname: body.firstName,
    birthdate: body.birthdate,
    role: 'admin',
    createdAt: now,
    updatedAt: now,
  })

  // Auto-login so wizard continues authenticated
  await issueSession(c, id)

  return c.json({ id }, 201)
})

// ── Ollama status (no auth — used by wizard before session exists) ────────────

setup.get('/ollama-status', async (c) => {
  const url = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')
  // `installed` = a system Ollama binary is present even if not currently serving. On
  // Windows we can't reliably auto-install, so the wizard uses this to prompt the user.
  const installed = !!findSystemOllama()
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2500) })
    if (res.ok) {
      const data = await res.json() as { models: { name: string }[] }
      return c.json({ running: true, installed: true, platform: process.platform, models: data.models?.length ?? 0 })
    }
  } catch { /* offline */ }
  return c.json({ running: false, installed, platform: process.platform, models: 0 })
})

// ── Step 3: Catalog ───────────────────────────────────────────────────────────

setup.get('/catalog', requireAuth, async (c) => {
  const hw = detectHardware()
  const tier = recommendedTier(hw)

  // Check Ollama connectivity + installed models
  let installedOllamaTags = new Set<string>()
  let ollamaOk = false
  try {
    const list = await ollamaList()
    installedOllamaTags = new Set(list.flatMap((m) => [m.name, m.name.split(':')[0]]))
    ollamaOk = true
  } catch {
    // Ollama offline — all Ollama models show as not_installed
  }

  const models = CATALOG.map((m) => {
    let installed = false
    if (m.backend === 'ollama' && m.ollamaTag) {
      const tag = m.ollamaTag
      installed = installedOllamaTags.has(tag) || installedOllamaTags.has(tag.split(':')[0])
    } else if (m.backend === 'huggingface') {
      // Single file
      if (m.hf) {
        installed = existsSync(join(dataDir, m.hf.dest))
      }
      // Multi-file (voice): all must exist
      if (m.hfFiles) {
        installed = m.hfFiles.every((f) => existsSync(join(dataDir, f.dest)))
      }
    } else if (m.backend === 'url' && m.url) {
      installed = existsSync(join(dataDir, m.url.dest))
    }
    return { ...m, installed, recommended: m.tiers.includes(tier) }
  })

  const disk = await getDiskSpace()

  // Read current active model per role so the admin panel can show what's selected
  const roleKeys = Object.entries(ROLE_SETTINGS_KEY) as [string, string][]
  const activeEntries = await Promise.all(
    roleKeys.map(async ([role, key]) => [role, (await getAppSetting(key)) ?? null] as const),
  )
  const activeModelIds = Object.fromEntries(activeEntries)

  return c.json({
    hardware: {
      totalRamGb: hw.totalRamGb,
      isAppleSilicon: hw.isAppleSilicon,
      platform: hw.platform,
    },
    recommendedTier: tier,
    tiers: TIERS,
    models,
    disk: {
      freeBytes:  disk.freeBytes,
      totalBytes: disk.totalBytes,
    },
    ram: {
      freeBytes:  os.freemem(),
      totalBytes: os.totalmem(),
    },
    ollamaRunning:     ollamaOk,
    ollamaInstalled:   ollamaOk || !!findSystemOllama(),
    ollamaInstallBytes: ollamaOk ? 0 : OLLAMA_INSTALL_BYTES,
    ollamaVersion:     ollamaOk ? await currentOllamaVersion() : null,
    activeModelIds,
  })
})

// ── Step 4: Download ──────────────────────────────────────────────────────────
// POST + SSE stream. Client uses fetch() (not EventSource) to send cookies with POST.

setup.post('/download', requireAuth, async (c) => {
  const body = (await c.req.json()) as {
    tier: string; modelIds: string[]; componentIds?: string[]
    // Background handoff: when essentialOnly is set we install just the essentials inline
    // (boot the app fast) and enqueue everything else to the background job manager.
    essentialOnly?: boolean
    zimSelections?: { sourceId: string; variantKey?: string; label: string; approxBytes?: number }[]
    maps?: { regionId: string; label: string } | null
  }
  const { modelIds } = body
  const essentialOnly = body.essentialOnly === true
  // Optional capabilities the wizard chose (kiwix/voice/maps/tesseract/wakeword).
  // Default to the offline-library runtime for backward compatibility with older clients.
  const componentIds: string[] = Array.isArray(body.componentIds) ? body.componentIds : ['kiwix-tools']
  // Weather icons are small (~2 MB) and required for the weather widget — always install
  if (!componentIds.includes('weather-icons')) componentIds.push('weather-icons')

  // LLM is required — either the standard or uncensored variant satisfies this
  const hasLlm = CATALOG.some(
    (m) => (m.role === 'llm' || m.role === 'uncensored_llm') && modelIds.includes(m.id),
  )
  if (!hasLlm) {
    return c.json({ error: 'At least one LLM model must be selected' }, 400)
  }

  const selected = modelIds
    .map((id) => CATALOG.find((m) => m.id === id))
    .filter(Boolean) as typeof CATALOG

  // Essentials block boot: chat LLM + embeddings + router (Ollama always installs first).
  const ESSENTIAL_ROLES = new Set(['llm', 'uncensored_llm', 'embeddings', 'router', 'router_llm'])
  const toInstall = essentialOnly ? selected.filter((m) => ESSENTIAL_ROLES.has(m.role)) : selected
  const backgroundModelIds = essentialOnly ? selected.filter((m) => !ESSENTIAL_ROLES.has(m.role)).map((m) => m.id) : []
  // weather-icons is base: tiny, needed from first boot for the weather widget
  const BASE_COMPONENT_IDS = new Set(['tesseract', 'weather-icons'])
  const inlineComponentIds = essentialOnly
    ? componentIds.filter(id => BASE_COMPONENT_IDS.has(id))
    : componentIds

  // Computed early so both the pre-announce section and install section can use them
  const hasImageModels = !essentialOnly && selected.some((m) => IMAGE_ROLES.has(m.role))
  const hasFaceModels = hasImageModels && selected.some((m) => m.role === 'face_id' || m.role === 'face_embed')

  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController()

    // If client disconnects, abort in-flight downloads
    stream.onAbort(() => ctrl.abort())

    // ── Pre-announce all items so the UI shows the full queue immediately ─────
    // The frontend adds items to its download map when it receives 'start' events,
    // which only fire sequentially. Without this, the counter reads "1 of 2" while
    // 10 items are queued behind the current download.
    for (const model of toInstall) {
      if (IMAGE_ROLES.has(model.role)) continue // announced in image section
      await stream.writeSSE({ event: 'queued', data: JSON.stringify({ id: model.id, role: model.role, label: model.label }) })
    }
    for (const model of selected.filter((m) => IMAGE_ROLES.has(m.role))) {
      await stream.writeSSE({ event: 'queued', data: JSON.stringify({ id: model.id, role: model.role, label: model.label }) })
    }
    if (hasFaceModels) {
      for (const fid of ['comfyui-facerestore', 'codeformer', 'gfpgan']) {
        const comp = getInstallComponent(fid)
        if (comp && !comp.isInstalled()) await stream.writeSSE({ event: 'queued', data: JSON.stringify({ id: fid, role: 'component', label: comp.label }) })
      }
    }
    for (const cid of inlineComponentIds) {
      const comp = getInstallComponent(cid)
      if (!comp || cid === 'comfyui-base' || cid === 'comfyui-nodes') continue
      if (!comp.isInstalled()) await stream.writeSSE({ event: 'queued', data: JSON.stringify({ id: cid, role: 'component', label: comp.label }) })
    }

    // ── Step 0: Install Ollama if not running ─────────────────────────────────
    let ollamaOk = false
    try {
      const r = await fetch(`${(process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')}/api/tags`, {
        signal: AbortSignal.timeout(2500),
      })
      ollamaOk = r.ok
    } catch { /* offline */ }

    // Always emit start+complete for the Ollama runtime row so the frontend's
    // seeded 'pending' entry gets resolved even when Ollama is already running.
    const ollamaBase = { id: 'ollama-runtime', role: 'runtime', label: 'Ollama Runtime' }
    await stream.writeSSE({ event: 'start', data: JSON.stringify({ ...ollamaBase, status: 'downloading' }) })
    if (!ollamaOk) {
      try {
        await downloadAndStartOllama(async (p) => {
          await stream.writeSSE({ event: 'progress', data: JSON.stringify({ ...ollamaBase, ...p }) })
        }, ctrl.signal)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          await stream.writeSSE({ event: 'cancelled', data: JSON.stringify({ ...ollamaBase, status: 'cancelled' }) })
          return
        }
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ ...ollamaBase, status: 'error', error: String(err) }) })
        return  // Cannot proceed with model pulls without Ollama
      }
    }
    await stream.writeSSE({ event: 'complete', data: JSON.stringify({ ...ollamaBase, status: 'complete' }) })

    // Track whether the chat LLM (the one capability the app can't run without)
    // failed to install. If it did, we do NOT mark first_run_complete below, so the
    // wizard stays on its retry screen instead of admitting the user into a chatless
    // app. Embeddings/router failures self-heal via boot-repair, so they don't block.
    let essentialLlmFailed = false
    // Set when the user cancels: lanes stop starting new items and finalization is skipped.
    let cancelled = false

    // Serialize SSE writes across the concurrent install lanes below so events are
    // emitted whole and in call order regardless of which lane produced them.
    let writeChain: Promise<void> = Promise.resolve()
    const emit = (event: string, data: Record<string, unknown>): Promise<void> => {
      const next = writeChain
        .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
        .catch(() => { /* client gone — the abort handler tears down the downloads */ })
      writeChain = next
      return next
    }

    const installOneModel = async (model: (typeof CATALOG)[number]): Promise<void> => {
      const base = { id: model.id, role: model.role, label: model.label }
      const emitProgress = (p: {
        completed: number; total: number; speedBps: number; etaSeconds: number; status?: string
      }) => { void emit('progress', { ...base, ...p }) }

      await emit('start', { ...base, status: 'downloading' })

      console.log(`[models] pulling ${model.label} (${model.id})`)
      try {
        if (model.backend === 'ollama' && model.ollamaTag) {
          await pullOllama(model.ollamaTag, emitProgress, ctrl.signal)
        } else if (model.backend === 'huggingface') {
          // Single-file models
          if (model.hf) {
            await downloadHfFile(model.hf, emitProgress, ctrl.signal, model.approxBytes)
          }
          // Multi-file models (voice) — download each file in sequence
          if (model.hfFiles) {
            let totalAccum = 0
            const grandTotal = model.approxBytes
            for (const hfFile of model.hfFiles) {
              const fileBytes = hfFile.approxBytes ?? (hfFile.dest.includes('model.pth') ? model.approxBytes * 0.95 : 0)
              await downloadHfFile(
                hfFile,
                (p) => emitProgress({ ...p, completed: totalAccum + p.completed, total: grandTotal }),
                ctrl.signal,
              )
              totalAccum += fileBytes
            }
          }
        }

        // Persist chosen model to app_settings
        const settingsKey = ROLE_SETTINGS_KEY[model.role]
        if (settingsKey) {
          await setAppSetting(settingsKey, model.id)
        }
        // Keep the canonical 'model' key (what getModel() reads) pointing at the active LLM.
        // ROLE_SETTINGS_KEY maps uncensored_llm → 'uncensored_model', so without this,
        // switching to an uncensored model leaves 'model' stale and chat ignores the change.
        if (model.role === 'llm' || model.role === 'uncensored_llm') {
          await setAppSetting('model', model.id)
        }
        // If this LLM handles vision natively, route vision queries to it too
        if ((model.role === 'llm' || model.role === 'uncensored_llm') && model.builtinVision) {
          await setAppSetting('vision_model', model.id)
        }

        console.log(`[models] ✓ ${model.label} complete`)
        await emit('complete', { ...base, status: 'complete' })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          console.log(`[models] cancelled during ${model.label}`)
          cancelled = true
          await emit('cancelled', { ...base, status: 'cancelled' })
          return
        }
        console.error(`[models] ✗ ${model.label}:`, err)
        if (model.role === 'llm' || model.role === 'uncensored_llm') essentialLlmFailed = true
        await emit('error', { ...base, status: 'error', error: String(err) })
        // Continue to next model on non-fatal error
      }
    }

    // Models grouped by host into lanes: Ollama-registry pulls and HuggingFace files
    // download from different servers, so the lanes run CONCURRENTLY (each lane is
    // sequential internally to keep per-host bandwidth undivided). Previously every
    // item was strictly serial, making setup take the SUM of all downloads instead
    // of the longest lane.
    const nonImageModels = toInstall.filter((m) => !IMAGE_ROLES.has(m.role))
    const modelLane = async (models: typeof CATALOG): Promise<void> => {
      for (const m of models) {
        if (cancelled) return
        await installOneModel(m)
      }
    }

    // ── ComfyUI lane (if any image gen models were selected) ─────────────────
    // Skipped entirely in essentialOnly mode — image stack is backgrounded.
    // Runs concurrently with the model lanes: the runtime setup is git+pip
    // (CPU/pytorch.org), not a competitor for the model hosts' bandwidth.
    const imageLane = async (): Promise<void> => {
      if (!hasImageModels || cancelled) return
      const comfyBase = { id: 'comfyui-base', role: 'runtime', label: 'ComfyUI Runtime' }
      const nodesBase = { id: 'comfyui-nodes', role: 'runtime', label: 'Image Generation Extensions' }
      const hw     = detectHardware()
      const config = await resolveComfyUILaunchConfig(hw)

      if (!isComfyUIInstalled()) {
        await emit('start', { ...comfyBase, status: 'downloading' })
        try {
          await setupComfyUIBase(config, (p) => { void emit('progress', { ...comfyBase, ...p }) }, ctrl.signal)
          await emit('complete', { ...comfyBase, status: 'complete' })
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            cancelled = true
            await emit('cancelled', { ...comfyBase, status: 'cancelled' })
            return
          }
          // Non-fatal: image generation is optional. Emit the error and skip the rest of
          // the image stack (guarded by isComfyUIInstalled() below), then fall through to
          // finalize first-run — never strand the user in the wizard over an optional runtime.
          await emit('error', { ...comfyBase, status: 'error', error: String(err) })
        }

        // Only install the custom nodes if the runtime actually came up.
        if (isComfyUIInstalled() && !cancelled) {
          await emit('start', { ...nodesBase, status: 'downloading' })
          try {
            await installComfyUINodes((p) => { void emit('progress', { ...nodesBase, ...p }) }, ctrl.signal)
            await recordInstalled('comfyui-base')
            await recordInstalled('comfyui-nodes')
            await emit('complete', { ...nodesBase, status: 'complete' })
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
              cancelled = true
              await emit('cancelled', { ...nodesBase, status: 'cancelled' })
              return
            }
            // Non-fatal — custom nodes can be repaired later
            await emit('error', { ...nodesBase, status: 'error', error: String(err) })
          }
        }
      }

      // The remaining image assets (preview models, VAE, upscaler, face restore, model
      // files) and the runtime spawn all need a working ComfyUI. If the base failed above,
      // skip them so we don't emit a cascade of doomed downloads — setup finalizes regardless.
      if (!isComfyUIInstalled() || cancelled) return

      // Small helper: run one image-stack item with the standard event envelope.
      // Returns false when the user cancelled (caller stops the lane).
      const runItem = async (
        base: { id: string; role: string; label: string },
        work: (onP: (p: { completed: number; total: number; speedBps: number; etaSeconds: number; status?: string }) => void) => Promise<void>,
        onOk?: () => Promise<void>,
      ): Promise<boolean> => {
        await emit('start', { ...base, status: 'downloading' })
        try {
          await work((p) => { void emit('progress', { ...base, ...p }) })
          if (onOk) await onOk()
          await emit('complete', { ...base, status: 'complete' })
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            cancelled = true
            await emit('cancelled', { ...base, status: 'cancelled' })
            return false
          }
          // Non-fatal — every image asset can be repaired later via Admin → Features
          await emit('error', { ...base, status: 'error', error: String(err) })
        }
        return true
      }

      // TAESD preview models — small (~5 MB each), always needed for live previews
      if (!(await runItem(
        { id: 'taesd', role: 'runtime', label: 'TAESD' },
        (onP) => downloadTaesdModels((p) => onP({ ...p, status: p.label }), ctrl.signal),
      ))) return

      // SDXL external VAE — fixes color fringing from baked-in v0.9 VAE weights
      if (!(await runItem(
        { id: 'sdxl-vae', role: 'runtime', label: 'SDXL VAE (color fix)' },
        (onP) => downloadSdxlVae(onP, ctrl.signal),
      ))) return

      // ESRGAN upscaler — pixel-space hires fix, sharper than latent bislerp
      if (!(await runItem(
        { id: 'esrgan-upscaler', role: 'runtime', label: 'ESRGAN' },
        (onP) => downloadEsrganModel(onP, ctrl.signal),
        () => recordInstalled('esrgan'),
      ))) return

      // Face restoration helpers — only needed when face_id/face_embed models are selected
      if (hasFaceModels) {
        for (const fid of ['comfyui-facerestore', 'codeformer', 'gfpgan']) {
          const comp = getInstallComponent(fid)
          if (!comp) continue
          if (comp.isInstalled()) { await recordInstalled(fid); continue }
          if (!(await runItem(
            { id: fid, role: 'component', label: comp.label },
            (onP) => comp.repair(onP, ctrl.signal),
            () => recordInstalled(fid),
          ))) return
        }
      }

      // Download selected image model files
      const imageModels = selected.filter((m) => IMAGE_ROLES.has(m.role))
      for (const model of imageModels) {
        if (!(await runItem(
          { id: model.id, role: model.role, label: model.label },
          (onP) => downloadComfyUIModel(model, onP, ctrl.signal),
          async () => {
            // Persist active model selection for this role
            const settingsKey = ROLE_SETTINGS_KEY[model.role]
            if (settingsKey) { await setAppSetting(settingsKey, model.id) }
            await recordInstalled(model.id)
          },
        ))) return
      }

      // Spawn ComfyUI in the background — takes 30–120s to warm up
      spawnComfyUI(config)
    }

    // ── Optional capabilities chosen in the wizard ───────────────────────────
    // Voice, Wake Word, and the Offline Library runtime install through the shared
    // registry so coverage matches Admin → Features. In essentialOnly mode, only
    // "base" components (those needed from first boot) install inline; everything
    // else is handed to the background job manager.
    const componentLane = async (): Promise<void> => {
      for (const cid of inlineComponentIds) {
        if (cancelled) return
        const comp = getInstallComponent(cid)
        if (!comp) continue
        // Skip ComfyUI components — handled by the image lane above.
        if (cid === 'comfyui-base' || cid === 'comfyui-nodes') continue
        if (comp.isInstalled()) { await recordInstalled(cid); continue }

        const base = { id: cid, role: 'component', label: comp.label }
        await emit('start', { ...base, status: 'downloading' })
        try {
          await comp.repair((p) => { void emit('progress', { ...base, ...p }) }, ctrl.signal)
          await recordInstalled(cid)
          // Offline Library: spawn the ZIM server if archives were already installed.
          if (cid === 'kiwix-tools') {
            const rows = await db.select().from(zimArchivesTable)
            const zimPaths = rows.map((r) => r.filePath).filter(Boolean) as string[]
            if (zimPaths.length > 0) maybeSpawnKiwix(zimPaths).catch(() => {})
          }
          await emit('complete', { ...base, status: 'complete' })
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            cancelled = true
            await emit('cancelled', { ...base, status: 'cancelled' })
            return
          }
          // Non-fatal — any capability can be installed later from Admin → Features.
          await emit('error', { ...base, status: 'error', error: String(err) })
        }
      }
    }

    // ── Run all lanes concurrently ────────────────────────────────────────────
    // Ollama-registry pulls ∥ HuggingFace files ∥ ComfyUI stack ∥ components.
    // Each lane stays sequential internally; per-item errors are non-fatal inside
    // their lane, and a user cancel flips `cancelled` + aborts in-flight work.
    await Promise.all([
      modelLane(nonImageModels.filter((m) => m.backend === 'ollama')),
      modelLane(nonImageModels.filter((m) => m.backend !== 'ollama')),
      imageLane(),
      componentLane(),
    ])
    // Flush any queued SSE writes before finalizing.
    await writeChain
    if (cancelled) return

    // Hand the non-essential set to the background job manager so it finishes after boot.
    // Base components (tesseract) already installed inline above — exclude them here.
    if (essentialOnly) {
      await enqueueBackground({
        modelIds: backgroundModelIds,
        componentIds: componentIds.filter(id => !BASE_COMPONENT_IDS.has(id)),
        zimSelections: body.zimSelections ?? [],
        maps: body.maps ?? null,
      })
    }

    // Finalize first run: the app will now admit the user. Skip this when the chat LLM
    // failed (the wizard keeps the user on the retry screen; finalizing here would admit
    // them into a broken, chatless app).
    //
    // essentialOnly mode does NOT flip first_run_complete here: the wizard now BLOCKS on
    // the background setup track (the selected models + capabilities enqueued above) and
    // calls POST /finish only once they've all finished downloading, or when the admin
    // explicitly opts to open the app early. Flipping it here would let a reload admit the
    // user mid-download - exactly the "opened into a half-installed app" problem we're
    // fixing. The full-install path (essentialOnly === false) still finalizes inline,
    // since it installs everything before reaching this point.
    if (!essentialLlmFailed) {
      // Sentinel: this install went through the consent-aware setup wizard.
      // The boot migration guard uses this to skip auto-granting consent for new installs.
      await setAppSetting('consent_system_present', true)
      if (!essentialOnly) {
        await setAppSetting('first_run_complete', true)
        await setAppSetting('setup_state', null)  // clear saved resume progress
      }
      // Warm up the newly active model so the first chat response is immediate
      warmupModel()
    }

    await stream.writeSSE({ event: 'done', data: '{}' })
  })
})

export { setup }
