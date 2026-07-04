import { join } from 'node:path'
import { chmodSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { ensureNode } from '@/lib/node'
import { IS_WIN } from '@/lib/platform'
import { logger } from '@/lib/logger'

// Manages the coding-terminal PTY sidecar (see scripts/coding-pty-sidecar.ts). Mirrors
// the voice-server sidecar pattern exactly: spawn detached under Node (not Bun — see
// that script's own comment for why), poll /health, crash-restart with a capped
// window. One shared sidecar for the whole household (like voice), not per-user: it's
// stateless between connections, each WS attach carries its own spawn params.

export const CODING_PTY_PORT = parseInt(process.env.CODING_PTY_SIDECAR_PORT ?? '8094')
const BACKEND_DIR = join(import.meta.dir, '../..')
const SIDECAR_SCRIPT = join(BACKEND_DIR, 'scripts/coding-pty-sidecar.ts')

export function codingPtySidecarUrl(): string { return `http://127.0.0.1:${CODING_PTY_PORT}` }
export function codingPtySidecarWsUrl(): string { return `ws://127.0.0.1:${CODING_PTY_PORT}/attach` }

// node-pty ships a `spawn-helper` binary via optionalDependencies' platform prebuilds;
// npm/bun's tarball extraction doesn't preserve its executable bit (confirmed live:
// `posix_spawnp failed` until chmod +x'd). Cheap, idempotent — safe to call before
// every spawn, not just once, since a fresh install could land after this module first
// loads.
function ensureSpawnHelperExecutable(): void {
  // Windows uses ConPTY, which has no `spawn-helper` binary (it's a Unix node-pty artifact).
  if (IS_WIN) return
  try {
    const dir = join(BACKEND_DIR, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`)
    const helper = join(dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  } catch { /* best-effort; a real failure surfaces as a pty spawn error downstream */ }
}

type State = 'idle' | 'starting' | 'ready' | 'failed'
const state = { current: 'idle' as State, error: '' }
let pollTimer: ReturnType<typeof setTimeout> | null = null
let proc: ChildProcess | null = null

export function getCodingPtySidecarState(): State { return state.current }
function markReady() { state.current = 'ready'; state.error = ''; clearPoll(); startSupervision() }
function markFailed(msg: string) { state.current = 'failed'; state.error = msg; clearPoll() }
function clearPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null } }

const SUPERVISE_INTERVAL_MS = 60_000
const SUPERVISE_RETRY_MS    = 5_000
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
  if (superviseTimer) return
  superviseFailures = 0
  async function tick(): Promise<void> {
    if (state.current !== 'ready') { superviseTimer = null; return }
    let ok = false
    try {
      const r = await fetch(`${codingPtySidecarUrl()}/health`, { signal: AbortSignal.timeout(3_000) })
      ok = r.ok
    } catch { /* down or wedged */ }
    if (state.current !== 'ready') { superviseTimer = null; return }
    if (ok) { superviseFailures = 0; superviseTimer = setTimeout(() => void tick(), SUPERVISE_INTERVAL_MS); return }
    superviseFailures++
    if (superviseFailures < 2) { superviseTimer = setTimeout(() => void tick(), SUPERVISE_RETRY_MS); return }
    superviseTimer = null
    handleCrash()
  }
  superviseTimer = setTimeout(() => void tick(), SUPERVISE_INTERVAL_MS)
}

function handleCrash(): void {
  stopSupervision()
  const now = Date.now()
  restartTimes = restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
  if (restartTimes.length >= RESTART_MAX) {
    markFailed(`coding-pty-sidecar crashed ${RESTART_MAX}+ times within 10 minutes — giving up`)
    logger.error('[coding] coding-pty-sidecar keeps crashing — not respawning again (restart the backend to retry)')
    return
  }
  restartTimes.push(now)
  logger.warn('[coding] coding-pty-sidecar died — respawning')
  state.current = 'idle'
  state.error = ''
  void maybeSpawnCodingPtySidecar()
}

export function spawnCodingPtySidecar(): void {
  if (state.current === 'starting' || state.current === 'ready') return
  state.current = 'starting'
  state.error = ''
  ensureSpawnHelperExecutable()
  void ensureNode().then((nodeExe) => {
    if (state.current !== 'starting') return
    const child = spawn(nodeExe, [SIDECAR_SCRIPT], {
      cwd: BACKEND_DIR,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CODING_PTY_SIDECAR_PORT: String(CODING_PTY_PORT) },
    })
    proc = child
    child.on('exit', () => {
      if (proc !== child) return
      proc = null
      if (state.current === 'ready') handleCrash()
    })
    child.unref()
    startHealthPoll()
  }).catch((err) => markFailed(`could not resolve Node runtime: ${err}`))
}

export function stopCodingPtySidecar(): void {
  clearPoll()
  stopSupervision()
  // On Windows the sidecar hosts the persistent claude ptys in-process (there's no independent
  // tmux server), so SIGTERM-ing it on a graceful Bun shutdown would drop every coding session.
  // Leave it running (it's detached + unref'd) so sessions survive a backend restart; the next
  // boot re-adopts the still-listening sidecar via the /health probe in maybeSpawnCodingPtySidecar.
  if (!IS_WIN && proc) { try { proc.kill('SIGTERM') } catch { /* already gone */ } }
  proc = null
  state.current = 'idle'
}

/** Kill a persistent coding session in the sidecar (Windows model-change / admin teardown).
 *  Best-effort: a down/absent sidecar just means there's nothing to kill. */
export async function killCodingSession(sessionKey: string): Promise<void> {
  try {
    await fetch(`${codingPtySidecarUrl()}/session/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey }),
      signal: AbortSignal.timeout(3_000),
    })
  } catch { /* sidecar down/absent — nothing to kill */ }
}

