import { join } from 'node:path'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { ensureNode } from '@/lib/node'
import { IS_WIN, spawnDetachedHidden } from '@/lib/platform'
import {
  isSandboxUserInstalled, ensureWindowsSandboxMirror, runAsSandboxUser,
  SANDBOX_WORKSPACES_ROOT, WIN_SANDBOX_TMP,
} from '@/lib/codingSandboxUser'
import { CLAUDE_CODE_DIR } from '@/lib/claudeCode'
import { logger } from '@/lib/logger'

// Manages the coding-terminal PTY sidecar(s) (see scripts/coding-pty-sidecar.ts).
// Mirrors the voice-server sidecar pattern: spawn detached under Node (not Bun — see
// that script's own comment for why), poll /health, crash-restart with a capped
// window. One shared sidecar for the whole household (like voice), not per-user: it's
// stateless between connections, each WS attach carries its own spawn params.
//
// TWO instances since the Windows sandbox landed (CODING-SANDBOX-DESIGN-2026-07-16.md):
//   • coding (:8094) — hosts the Coding app's claude ptys. On Windows WITH the sandbox
//     installed, the ENTIRE process runs as the restricted `maipai-coding` user
//     (spawned via scripts/win-sandbox-runner.ps1), so every pty it opens inherits the
//     kernel-enforced boundary — node-pty can't drop privileges per-spawn, but it
//     doesn't have to when the whole process is already the sandbox user. Runs the
//     MIRRORED script/node/claude under the workspace root (the app dir is deny-ACE'd).
//     Fails CLOSED: a broken sandboxed spawn errors; it never falls back to app-user.
//   • host-shell (:8095) — the admin Remote→"This server" full-access shell, always the
//     app's own user. Only a separate instance on Windows-with-sandbox; everywhere else
//     it resolves to the coding instance (exactly the pre-sandbox behavior).
// On mac/Linux the coding instance stays the app user — privilege drops happen
// per-tmux-pane via sudo (codingServer.ts), unchanged.

export const CODING_PTY_PORT = parseInt(process.env.CODING_PTY_SIDECAR_PORT ?? '8094')
export const HOST_SHELL_PTY_PORT = parseInt(process.env.CODING_HOSTSHELL_SIDECAR_PORT ?? '8095')
const BACKEND_DIR = join(import.meta.dir, '../..')
const SIDECAR_SCRIPT = join(BACKEND_DIR, 'scripts/coding-pty-sidecar.ts')

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

const SUPERVISE_INTERVAL_MS = 60_000
const SUPERVISE_RETRY_MS    = 5_000
const RESTART_WINDOW_MS     = 10 * 60_000
const RESTART_MAX           = 3

class SidecarManager {
  private state: State = 'idle'
  private error = ''
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private proc: ChildProcess | null = null
  private superviseTimer: ReturnType<typeof setTimeout> | null = null
  private superviseFailures = 0
  private restartTimes: number[] = []

  constructor(
    private readonly label: string,
    readonly port: number,
    /** Only the coding instance ever runs sandboxed (decided per-spawn: the sandbox
     *  can be installed mid-session by an admin). */
    private readonly sandboxable: boolean,
  ) {}

  url(): string { return `http://127.0.0.1:${this.port}` }
  wsUrl(): string { return `ws://127.0.0.1:${this.port}/attach` }
  getState(): State { return this.state }

