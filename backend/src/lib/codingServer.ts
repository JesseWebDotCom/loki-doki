import { join } from 'node:path'
import { existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  SANDBOX_WORKSPACES_ROOT, SANDBOX_RUNTIME_DIR, SANDBOX_USER, LAUNCH_SCRIPT,
  isSandboxUserInstalled, ensureSandboxRuntimeMirrored,
} from '@/lib/codingSandboxUser'
import { CLAUDE_CODE_DIR, CLAUDE_BIN, isClaudeCodeInstalled } from '@/lib/claudeCode'
import { killCodingSession } from '@/lib/codingPtySidecar'
import { codingEngineUrl, resolveCodingModelTag } from '@/lib/codingEngine'
import { dataDir } from '@/lib/download'
import { IS_WIN } from '@/lib/platform'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

// Before the coding-sandbox-user install step has run (fresh install, or Windows,
// where it's unsupported), SANDBOX_WORKSPACES_ROOT doesn't exist and this app's own
// unprivileged process can't create it there either. Falls back to a directory inside
// the app's own data/ dir until that install step runs; this fallback has NO OS-level
// isolation, only Claude Code's own interactive approval prompts.
const FALLBACK_WORKSPACES_ROOT = join(dataDir, 'coding', 'users')

// One persistent tmux session PER USER. IMPORTANT (per-window sandbox): the tmux SERVER
// itself runs as THIS app's own OS user — never sudo'd — and only individual PANES that
// should be sandboxed drop to the restricted `lokidoki-coding` user via `sudo -u` on their
// launch command. That's what lets one session mix sandboxed and unsandboxed panes (an
// admin can escape the sandbox per window). It works because the per-user workspace lives
// under the group-shared SANDBOX_WORKSPACES_ROOT (2770, g+s; the app user is in the group),
// so the app-user server can create/enter it AND a sandboxed pane can too.
const SESSION_NAME = 'coding'

export function workspaceDirFor(userId: string): string {
  const root = isSandboxUserInstalled() ? SANDBOX_WORKSPACES_ROOT : FALLBACK_WORKSPACES_ROOT
  return join(root, 'users', userId)
}

// Claude Code writes global config/skills to $HOME/.claude regardless of cwd; nested inside
// each user's workspace so household members never share credentials/skills. Sandboxed and
// unsandboxed panes get SEPARATE homes so their files (written by different OS users) never
// clash on ownership.
function sandboxedHomeDir(workingDir: string): string { return join(workingDir, '.home') }
function unsandboxedHomeDir(workingDir: string): string { return join(workingDir, '.home-host') }

function socketPathFor(workingDir: string): string {
  return join(workingDir, '.tmux.sock')
}

// Run a tmux control/attach command directly as THIS app's user (the tmux server owner).
// No sudo: server + socket + workspace are all app-user/group accessible.
async function runTmux(cmdArgs: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const [bin, ...args] = cmdArgs
  if (!bin) throw new Error('runTmux: cmdArgs must be non-empty')
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { cwd, timeout: 10_000, windowsHide: true })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) }
  }
}

async function hasSession(userId: string): Promise<boolean> {
  if (IS_WIN) return false
  const workingDir = workspaceDirFor(userId)
  const sock = socketPathFor(workingDir)
  if (!existsSync(sock)) return false
  const r = await runTmux(['tmux', '-S', sock, 'has-session', '-t', SESSION_NAME], workingDir)
  return r.code === 0
}

function mirroredClaudeBin(): string {
  return join(SANDBOX_RUNTIME_DIR, 'node_modules', '.bin', 'claude')
}

function ensureFreshSandboxRuntimeMirror(): void {
  if (existsSync(SANDBOX_RUNTIME_DIR) && !existsSync(mirroredClaudeBin())) {
    rmSync(SANDBOX_RUNTIME_DIR, { recursive: true, force: true })
  }
  ensureSandboxRuntimeMirrored(CLAUDE_CODE_DIR)
}

interface PaneLaunch { paneCmd: string[]; workingDir: string; sock: string }

/**
 * Build the launch command for a single pane running Claude Code. When `sandboxed` (and the
 * sandbox user is installed), the pane's `claude` runs via `sudo -u lokidoki-coding` (real
 * OS-level isolation, mirrored runtime, isolated HOME); otherwise it runs directly as this
 * app's user with full host access. The tmux server that hosts the pane is always this app's
 * user — only the pane command is (or isn't) wrapped. Also prepares the workspace + HOME dirs.
 */
