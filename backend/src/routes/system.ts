import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { existsSync } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import { logger } from '@/lib/logger'
import { getModel, getWarmupPromise } from '@/lib/models'
import { seedHardwareDefaults, detectHardware, resolveComfyUILaunchConfig, resolveGpuPlacement } from '@/lib/hwfit'
import { resolveEngineGuards } from '@/lib/engineGuards'
import { resolveEngineAutotune } from '@/lib/engineAutotune'
import { resolveResourceMode } from '@/lib/resourceMode'
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
  ollamaServeEnv,
  isWakewordCoreInstalled,
  isWakewordTrainInstalled,
} from '@/lib/download'
import { killByCommandLine, spawnDetachedHidden } from '@/lib/platform'
import { sweepOrphanLlamaRunners } from '@/lib/ollamaHygiene'
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
import { INSTALL_COMPONENTS, getInstallComponent, getInstalledLedger, recordInstalled, IMAGE_ROLES, availablePackageManagers, type InstallComponent } from '@/lib/installRegistry'
import { enqueueBackground, scanAndRepairCorruptImageModels } from '@/lib/downloadJobs'
import { checkOsFingerprint, stampOsFingerprint } from '@/lib/osFingerprint'
import { getRestorePlan, saveRestorePlan, clearRestorePlan, type RestoreAttentionItem } from '@/lib/restorePlan'
import { isDownloadBlocked } from '@/lib/connectivity'
import { seedFeatureSwitchesOnce } from '@/lib/features/orchestrator'
import { requireAdmin } from '@/middleware/auth'
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
//
// Repairs are TIERED (the "OS drive wiped, data drive survived" design):
//   • attention — needs elevation or a package manager that is itself gone: never
//     auto-run; recorded on the restore plan so the admin sees why and what to do.
//   • consent   — the OS fingerprint changed (fresh OS install) or the total
//     re-download exceeds AUTO_RESTORE_MAX_BYTES: recorded as a pending restore
//     plan; the admin gets a one-click "Restore" prompt in the app instead of us
//     silently pulling gigabytes.
//   • auto      — small drift (or consent already given): enqueued to the durable
//     background queue exactly as before, surfaced by the global setup widget.

// Silent-heal budget per boot when the OS didn't change. Above this we ask first.
const AUTO_RESTORE_MAX_BYTES = 1_500_000_000

