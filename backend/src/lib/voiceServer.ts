import { join } from 'node:path'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dataDir } from '@/lib/download'
import { ensureNode } from '@/lib/node'
import { spawnDetachedHidden } from '@/lib/platform'
import { logger } from '@/lib/logger'
import { getAppSetting, setAppSetting } from '@/lib/settings'

// Voice compute backend for the sidecar, chosen by the admin (or 'auto' = let the
// sidecar detect). 'auto'/'cpu'/'cuda'/'dml' — see scripts/voice-server.ts for
// which the runtime can actually use on each platform. Persisted as `voice.device`.
export type VoiceDeviceSetting = 'auto' | 'cpu' | 'cuda' | 'dml'
export const VOICE_DEVICE_SETTING_KEY = 'voice.device'

/** Build the extra env passed to the spawned sidecar from admin settings. 'auto'
 *  (or unset) leaves VOICE_DEVICE off so the sidecar auto-detects; any explicit
 *  choice is forwarded and honored (still with a CPU fallback if it fails to load). */
async function sidecarDeviceEnv(): Promise<Record<string, string>> {
  const raw = await getAppSetting(VOICE_DEVICE_SETTING_KEY)
  const device = (typeof raw === 'string' ? raw : 'auto') as VoiceDeviceSetting
  return device && device !== 'auto' ? { VOICE_DEVICE: device } : {}
}

// Manages the Bun voice-server sidecar (Kokoro TTS + Whisper STT). Mirrors the
// kiwix sidecar pattern: spawn detached, poll /health, expose install detection.

// NOTE: 8091 is taken by the SearXNG sidecar (see lib/searxng.ts). Keep these on
// distinct ports — when both bound 8091, macOS routed localhost:8091 to SearXNG's
// 127.0.0.1 bind and every TTS request silently hit the wrong server (no audio).
export const VOICE_PORT = parseInt(process.env.VOICE_SERVER_PORT ?? '8092')
const BACKEND_DIR = join(import.meta.dir, '../..')
const VOICE_SCRIPT = join(BACKEND_DIR, 'scripts/voice-server.ts')

export const voiceModelsDir = join(dataDir, 'voice', 'models')
const KOKORO_DIR = join(voiceModelsDir, 'onnx-community', 'Kokoro-82M-v1.0-ONNX')
// Must mirror the sidecar's KOKORO_DTYPE default (voice-server.ts) so we check the
// same weights file the server will actually try to load.
const TTS_DTYPE = process.env.KOKORO_DTYPE ?? 'q4'
const KOKORO_MODEL_FILE = join(KOKORO_DIR, 'onnx', `model_${TTS_DTYPE}.onnx`)
// Written only after a warm fully completes — the real "ready" signal.
const READY_MARKER = join(KOKORO_DIR, '.installed')

export function voiceServerLocalUrl(): string {
  return `http://127.0.0.1:${VOICE_PORT}`
}

/**
 * Installed only once the model WEIGHTS have fully downloaded — not merely the
 * directory (its tiny config files land minutes before the ~305 MB model_q4.onnx,
 * and spawning the server in that window made it load a half-written file and fail
 * with "Protobuf parsing failed"). The `.installed` marker is the precise signal;
 * for pre-marker installs we accept a near-complete weights file and stamp it.
 */
export function isVoiceServerInstalled(): boolean {
  if (existsSync(READY_MARKER)) return true
  try {
    if (statSync(KOKORO_MODEL_FILE).size >= 280 * 1024 * 1024) { writeFileSync(READY_MARKER, ''); return true }
  } catch { /* weights absent or partial */ }
  return false
}

/** Stamp the ready marker once a warm has completed and the weights are present. */
function markVoiceInstalled(): void {
  try { if (existsSync(KOKORO_MODEL_FILE)) writeFileSync(READY_MARKER, '') } catch { /* best effort */ }
}