  private markReady(): void { this.state = 'ready'; this.error = ''; this.clearPoll(); this.startSupervision() }
  private markFailed(msg: string): void { this.state = 'failed'; this.error = msg; this.clearPoll() }
  private clearPoll(): void { if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null } }

  private stopSupervision(): void {
    if (this.superviseTimer) { clearTimeout(this.superviseTimer); this.superviseTimer = null }
    this.superviseFailures = 0
  }

  private startSupervision(): void {
    if (this.superviseTimer) return
    this.superviseFailures = 0
    const tick = async (): Promise<void> => {
      if (this.state !== 'ready') { this.superviseTimer = null; return }
      let ok = false
      try {
        const r = await fetch(`${this.url()}/health`, { signal: AbortSignal.timeout(3_000) })
        ok = r.ok
      } catch { /* down or wedged */ }
      if (this.state !== 'ready') { this.superviseTimer = null; return }
      if (ok) { this.superviseFailures = 0; this.superviseTimer = setTimeout(() => void tick(), SUPERVISE_INTERVAL_MS); return }
      this.superviseFailures++
      if (this.superviseFailures < 2) { this.superviseTimer = setTimeout(() => void tick(), SUPERVISE_RETRY_MS); return }
      this.superviseTimer = null
      this.handleCrash()
    }
    this.superviseTimer = setTimeout(() => void tick(), SUPERVISE_INTERVAL_MS)
  }

  private handleCrash(): void {
    this.stopSupervision()
    const now = Date.now()
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
    if (this.restartTimes.length >= RESTART_MAX) {
      this.markFailed(`${this.label} sidecar crashed ${RESTART_MAX}+ times within 10 minutes — giving up`)
      logger.error(`[coding] ${this.label} sidecar keeps crashing — not respawning again (restart the backend to retry)`)
      return
    }
    this.restartTimes.push(now)
    logger.warn(`[coding] ${this.label} sidecar died — respawning`)
    this.state = 'idle'
    this.error = ''
    void this.maybeSpawn()
  }

  spawn(): void {
    if (this.state === 'starting' || this.state === 'ready') return
    this.state = 'starting'
    this.error = ''
    ensureSpawnHelperExecutable()
    const sandboxed = this.sandboxable && IS_WIN && isSandboxUserInstalled()
    void (async () => {
      const nodeExe = await ensureNode()
      if (this.state !== 'starting') return
      if (sandboxed) {
        // The app dir + data dir are deny-ACE'd for the sandbox user, so the sidecar
        // runs entirely from the mirror under the workspace root. cleanEnv: the
        // backend's env carries real secrets a sandbox-user process could read out of
        // its own environment block. Fail closed: any error here surfaces as 'failed'
        // — there is deliberately NO fallback to an app-user spawn.
        const mirror = ensureWindowsSandboxMirror(nodeExe, CLAUDE_CODE_DIR, BACKEND_DIR)
        const homeDir = join(SANDBOX_WORKSPACES_ROOT, 'home')
        mkdirSync(homeDir, { recursive: true })
        const r = await runAsSandboxUser({
          mode: 'spawn',
          exe: mirror.nodeExe,
          args: [mirror.sidecarScript],
          cwd: SANDBOX_WORKSPACES_ROOT,
          cleanEnv: true,
          env: {
            CODING_PTY_SIDECAR_PORT: String(this.port),
            TEMP: WIN_SANDBOX_TMP,
            TMP: WIN_SANDBOX_TMP,
            USERPROFILE: homeDir,
            HOME: homeDir,
          },
        })
        if (r.code !== 0) {
          throw new Error(`sandboxed sidecar spawn failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`)
        }
        // No child handle to watch (the runner exits after CreateProcessWithLogonW):
        // the health poll below adopts the process; supervision catches later deaths.
      } else {
        const child = spawnDetachedHidden(nodeExe, [SIDECAR_SCRIPT], {
          cwd: BACKEND_DIR,
          env: { ...process.env, CODING_PTY_SIDECAR_PORT: String(this.port) },
        })
        this.proc = child
        child.on('exit', () => {
          if (this.proc !== child) return
          this.proc = null
          if (this.state === 'ready') this.handleCrash()
        })
        child.unref()
      }
      this.startHealthPoll()
    })().catch((err) => this.markFailed(`could not start ${this.label} sidecar: ${err instanceof Error ? err.message : String(err)}`))
  }

  stop(): void {
    this.clearPoll()
    this.stopSupervision()
    // On Windows the sidecar hosts the persistent claude ptys in-process (there's no
    // independent tmux server), so SIGTERM-ing it on a graceful Bun shutdown would drop
    // every coding session. Leave it running (detached / other-user) so sessions survive
    // a backend restart; the next boot re-adopts the still-listening sidecar via the
    // /health probe in maybeSpawn. (A sandbox-user sidecar couldn't be signalled from
    // here anyway — teardown is the cooperative /shutdown endpoint.)
    if (!IS_WIN && this.proc) { try { this.proc.kill('SIGTERM') } catch { /* already gone */ } }
    this.proc = null
    this.state = 'idle'
  }

  /** Cooperative full teardown: kill every session and exit. Used on feature disable
   *  and right after the Windows sandbox install so the next spawn picks up the new
   *  (restricted) identity. Best-effort — a down sidecar is already what we want. */
  async shutdown(): Promise<void> {
    this.clearPoll()
    this.stopSupervision()
    try {
      await fetch(`${this.url()}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3_000) })
    } catch { /* down/absent */ }
    this.proc = null
    this.state = 'idle'
  }

  async maybeSpawn(): Promise<void> {
    if (this.state === 'starting' || this.state === 'ready') return
    try {
      const r = await fetch(`${this.url()}/health`, { signal: AbortSignal.timeout(2_000) })
      if (r.ok) { this.markReady(); return }
    } catch { /* not running */ }
    this.spawn()
  }

  private startHealthPoll(): void {
    this.clearPoll()
    const deadline = Date.now() + 30_000
    const poll = async (): Promise<void> => {
      if (this.state !== 'starting') return
      try {
        const r = await fetch(`${this.url()}/health`, { signal: AbortSignal.timeout(3_000) })
        if (r.ok) { this.markReady(); return }
      } catch { /* not up yet */ }
      if (Date.now() >= deadline) { this.markFailed(`${this.label} sidecar did not start within 30 seconds`); return }
      this.pollTimer = setTimeout(() => void poll(), 1_000)
    }
    this.pollTimer = setTimeout(() => void poll(), 500)
  }

  /** Ensures the sidecar is running (spawns/waits if needed), rejects if it fails to start. */
  async ensureReady(): Promise<void> {
    if (this.state === 'ready') {
      const alive = await fetch(`${this.url()}/health`, { signal: AbortSignal.timeout(1_500) }).then((r) => r.ok).catch(() => false)
      if (alive) return
      logger.warn(`[coding] ${this.label} sidecar reported ready but health check failed; respawning`)
      this.state = 'idle'
    }
    await this.maybeSpawn()
    // Read through getState(), not this.state: TS carries the "not ready" narrowing
    // from the check above into here, even though state legitimately changes between
    // ticks (async, mutated by the spawn/poll machinery).
    if (this.getState() === 'ready') return
    await new Promise<void>((resolve, reject) => {
      const check = (): void => {
        const cur = this.getState()
        if (cur === 'ready') resolve()
        else if (cur === 'failed') reject(new Error(this.error || `${this.label} sidecar failed to start`))
        else setTimeout(check, 300)
      }
      check()
    })
  }
}

const codingSidecar = new SidecarManager('coding', CODING_PTY_PORT, true)
const hostShellSidecar = new SidecarManager('host-shell', HOST_SHELL_PTY_PORT, false)

/** The admin host shell needs full app-user access, so it must NOT share the coding
 *  sidecar when that one runs as the restricted sandbox user (Windows). Everywhere
 *  else the coding instance IS the app user — one process, like before. Resolved per
 *  call: the sandbox can be installed mid-session. */
function hostShellManager(): SidecarManager {
  return IS_WIN && isSandboxUserInstalled() ? hostShellSidecar : codingSidecar
}

// ── Coding sidecar (the Coding app's terminals + headless /run) ────────────────
export function codingPtySidecarUrl(): string { return codingSidecar.url() }
export function codingPtySidecarWsUrl(): string { return codingSidecar.wsUrl() }
export function getCodingPtySidecarState(): State { return codingSidecar.getState() }
export function spawnCodingPtySidecar(): void { codingSidecar.spawn() }
export async function maybeSpawnCodingPtySidecar(): Promise<void> { return codingSidecar.maybeSpawn() }
export async function ensureCodingPtySidecarReady(): Promise<void> { return codingSidecar.ensureReady() }

/** Cooperative teardown of the coding sidecar (feature disable; post-sandbox-install
 *  identity switch). Sessions are killed — that's the point. */
export async function shutdownCodingSidecar(): Promise<void> { return codingSidecar.shutdown() }

// ── Host-shell sidecar (admin Remote → "This server") ──────────────────────────
export function hostShellSidecarWsUrl(): string { return hostShellManager().wsUrl() }
export async function ensureHostShellSidecarReady(): Promise<void> { return hostShellManager().ensureReady() }

/** Live host-shell sessions (key + attached-client count). Empty when the sidecar
 *  is down — listing must never spawn it just to report nothing. */
export async function listHostShellSessions(): Promise<Array<{ key: string; clients: number }>> {
  try {
    const r = await fetch(`${hostShellManager().url()}/sessions`, { signal: AbortSignal.timeout(2_000) })
    if (!r.ok) return []
    const data = await r.json() as { sessions?: Array<{ key: string; clients: number }> }
    return Array.isArray(data.sessions) ? data.sessions : []
  } catch {
    return []
  }
}

/** Kill one persistent host-shell session (explicit user action from the picker). */
export async function killHostShellSession(sessionKey: string): Promise<void> {
  try {
    await fetch(`${hostShellManager().url()}/session/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey }),
      signal: AbortSignal.timeout(3_000),
    })
  } catch { /* sidecar down/absent — nothing to kill */ }
}

export function stopCodingPtySidecar(): void {
  codingSidecar.stop()
  hostShellSidecar.stop()
}

/** Kill a persistent coding session in the sidecar (Windows model-change / admin teardown).
 *  Best-effort: a down/absent sidecar just means there's nothing to kill. */
export async function killCodingSession(sessionKey: string): Promise<void> {
  try {
    await fetch(`${codingSidecar.url()}/session/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey }),
      signal: AbortSignal.timeout(3_000),
    })
  } catch { /* sidecar down/absent — nothing to kill */ }
}

/** One-shot headless exec inside the coding sidecar (POST /run) — used on Windows so a
 *  `claude -p` companion task runs under the sidecar's own (restricted) user. */
export async function runInCodingSidecar(params: { cmd: string; args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  await codingSidecar.ensureReady()
  const r = await fetch(`${codingSidecar.url()}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(params.timeoutMs + 10_000),
  })
  if (!r.ok) throw new Error(`coding sidecar /run failed: HTTP ${r.status}`)
  return await r.json() as { code: number | null; stdout: string; stderr: string }
}
