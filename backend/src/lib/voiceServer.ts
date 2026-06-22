import { join } from 'node:path'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dataDir } from '@/lib/download'
import { ensureNode } from '@/lib/node'

// Manages the Bun voice-server sidecar (Kokoro TTS + Whisper STT). Mirrors the
// kiwix sidecar pattern: spawn detached, poll /health, expose install detection.

export const VOICE_PORT = parseInt(process.env.VOICE_SERVER_PORT ?? '8091')
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
  onStatus('Voice models ready')
}

// ── State machine ────────────────────────────────────────────────────────────
export type VoiceState = 'idle' | 'starting' | 'ready' | 'failed'
const state = { current: 'idle' as VoiceState, error: '' }
let pollTimer: ReturnType<typeof setTimeout> | null = null
let proc: ChildProcess | null = null

export function getVoiceServerState(): VoiceState { return state.current }
function markReady() { state.current = 'ready'; state.error = ''; clearPoll() }
function markFailed(msg: string) { state.current = 'failed'; state.error = msg; clearPoll() }
function clearPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null } }

export function spawnVoiceServer(): void {
  if (state.current === 'starting' || state.current === 'ready') return
  if (!isVoiceServerInstalled()) return
  // Mark starting synchronously so concurrent callers bail; resolving Node may auto-download.
  state.current = 'starting'
  state.error = ''
  void ensureNode().then((nodeExe) => {
    if (state.current !== 'starting') return  // cancelled/changed while resolving
    // Node (not Bun): onnxruntime-node's native addon segfaults under Bun.
    const child = spawn(nodeExe, [VOICE_SCRIPT], {
      cwd: BACKEND_DIR,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, VOICE_SERVER_PORT: String(VOICE_PORT), VOICE_CACHE_DIR: voiceModelsDir },
    })
    proc = child
    child.unref()
    startHealthPoll()
  }).catch((err) => markFailed(`could not resolve Node runtime: ${err}`))
}

/** Stop the voice-server sidecar on shutdown (it is spawned detached + unref'd). */
export function stopVoiceServer(): void {
  clearPoll()
  if (proc) {
    try { proc.kill('SIGTERM') } catch { /* already gone */ }
    proc = null
  }
  state.current = 'idle'
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