async function resolvePaneLaunch(userId: string, sandboxed: boolean): Promise<PaneLaunch> {
  if (!isClaudeCodeInstalled()) throw new Error('Claude Code is not installed. Enable it in Admin → Features')
  const eff = sandboxed && isSandboxUserInstalled()
  const workingDir = workspaceDirFor(userId)
  mkdirSync(workingDir, { recursive: true })
  // Group-writable so a sandboxed pane (lokidoki-coding, same group) can write here too.
  if (isSandboxUserInstalled()) chmodSync(workingDir, 0o770)

  const homeDir = eff ? sandboxedHomeDir(workingDir) : unsandboxedHomeDir(workingDir)
  mkdirSync(homeDir, { recursive: true })
  if (eff) chmodSync(homeDir, 0o770)

  let claudeBin = CLAUDE_BIN
  if (eff) { ensureFreshSandboxRuntimeMirror(); claudeBin = mirroredClaudeBin() }

  const model = await resolveCodingModelTag()
  const envArgs = [
    `HOME=${homeDir}`,
    `SHELL=/bin/bash`,
    // The dedicated coding engine (falls back to the main engine when its GPU is absent,
    // or to the remote engine when one is paired) - see codingEngine.ts.
    `ANTHROPIC_BASE_URL=${await codingEngineUrl()}`,
    `ANTHROPIC_AUTH_TOKEN=ollama`,
    `ANTHROPIC_MODEL=${model}`,
  ]
  const launch = ['env', ...envArgs, claudeBin]
  const paneCmd = eff ? ['sudo', '-u', SANDBOX_USER, LAUNCH_SCRIPT, ...launch] : launch
  return { paneCmd, workingDir, sock: socketPathFor(workingDir) }
}

// Concurrent WS opens (e.g. two browser tabs) shouldn't race to create the same tmux
// session twice.
const ensuring = new Map<string, Promise<void>>()

/** Ensures a tmux session running `claude` exists for this user; idempotent. The first pane
 *  is sandboxed by default (the safe default; admins can later split unsandboxed panes). */