async function reconcileInstalls(broadcast: BroadcastFn, osChanged: boolean): Promise<void> {
  // Repair-of-missing stays NON-BLOCKING: auto-tier work is handed to the background
  // download-job manager so the app boots immediately. Boot only blocks on the
  // truly-core models (steps 4–5: chat LLM + embeddings + router), handled inline above.
  const bgModelIds: string[] = []
  let modelBytes = 0

  // (a) Configured Ollama role models that have gone missing → background.
  try {
    const tagsRes = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5_000) })
    const { models } = await tagsRes.json() as { models: { name: string }[] }
    const have = (tag: string) => {
      const prefix = tag.split(':')[0] ?? tag
      return models.some((m) => m.name === tag || m.name.startsWith(prefix))
    }
    for (const settingKey of ['router_llm_model', 'vision_model', 'coding_model']) {
      const modelId = await getAppSetting(settingKey) as string | null
      if (!modelId) continue
      const cat = CATALOG.find((m) => m.id === modelId && m.backend === 'ollama' && m.ollamaTag)
      if (!cat?.ollamaTag || have(cat.ollamaTag)) continue
      bgModelIds.push(modelId)
      modelBytes += cat.approxBytes ?? 0
    }
  } catch { /* Ollama unreachable — skip model reconcile */ }

  // (b) Registry components recorded in the install ledger → collect if missing.
  const missingComponents: InstallComponent[] = []
  try {
    const ledgerSet = new Set(await getInstalledLedger())
    for (const comp of INSTALL_COMPONENTS) {
      let installed = false
      try { installed = comp.isInstalled() } catch { installed = false }
      if (installed && comp.verify) {
        // Files on the data drive can survive an OS wipe yet be broken — a venv whose
        // launcher points at a base Python that no longer exists. Actually running the
        // binary is the only honest check; a probe error (not a clean failure) is
        // treated as healthy so a busy machine never triggers a multi-GB rebuild.
        try { installed = await comp.verify() } catch { /* probe inconclusive — trust file check */ }
      }
      if (installed) {
        if (!ledgerSet.has(comp.id)) { try { await recordInstalled(comp.id) } catch { /* ignore */ } }
        continue
      }
      if (!ledgerSet.has(comp.id)) continue // never chosen — leave alone
      missingComponents.push(comp)
    }

    // The real-RIR pack ships bundled with Wake Word Training but was added later,
    // so installs that predate it have the trainer but not the pack — and never
    // explicitly "chose" the pack, so the loop above leaves it alone. Bridge that:
    // if the training feature is present, heal the pack too (idempotent; the pack's
    // own download early-returns once complete).
    const rir = getInstallComponent('wakeword-train-rir')
    const hasTraining = ledgerSet.has('wakeword-train') || isWakewordTrainInstalled()
    if (rir && hasTraining && !rir.isInstalled() && !missingComponents.some((c) => c.id === rir.id)) {
      missingComponents.push(rir)
    }

    // Same bridge for the Silero VAD model: it ships alongside Voice but was
    // added later, so installs that predate it never "chose" it. If voice is
    // present, heal the VAD model too (STT + barge-in run energy-only until
    // the ~2 MB download lands; the next STT session picks it up live).
    const vad = getInstallComponent('silero-vad')
    const hasVoice = ledgerSet.has('voice-core') || isVoiceServerInstalled()
    if (vad && hasVoice && !vad.isInstalled() && !missingComponents.some((c) => c.id === vad.id)) {
      missingComponents.push(vad)
    }

    // Headless Chromium powers Canvas → PDF export AND the Reader archive, but was
    // only ever lazy-installed before — so no install has it in the ledger. Chat is
    // universal in this app and this reconcile only runs post-first-run, so heal it
    // whenever it's missing (background, non-blocking; the ~150MB lands and the next
    // export/archive picks it up live). Matches "install in the wizard + heal as part
    // of chat".
    const chromium = getInstallComponent('chromium-render')
    if (chromium && !chromium.isInstalled() && !missingComponents.some((c) => c.id === chromium.id)) {
      missingComponents.push(chromium)
    }
  } catch { /* ledger unreadable — skip */ }

  // ── Tier the missing set ──────────────────────────────────────────────────────
  const attention: RestoreAttentionItem[] = []
  const repairable: InstallComponent[] = []
  const pkgManagers = availablePackageManagers()
  for (const comp of missingComponents) {
    if (comp.needsElevation) {
      attention.push({
        id: comp.id, label: comp.label,
        reason: 'Reinstalling needs a one-time OS administrator approval — run it from Admin → Features when you\'re at the machine.',
      })
    } else if (comp.needsPackageManager && pkgManagers.length === 0) {
      attention.push({
        id: comp.id, label: comp.label,
        reason: process.platform === 'win32'
          ? 'Needs a package manager. Install "App Installer" (winget) from the Microsoft Store, then repair from Admin → Features.'
          : 'Needs a package manager (Homebrew or apt-get). Install one, then repair from Admin → Features.',
      })
    } else {
      repairable.push(comp)
    }
  }

  const bgComponentIds = repairable.map((c) => c.id)
  const totalBytes = modelBytes + repairable.reduce((s, c) => s + (c.approxBytes ?? 0), 0)
  const allIds = [...bgModelIds, ...bgComponentIds]
  const prior = await getRestorePlan()

  if (!allIds.length && !attention.length) {
    if (prior) await clearRestorePlan()
    if (osChanged) {
      step(broadcast, { key: 'restore', label: 'Fresh OS install detected — nothing to restore, all components intact', status: 'ok' })
    }
    return
  }

  // A dismissed plan stays dismissed as long as nothing NEW went missing — dismissing
  // must not re-prompt on every boot. Consent ('started') persists the same way.
  const priorIds = prior
    ? new Set([...prior.componentIds, ...prior.modelIds, ...prior.attention.map((a) => a.id)])
    : new Set<string>()
  const coveredByPrior = allIds.every((id) => priorIds.has(id)) && attention.every((a) => priorIds.has(a.id))
  const consentGiven = prior?.status === 'started'
  const staysDismissed = prior?.status === 'dismissed' && coveredByPrior

  const needsConsent = !consentGiven && (osChanged || totalBytes > AUTO_RESTORE_MAX_BYTES)

  if (needsConsent) {
    await saveRestorePlan({
      createdAt: prior?.createdAt ?? new Date().toISOString(),
      osChanged: osChanged || (prior?.osChanged ?? false),
      componentIds: bgComponentIds,
      modelIds: bgModelIds,
      totalBytes,
      attention,
      status: staysDismissed ? 'dismissed' : 'pending',
    })
    if (!staysDismissed) {
      const gb = (totalBytes / 1_000_000_000).toFixed(1)
      step(broadcast, {
        key: 'restore',
        label: osChanged
          ? `Fresh OS install detected — ${allIds.length} previously installed item(s) to restore (~${gb} GB)`
          : `${allIds.length} previously installed item(s) need restoring (~${gb} GB)`,
        status: 'warn',
        detail: 'An admin will be asked before downloading',
      })
    }
    return
  }

  // Auto tier: small drift, or the admin already clicked Restore — enqueue now.
  if (allIds.length) {
    // force: true — every id here was already live-verified missing (Ollama /api/tags
    // lookup above, or comp.isInstalled() in the loop below), so a stale "completed" row
    // from before a wipe must not block re-enqueuing it. Without this, enqueueBackground's
    // dedup trusts the old status and silently never re-downloads the actually-missing file.
    await enqueueBackground({ modelIds: bgModelIds, componentIds: bgComponentIds, force: true })
  }

  if (attention.length) {
    // Keep (only) the can't-auto-fix items on the plan so the admin prompt explains them.
    await saveRestorePlan({
      createdAt: prior?.createdAt ?? new Date().toISOString(),
      osChanged: osChanged || (prior?.osChanged ?? false),
      componentIds: [], modelIds: [], totalBytes: 0,
      attention,
      status: staysDismissed ? 'dismissed' : 'pending',
    })
  } else if (prior && !allIds.length) {
    await clearRestorePlan()
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

  // ── 0b. OS fingerprint — was the OS reinstalled under us? ─────────────────────
  // data/ (models, app.db, the install ledger) survives an OS-drive wipe; everything
  // installed on the system drive doesn't. Detecting the reinstall explicitly lets
  // the boot screen SAY why things are being restored instead of silently
  // re-downloading, and flips reconcileInstalls into consent-first restore mode.
  let osChanged = false
  try {
    osChanged = (await checkOsFingerprint()) === 'changed'
    if (osChanged) {
      logger.warn('[boot] OS fingerprint changed — fresh OS install detected, entering restore mode')
      step(broadcast, {
        key: 'restore-note',
        label: 'Fresh OS install detected — your Loki Doki data drive is intact',
        status: 'ok',
        detail: 'Checking what needs restoring',
      })
    }
  } catch { /* fingerprint is best-effort — never blocks boot */ }

  // ── 0c. GPU placement — decide who gets which card BEFORE anything spawns ────
  // Populates the cached placement that ollamaServeEnv() reads, so the very first
  // Ollama spawn below already lands on the right GPU(s) on multi-GPU machines.
  try { await resolveGpuPlacement() } catch { /* no NVIDIA tooling — stays unpinned */ }
  // Same deal for the admin engine guards (max loaded models, KV cache type, …): the
  // spawn env is synchronous, so the persisted values must be cached before the spawn.
  try { await resolveEngineGuards() } catch { /* defaults apply */ }
  // The one resource switch (automatic|manual) gates every subsystem's auto-vs-manual
  // placement; cache it before the first getModel()/spawn reads it.
  try { await resolveResourceMode() } catch { /* defaults to automatic */ }
  // VRAM-fit the chat model + context BEFORE warmup/first spawn, so an auto-managed
  // model never lands oversized and spilling. Cached for getModel()/autotunedNumCtx().
  try { await resolveEngineAutotune() } catch { /* no NVIDIA tooling — safe defaults */ }

  // ── 0. Kill stale project-owned Ollama binary ────────────────────────────────
  // Only when a system install exists to take over: the CLI-only extracted binary
  // (data/bin/ollama) lacked the runner binaries modern Ollama needs, so a system
  // Ollama should win. On machines with no system install the managed copy IS the
  // intended Ollama — killing it unconditionally took a healthy server down on
  // every boot, and the respawn raced the reachability checks below into a false
  // "Ollama unreachable" warning.
  const managedBin = join(dataDir, OLLAMA_BIN_DEST)
  if (existsSync(managedBin) && findSystemOllama()) {
    await killByCommandLine(managedBin)
    // Give the process time to exit before we try to connect
    await new Promise<void>((r) => setTimeout(r, 800))
  }
  // `ollama serve` takes a few seconds to bind after being spawned — wait for it to
  // accept connections so the "Connecting to Ollama" check below doesn't falsely
  // report "Ollama unreachable" and skip restoring every model as a result.
  async function waitForOllamaReachable(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try { const r = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(1_500) }); if (r.ok) return } catch { /* keep waiting */ }
      await new Promise<void>((r) => setTimeout(r, 1_000))
    }
  }

  // Ensure system Ollama server is running — spawn the binary directly so the
  // GUI app window doesn't open. Only start if not already reachable.
  try {
    const ping = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(1_500) })
    if (!ping.ok) throw new Error('not ready')
  } catch {
    // Ollama isn't answering - a previous crash/kill may have left llama-server
    // orphans squatting VRAM. Reap them before spawning fresh (they can never be
    // reached again; leaving them forces new model loads onto the CPU).
    await sweepOrphanLlamaRunners('boot-reconcile')
    const systemBin = findSystemOllama()
    if (systemBin) {
      spawnDetachedHidden(systemBin, ['serve'], { env: ollamaServeEnv() }).unref()
      await waitForOllamaReachable(20_000)
    } else {
      // No system Ollama. downloadAndStartOllama reuses the managed binary when it
      // already exists (just respawns it) and only downloads when it's truly absent —
      // label the step accordingly so a plain restart doesn't read as a reinstall.
      step(broadcast, {
        key: 'ollama',
        label: existsSync(managedBin) ? 'Starting Ollama…' : 'Installing Ollama runtime…',
        status: 'running',
      })
      try {
        await downloadAndStartOllama((p) => broadcast('repair', JSON.stringify({ key: 'ollama', ...p })))
        // downloadAndStartOllama only spawns the process — it doesn't wait for the
        // server to actually bind, so give it the same grace period as the
        // systemBin branch above before the reachability check 3 steps down.
        await waitForOllamaReachable(20_000)
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
      const tagsRes = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(10_000) })
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
        // Await that shared promise instead of firing a duplicate generate request —
        // but BOUNDED: when Ollama is busy (training/eval fleets, model churn) the
        // warmup can take many minutes, and an unbounded await here holds boot.done
        // (and therefore /api/system/ready) hostage the whole time. Warmup keeps
        // finishing in the background either way.
        step(broadcast, { key: 'llm', label: `Loading ${model} into memory`, status: 'running' })
        try {
          const timedOut = Symbol('warmup-timeout')
          const winner = await Promise.race([
            (getWarmupPromise() ?? Promise.resolve()),
            new Promise((r) => setTimeout(() => r(timedOut), 90_000)),
          ])
          if (winner === timedOut) {
            step(broadcast, { key: 'llm', label: `${model} still loading`, status: 'warn', detail: 'Continuing in background' })
          } else {
            step(broadcast, { key: 'llm', label: `${model} ready`, status: 'ok', detail: 'Resident in memory' })
          }
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
  // The boot sequence handles the remaining cases:
  //   0) corrupt model files — verify + quarantine + re-queue before anything uses them
  //   a) venv Python < 3.10 — rebuild in-place with progress streamed to the boot screen
  //   b) partial model downloads — resume them
  step(broadcast, { key: 'image', label: 'Checking image generation', status: 'running' })

  const comfyAlive = await fetch(`${comfyUrl()}/system_stats`, { signal: AbortSignal.timeout(2_000) })
    .then(r => { if (r.ok) markComfyUIReady(); return r.ok })
    .catch(() => false)

  const comfyInstalled = isComfyUIInstalled()
  let imgOk = comfyAlive || getComfyUIState() === 'warming'

  // (0) Verify installed model files aren't corrupt — catches a checkpoint/LoRA that went
  // bad after it already passed its post-download check (disk fault, or — as happened once
  // — a header-coverage bug that let a truncated safetensors file through as "valid"). Runs
  // before anything below touches these files, so a bad checkpoint never reaches a live
  // generation; index.ts also runs this once at process start, but this pass is the one
  // that's visible on the boot screen so a returning user sees why a re-download started.
  if (comfyInstalled) {
    step(broadcast, { key: 'image', label: 'Verifying image model files…', status: 'running' })
    try {
      const repaired = await scanAndRepairCorruptImageModels()
      // No dedicated "repairing" UI here — a quarantined file is now simply missing, so
      // the existing missingImageModel check below naturally reports "will set up in the
      // background" and the download queue's own widget takes over from there.
      if (repaired.length) logger.warn(`[boot] quarantined corrupt model file(s): ${repaired.join(', ')}`)
    } catch (e) {
      logger.warn(`[boot] image model integrity scan failed: ${e}`)
    }
  }

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
      // execFile (async), not execSync: a sync probe freezes the whole event loop
      // for up to its 5 s timeout while boot runs, stalling every other request.
      const { stdout } = await execFileAsync(
        venvPython(), ['-c', 'import sys; print(sys.version_info.minor)'],
        { encoding: 'utf8', timeout: 5_000, windowsHide: true },
      )
      if (parseInt(stdout.trim(), 10) < 10) venvCompatible = false
    } catch { /* assume compatible */ }

    if (!venvCompatible) {
      step(broadcast, { key: 'image', label: 'Upgrading Python environment for image generation…', status: 'running' })
      const hw     = await detectHardware()
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

  // ── Seed the one-switch feature gates from installed reality (one-time) ────────
  // Before reconcile so healing sees the same ledger it always has; only writes
  // app_feature.* rows that do not exist yet.
  try {
    await seedFeatureSwitchesOnce()
  } catch (err) {
    logger.warn(`[boot] feature switch seeding failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── Reconcile: repair any previously-installed item that has gone missing ──────
  await reconcileInstalls(broadcast, osChanged)

  // Stamp only AFTER reconcile persisted the restore plan — a crash mid-boot then
  // re-detects the change next boot instead of losing the "OS was reinstalled" signal.
  await stampOsFingerprint()

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
    startBootSequence()

    await settled
  })
})

// ── Restore plan (OS-wipe / large-repair consent) ─────────────────────────────
// The pending plan reconcileInstalls recorded, decorated with labels + sizes for
// the admin-facing RestorePrompt. Admin-only: it both reveals system layout and
// gates multi-GB downloads.

system.get('/restore', requireAdmin, async (c) => {
  const plan = await getRestorePlan()
  if (!plan) return c.json({ plan: null })
  const components = plan.componentIds.map((id) => {
    const comp = getInstallComponent(id)
    return { id, label: comp?.label ?? id, approxBytes: comp?.approxBytes ?? 0 }
  })
  const models = plan.modelIds.map((id) => {
    const m = CATALOG.find((x) => x.id === id)
    return { id, label: m?.label ?? id, approxBytes: m?.approxBytes ?? 0 }
  })
  return c.json({ plan: { ...plan, components, models } })
})

// One-click consent: hand the whole plan to the durable background queue (force —
// each id was live-verified missing) and let the global setup widget show progress.
system.post('/restore/start', requireAdmin, async (c) => {
  if (await isDownloadBlocked()) return c.json({ error: 'Offline mode is active — downloads are unavailable.' }, 503)
  const plan = await getRestorePlan()
  if (!plan) return c.json({ ok: true, queued: 0 })
  const queued = await enqueueBackground({ modelIds: plan.modelIds, componentIds: plan.componentIds, force: true })
  await saveRestorePlan({ ...plan, status: 'started' })
  return c.json({ ok: true, queued })
})

// "Not now" — stays dismissed across boots unless something NEW goes missing.
system.post('/restore/dismiss', requireAdmin, async (c) => {
  const plan = await getRestorePlan()
  if (plan) await saveRestorePlan({ ...plan, status: 'dismissed' })
  return c.json({ ok: true })
})

/**
 * Start the boot/verify sequence (idempotent). Called from index.ts at server
 * startup so a backend restart becomes ready on its own — previously boot only
 * ran when a FRESH page load hit /boot, so already-open tabs left the server at
 * /ready=503 indefinitely (admin + boot-gated UI stuck on spinners).
 */
export function startBootSequence(): void {
  if (boot.started) return
  boot.started = true
  runBoot(broadcastBoot)
    .catch((e) => logger.error(`[boot] sequence failed: ${e}`))
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

export { system }