// ── Install (download/warm models) ───────────────────────────────────────────
export async function installVoiceModels(onStatus: (msg: string) => void, signal?: AbortSignal): Promise<void> {
  onStatus('Downloading Kokoro + Whisper models (first run, ~300 MB)…')
  // Resolve (and, if needed, auto-download) a TS-capable Node — the sidecar can't run under Bun.
  const nodeExe = await ensureNode()
  let warmedOk = false
  await new Promise<void>((resolve, reject) => {
    // Node (not Bun): onnxruntime-node's native addon segfaults under Bun.
    const proc = spawn(nodeExe, [VOICE_SCRIPT, 'warm'], {
      cwd: BACKEND_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, VOICE_CACHE_DIR: voiceModelsDir },
    })
    const onLine = (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (!line) return
      // The sidecar prints this only after the models have loaded successfully, which
      // means the weights finished downloading — our true completion signal.
      if (line.includes('models ready')) warmedOk = true
      onStatus(line)
    }
    proc.stdout.on('data', onLine)
    proc.stderr.on('data', onLine)
    // onnxruntime-node can abort during process teardown AFTER models are ready
    // (a benign libc++ mutex error). Don't fail on a non-zero exit — the real
    // gate is whether the warm reported ready and the weights actually landed.
    proc.on('close', () => resolve())
    proc.on('error', reject)
    signal?.addEventListener('abort', () => {
      proc.kill()
      reject(new DOMException('Cancelled', 'AbortError'))
    })
  })
  if (!warmedOk || !existsSync(KOKORO_MODEL_FILE)) {
    throw new Error('voice models warmed but Kokoro weights not found — install may have failed')
  }
  markVoiceInstalled()
  // Configure the compute backend on first install (wizard / repair): default to
  // 'auto' so the sidecar picks the best device the runtime can use per platform
  // (CUDA on Linux+NVIDIA, CPU elsewhere) with a CPU fallback. Left untouched if the
  // admin already chose one. The admin can override + benchmark under Voice > Engine.
  if ((await getAppSetting(VOICE_DEVICE_SETTING_KEY)) == null) {
    await setAppSetting(VOICE_DEVICE_SETTING_KEY, 'auto')
    onStatus('Compute backend set to auto-detect (CPU, or NVIDIA CUDA on Linux)')
  }
  onStatus('Voice models ready')
}

// ── State machine ────────────────────────────────────────────────────────────
export type VoiceState = 'idle' | 'starting' | 'ready' | 'failed'
const state = { current: 'idle' as VoiceState, error: '' }
let pollTimer: ReturnType<typeof setTimeout> | null = null
let proc: ChildProcess | null = null

export function getVoiceServerState(): VoiceState { return state.current }
function markReady() { state.current = 'ready'; state.error = ''; clearPoll(); startSupervision() }
function markFailed(msg: string) { state.current = 'failed'; state.error = msg; clearPoll() }
function clearPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null } }

// ── Post-ready supervision ───────────────────────────────────────────────────
// The startup poll stops at markReady(); if the sidecar dies later (onnxruntime
// crash, OOM) the state would stay 'ready' with nothing respawning it. A
// low-frequency liveness re-probe catches that and restarts — capped so a
// persistently-crashing sidecar can't respawn-loop forever.

const SUPERVISE_INTERVAL_MS = 60_000
const SUPERVISE_RETRY_MS    = 5_000       // quick re-probe before declaring death
const RESTART_WINDOW_MS     = 10 * 60_000
const RESTART_MAX           = 3

let superviseTimer: ReturnType<typeof setTimeout> | null = null
let superviseFailures = 0
let restartTimes: number[] = []

function stopSupervision(): void {
  if (superviseTimer) { clearTimeout(superviseTimer); superviseTimer = null }
  superviseFailures = 0
}

function startSupervision(): void {
  if (superviseTimer) return  // already supervising this instance
  superviseFailures = 0
  async function tick(): Promise<void> {
    if (state.current !== 'ready') { superviseTimer = null; return }
    let ok = false
    try {
      const r = await fetch(`${voiceServerLocalUrl()}/health`, { signal: AbortSignal.timeout(3_000) })
      ok = r.ok
    } catch { /* down or wedged */ }
    if (state.current !== 'ready') { superviseTimer = null; return }  // stopped while probing
    if (ok) {
      superviseFailures = 0
      superviseTimer = setTimeout(() => void tick(), SUPERVISE_INTERVAL_MS)
      return
    }
    superviseFailures++
    if (superviseFailures < 2) {
      superviseTimer = setTimeout(() => void tick(), SUPERVISE_RETRY_MS)
      return
    }
    superviseTimer = null
    handleCrash()
  }
  superviseTimer = setTimeout(() => void tick(), SUPERVISE_INTERVAL_MS)
}