export async function maybeSpawnCodingPtySidecar(): Promise<void> {
  if (state.current === 'starting' || state.current === 'ready') return
  try {
    const r = await fetch(`${codingPtySidecarUrl()}/health`, { signal: AbortSignal.timeout(2_000) })
    if (r.ok) { markReady(); return }
  } catch { /* not running */ }
  spawnCodingPtySidecar()
}

function startHealthPoll(): void {
  clearPoll()
  const deadline = Date.now() + 30_000
  async function poll() {
    if (state.current !== 'starting') return
    try {
      const r = await fetch(`${codingPtySidecarUrl()}/health`, { signal: AbortSignal.timeout(3_000) })
      if (r.ok) { markReady(); return }
    } catch { /* not up yet */ }
    if (Date.now() >= deadline) { markFailed('coding-pty-sidecar did not start within 30 seconds'); return }
    pollTimer = setTimeout(poll, 1_000)
  }
  pollTimer = setTimeout(poll, 500)
}

/** Ensures the sidecar is running (spawns/waits if needed), rejects if it fails to start. */
export async function ensureCodingPtySidecarReady(): Promise<void> {
  if (state.current === 'ready') {
    const alive = await fetch(`${codingPtySidecarUrl()}/health`, { signal: AbortSignal.timeout(1_500) }).then((r) => r.ok).catch(() => false)
    if (alive) return
    logger.warn('[coding] coding-pty-sidecar reported ready but health check failed; respawning')
    state.current = 'idle'
  }
  await maybeSpawnCodingPtySidecar()
  if (getCodingPtySidecarState() === 'ready') return
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      // Read through the exported accessor, not `state.current` directly: TS's
      // control-flow narrowing otherwise carries the "not ready" narrowing from the
      // check above into this closure, even though state.current legitimately
      // changes between ticks (async, mutated elsewhere in this module).
      const cur = getCodingPtySidecarState()
      if (cur === 'ready') resolve()
      else if (cur === 'failed') reject(new Error(state.error || 'coding-pty-sidecar failed to start'))
      else setTimeout(check, 300)
    }
    check()
  })
}