export async function ensureTmuxSession(userId: string): Promise<void> {
  const existing = ensuring.get(userId)
  if (existing) return existing
  const p = (async () => {
    if (IS_WIN) {
      const workingDir = workspaceDirFor(userId)
      mkdirSync(workingDir, { recursive: true })
      mkdirSync(unsandboxedHomeDir(workingDir), { recursive: true })
      return
    }
    if (await hasSession(userId)) return
    const { paneCmd, workingDir, sock } = await resolvePaneLaunch(userId, true)
    const cmdArgs = ['tmux', '-S', sock, 'new-session', '-A', '-d', '-s', SESSION_NAME, '-c', workingDir, ...paneCmd]
    const r = await runTmux(cmdArgs, workingDir)
    if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr || r.stdout}`)
    const mouseResult = await runTmux(['tmux', '-S', sock, 'set', '-g', 'mouse', 'on'], workingDir)
    if (mouseResult.code !== 0) logger.warn(`[coding] tmux mouse mode failed to enable for user ${userId}: ${mouseResult.stderr}`)
  })()
  ensuring.set(userId, p)
  try { await p } finally { ensuring.delete(userId) }
}

/** Kills the session — used when the coding_model setting changes or for admin/debug cleanup. */
export async function killTmuxSession(userId: string): Promise<void> {
  if (IS_WIN) {
    await killCodingSession(userId)
    return
  }
  const workingDir = workspaceDirFor(userId)
  const sock = socketPathFor(workingDir)
  if (!existsSync(sock)) return
  await runTmux(['tmux', '-S', sock, 'kill-server'], workingDir)
}

export type PaneAction = 'split-h' | 'split-v' | 'close'

/**
 * tmux's `-h`/`-v` name the divider orientation: `-h` = side-by-side, `-v` = stacked.
 *
 * `sandboxed` decides whether the NEW pane's Claude runs inside the OS sandbox (default) or
 * as this app's own user with full host access. Only admins should ever pass `false` — the
 * route enforces that. This is the per-window sandbox escape: a single session can hold a
 * mix of sandboxed and unsandboxed panes.
 */
export async function paneControl(userId: string, action: PaneAction, sandboxed = true): Promise<void> {
  if (IS_WIN) throw new Error('Split panes are not available on Windows (no tmux).')
  await ensureTmuxSession(userId)
  const workingDir = workspaceDirFor(userId)
  const sock = socketPathFor(workingDir)
  if (action === 'close') {
    const r = await runTmux(['tmux', '-S', sock, 'kill-pane', '-t', SESSION_NAME], workingDir)
    if (r.code !== 0) throw new Error(`tmux ${action} failed: ${r.stderr || r.stdout}`)
    return
  }
  const { paneCmd } = await resolvePaneLaunch(userId, sandboxed)
  const flag = action === 'split-h' ? '-h' : '-v'
  const cmd = ['tmux', '-S', sock, 'split-window', flag, '-t', SESSION_NAME, '-c', workingDir, ...paneCmd]
  const r = await runTmux(cmd, workingDir)
  if (r.code !== 0) throw new Error(`tmux ${action} failed: ${r.stderr || r.stdout}`)
}

/**
 * Sandboxed command line for a one-shot headless `claude -p` (the companion coding tool,
 * tools/coding.ts). Always sandboxed — a background auto-approving run must stay contained.
 */
export async function buildHeadlessClaudeCommand(userId: string, task: string): Promise<{ bin: string; args: string[]; cwd: string }> {
  const { paneCmd, workingDir } = await resolvePaneLaunch(userId, true)
  const claudeArgs = ['-p', task, '--output-format', 'json', '--permission-mode', 'bypassPermissions']
  const full = [...paneCmd, ...claudeArgs]
  const [bin, ...args] = full
  return { bin: bin!, args, cwd: workingDir }
}

/**
 * Spawn params for the coding-pty-sidecar's WS `/attach` — the one place that needs a real
 * PTY (tmux `attach-session` checks isatty()). The attach client is this app's user (the tmux
 * server owner), so it reaches the session socket directly; no sudo.
 */
export async function buildAttachSpawnParams(userId: string): Promise<{ cmd: string; args: string[]; cwd: string; env: Record<string, string>; sessionKey?: string; persistent?: boolean }> {
  if (IS_WIN) {
    if (!isClaudeCodeInstalled()) throw new Error('Claude Code is not installed. Enable it in Admin → Features')
    const workingDir = workspaceDirFor(userId)
    mkdirSync(workingDir, { recursive: true })
    const homeDir = unsandboxedHomeDir(workingDir)
    mkdirSync(homeDir, { recursive: true })
    const model = await resolveCodingModelTag()
    const env: Record<string, string> = {
      TERM: 'xterm-256color',
      HOME: homeDir,
      USERPROFILE: homeDir,
      // Dedicated coding engine, with main/remote fallbacks - see codingEngine.ts.
      ANTHROPIC_BASE_URL: await codingEngineUrl(),
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_MODEL: model,
    }
    for (const k of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'APPDATA', 'LOCALAPPDATA']) {
      const v = process.env[k]
      if (v) env[k] = v
    }
    return { cmd: CLAUDE_BIN, args: [], cwd: workingDir, env, sessionKey: userId, persistent: true }
  }

  await ensureTmuxSession(userId)
  const workingDir = workspaceDirFor(userId)
  const sock = socketPathFor(workingDir)
  // Deliberately NOT the full process.env: this backend's own env carries real secrets an
  // attach client (which only needs PATH + a sane TERM) has no reason to see.
  const env: Record<string, string> = { TERM: 'xterm-256color' }
  if (process.env.PATH) env.PATH = process.env.PATH
  return { cmd: 'tmux', args: ['-S', sock, 'attach-session', '-t', SESSION_NAME], cwd: workingDir, env }
}

/**
 * Spawn params for an admin-only RAW host shell (Remote app → This server), running as this
 * backend's own OS user with full host access — NOT the coding sandbox, NOT Claude Code. Uses
 * the PTY sidecar's persistent/reattach mode. Curated env only (never the full process.env).
 * The route that reaches it is requireAdmin + PIN-gated.
 */
export function buildHostShellSpawnParams(userId: string): { cmd: string; args: string[]; cwd: string; env: Record<string, string>; sessionKey: string; persistent: boolean } {
  const home = process.env.HOME || process.env.USERPROFILE || dataDir
  if (IS_WIN) {
    const env: Record<string, string> = { TERM: 'xterm-256color' }
    for (const k of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) {
      const v = process.env[k]
      if (v) env[k] = v
    }
    const cmd = process.env.ComSpec && !existsSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      ? process.env.ComSpec
      : 'powershell.exe'
    return { cmd, args: [], cwd: home, env, sessionKey: `admin-shell:${userId}`, persistent: true }
  }
  const env: Record<string, string> = { TERM: 'xterm-256color', HOME: home }
  if (process.env.PATH) env.PATH = process.env.PATH
  if (process.env.LANG) env.LANG = process.env.LANG
  const shell = process.env.SHELL || '/bin/bash'
  return { cmd: shell, args: ['-l'], cwd: home, env, sessionKey: `admin-shell:${userId}`, persistent: true }
}