// Shared respawn path for the liveness probe and the child 'exit' accelerator.
// Old restart timestamps age out of the window, so a sustained healthy period
// naturally resets the cap.
function handleCrash(): void {
  stopSupervision()
  const now = Date.now()
  restartTimes = restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
  if (restartTimes.length >= RESTART_MAX) {
    markFailed(`voice-server crashed ${RESTART_MAX}+ times within 10 minutes — giving up`)
    logger.error('[voice] voice-server keeps crashing — not respawning again (restart the backend to retry)')
    return
  }
  restartTimes.push(now)
  logger.warn('[voice] voice-server died — respawning')
  state.current = 'idle'
  state.error   = ''
  void maybeSpawnVoiceServer()
}

export function spawnVoiceServer(): void {
  if (state.current === 'starting' || state.current === 'ready') return
  if (!isVoiceServerInstalled()) return
  // Mark starting synchronously so concurrent callers bail; resolving Node may auto-download.
  state.current = 'starting'
  state.error = ''
  void ensureNode().then(async (nodeExe) => {
    if (state.current !== 'starting') return  // cancelled/changed while resolving
    // Admin-selected compute backend (auto/cpu/cuda/dml) → sidecar env.
    const deviceEnv = await sidecarDeviceEnv()
    if (state.current !== 'starting') return  // changed while reading the setting
    // Node (not Bun): onnxruntime-node's native addon segfaults under Bun.
    const child = spawnDetachedHidden(nodeExe, [VOICE_SCRIPT], {
      cwd: BACKEND_DIR,
      env: { ...process.env, VOICE_SERVER_PORT: String(VOICE_PORT), VOICE_CACHE_DIR: voiceModelsDir, ...deviceEnv },
    })
    proc = child
    // Crash accelerator while we still hold the handle (post hot-reload the sidecar is
    // an adopted orphan and only the HTTP probe can catch a crash). stopVoiceServer
    // nulls proc before the exit event fires, so intentional kills never respawn.
    child.on('exit', () => {
      if (proc !== child) return
      proc = null
      if (state.current === 'ready') handleCrash()
    })
    child.unref()
    startHealthPoll()
  }).catch((err) => markFailed(`could not resolve Node runtime: ${err}`))
}

/** Stop the voice-server sidecar on shutdown (it is spawned detached + unref'd). */
export function stopVoiceServer(): void {
  clearPoll()
  stopSupervision()  // intentional stop (shutdown) must never trigger a respawn
  if (proc) {
    try { proc.kill('SIGTERM') } catch { /* already gone */ }
    proc = null
  }
  state.current = 'idle'
}

/** Stop and respawn the sidecar so a changed compute backend (voice.device) takes
 *  effect, then wait until it reports healthy again (or fails). Used by the admin
 *  "restart voice engine" action after toggling the device. */
export async function restartVoiceServer(): Promise<VoiceState> {
  stopVoiceServer()
  // stopVoiceServer set state to 'idle'; a fresh spawn will re-run the health poll.
  spawnVoiceServer()
  // Wait out the startup poll (bounded by its own 120s deadline) so the caller can
  // report the resulting state + device rather than returning mid-'starting'.
  const deadline = Date.now() + 125_000
  while (state.current === 'starting' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
  }
  return state.current
}

export async function maybeSpawnVoiceServer(): Promise<void> {
  if (state.current === 'starting' || state.current === 'ready') return
  if (!isVoiceServerInstalled()) return
  try {
    const r = await fetch(`${voiceServerLocalUrl()}/health`, { signal: AbortSignal.timeout(2_000) })
    if (r.ok) { markReady(); return }
  } catch { /* not running */ }
  spawnVoiceServer()
}

function startHealthPoll(): void {
  clearPoll()
  const deadline = Date.now() + 120_000 // model load can take a while on first run
  async function poll() {
    if (state.current !== 'starting') return
    try {
      const r = await fetch(`${voiceServerLocalUrl()}/health`, { signal: AbortSignal.timeout(3_000) })
      if (r.ok) { markReady(); return }
    } catch { /* not up yet */ }
    if (Date.now() >= deadline) { markFailed('voice-server did not start within 120 seconds'); return }
    pollTimer = setTimeout(poll, 2_000)
  }
  pollTimer = setTimeout(poll, 1_000)
}
