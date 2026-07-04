import { join } from 'node:path'
import { existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  SANDBOX_WORKSPACES_ROOT, SANDBOX_RUNTIME_DIR, SANDBOX_USER, LAUNCH_SCRIPT,
  isSandboxUserInstalled, ensureSandboxRuntimeMirrored,
} from '@/lib/codingSandboxUser'
import { CLAUDE_CODE_DIR, CLAUDE_BIN, isClaudeCodeInstalled } from '@/lib/claudeCode'
import { ollamaUrl } from '@/llm/ollama'
import { dataDir } from '@/lib/download'
import { getAppSetting } from '@/lib/settings'
import { CATALOG } from '@/lib/catalog'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

// Before the coding-sandbox-user install step has run (fresh install, or Windows,
// where it's unsupported), SANDBOX_WORKSPACES_ROOT doesn't exist and this app's own
// unprivileged process can't create it there either. Falls back to a directory inside
// the app's own data/ dir until that install step runs; this fallback has NO OS-level
// isolation, only Claude Code's own interactive approval prompts.
const FALLBACK_WORKSPACES_ROOT = join(dataDir, 'coding', 'users')

// One persistent tmux session PER USER, wrapping a single `claude` process — not one
// PTY-per-pane managed by this app. tmux itself draws whatever split layout exists
// into that single character grid; splitting/closing panes are just tmux commands
// (see paneControl below), and mouse-mode drag-to-resize works because xterm.js
// forwards mouse events straight through to the attached tmux client. This is
// dramatically less code than a hand-rolled multi-PTY reconnect/persistence system,
// and reload/disconnect-survival falls out of tmux's own detach/attach for free.
const SESSION_NAME = 'coding'

export function workspaceDirFor(userId: string): string {
  const root = isSandboxUserInstalled() ? SANDBOX_WORKSPACES_ROOT : FALLBACK_WORKSPACES_ROOT
  return join(root, 'users', userId)
}

// Claude Code writes global config/skills to $HOME/.claude regardless of cwd, same
// reasoning as OpenCode's old per-user HOME: nested inside each user's own workspace
// dir so different household members never share credentials/skills/recent-project
// state.
function homeDirFor(workingDir: string): string {
  return join(workingDir, '.home')
}

function socketPathFor(workingDir: string): string {
  return join(workingDir, '.tmux.sock')
}

async function resolveCodingModelTag(): Promise<string> {
  const settingId = await getAppSetting('coding_model') as string | null
  const id = settingId ?? CATALOG.find((m) => m.role === 'coding')?.id ?? 'ornith:9b'
  const entry = CATALOG.find((m) => m.id === id && m.role === 'coding')
  return entry?.ollamaTag ?? id
}

interface SandboxedSpawn { bin: string; args: string[] }

// Wraps a command through the sandboxed launch script (real OS-level isolation) when
// installed, else runs it directly — same branch shape as codingSandboxUser.ts's own
// docs describe (approval-gate-only fallback, not a silent gap).
function sandboxWrap(cmdArgs: string[]): SandboxedSpawn {
  if (isSandboxUserInstalled()) {
    return { bin: 'sudo', args: ['-u', SANDBOX_USER, LAUNCH_SCRIPT, ...cmdArgs] }
  }
  const [bin, ...args] = cmdArgs
  if (!bin) throw new Error('sandboxWrap: cmdArgs must be non-empty')
  return { bin, args }
}

// `cwd` is load-bearing, not cosmetic: without an explicit cwd, the spawned process
// inherits THIS backend process's own cwd (somewhere inside a home directory), which
// the sandboxed OS user structurally cannot access at all — confirmed live: sudo
// itself starts fine, but the exec'd shell's own `getcwd()` then fails ("cannot
// access parent directories: Permission denied"), silently killing tmux's server
// before it can even process `-c <dir>`. The workspace dir itself is always a safe
// choice: it's the one path this sandboxed user is guaranteed to have access to.
async function runSandboxed(cmdArgs: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const { bin, args } = sandboxWrap(cmdArgs)
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { cwd, timeout: 10_000 })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) }
  }
}

async function hasSession(userId: string): Promise<boolean> {
  const workingDir = workspaceDirFor(userId)
  const sock = socketPathFor(workingDir)
  if (!existsSync(sock)) return false
  const r = await runSandboxed(['tmux', '-S', sock, 'has-session', '-t', SESSION_NAME], workingDir)
  return r.code === 0
}

function mirroredClaudeBin(): string {
  return join(SANDBOX_RUNTIME_DIR, 'node_modules', '.bin', 'claude')
}

// ensureSandboxRuntimeMirrored is a cheap no-op once SANDBOX_RUNTIME_DIR exists at
// all — it never re-checks WHAT'S mirrored there. This app previously mirrored
// OpenCode into that exact path; a stale opencode-only mirror would silently never
// get replaced with Claude Code's binary, since the directory already "exists". Wipe
// and let it re-mirror fresh whenever the expected binary is missing.
function ensureFreshSandboxRuntimeMirror(): void {
  if (existsSync(SANDBOX_RUNTIME_DIR) && !existsSync(mirroredClaudeBin())) {
    rmSync(SANDBOX_RUNTIME_DIR, { recursive: true, force: true })
  }
  ensureSandboxRuntimeMirrored(CLAUDE_CODE_DIR)
}

interface ClaudeLaunch { claudeBin: string; envArgs: string[]; workingDir: string; sock: string }

// Shared by ensureTmuxSession (the session's first pane) AND paneControl (every
// later split): every pane in the Coding app should run Claude Code, not tmux's
// default fallback shell. Also prepares the per-user workspace/HOME dirs, so calling
// this is safe even before a session exists yet.
async function resolveClaudeLaunch(userId: string): Promise<ClaudeLaunch> {
  if (!isClaudeCodeInstalled()) throw new Error('Claude Code is not installed. Enable it in Admin → Features')
  const workingDir = workspaceDirFor(userId)
  mkdirSync(workingDir, { recursive: true })
  // Explicit chmod, not just mkdir's mode param: the umask this process runs under
  // can strip the group-write bit the sandboxed coding user needs to write into its
  // own session directories. No-op (harmless) on the unsandboxed fallback path.
  if (isSandboxUserInstalled()) chmodSync(workingDir, 0o770)
  const homeDir = homeDirFor(workingDir)
  mkdirSync(homeDir, { recursive: true })
  if (isSandboxUserInstalled()) chmodSync(homeDir, 0o770)

  const sandboxed = isSandboxUserInstalled()
  let claudeBin = CLAUDE_BIN
  if (sandboxed) {
    ensureFreshSandboxRuntimeMirror()
    claudeBin = mirroredClaudeBin()
  }

  const model = await resolveCodingModelTag()
  const envArgs = [
    `HOME=${homeDir}`,
    // Load-bearing, not cosmetic: the sandboxed OS user's login shell is
    // deliberately /usr/bin/false (codingSandboxUser.ts, to block interactive
    // login), but tmux always runs a new session/window/pane's initial command
    // through $SHELL -c "..." — falling back to the invoking user's passwd shell
    // when $SHELL isn't set. Without this override, tmux launches the pane via
    // /usr/bin/false, which exits immediately, killing the pane (and, for a brand
    // new detached session with nothing attached, the whole server with it) —
    // confirmed live: `new-session -d` reports exit 0, then `has-session` reports
    // "no server running" moments later, with claude never actually starting.
    `SHELL=/bin/bash`,
    // Ollama's native Anthropic-Messages-compatible endpoint (confirmed: full
    // tool-calling + streaming support) — no proxy, no translation shim needed to
    // point the real Claude Code CLI at the household's local coding model.
    `ANTHROPIC_BASE_URL=${ollamaUrl()}`,
    `ANTHROPIC_AUTH_TOKEN=ollama`, // accepted but not validated by Ollama's compat layer
    `ANTHROPIC_MODEL=${model}`,
  ]
  return { claudeBin, envArgs, workingDir, sock: socketPathFor(workingDir) }
}

// Concurrent WS opens (e.g. two browser tabs) shouldn't race to create the same tmux
// session twice.
const ensuring = new Map<string, Promise<void>>()

/** Ensures a tmux session running `claude` exists for this user; idempotent. */
export async function ensureTmuxSession(userId: string): Promise<void> {
  const existing = ensuring.get(userId)
  if (existing) return existing
  const p = (async () => {
    if (await hasSession(userId)) return
    const { claudeBin, envArgs, workingDir, sock } = await resolveClaudeLaunch(userId)
    // Env vars set here reach `claude` because tmux captures the "global environment"
    // from the process that starts its server (this `env ... tmux new-session`
    // invocation) and applies it to that first window's command — same env-forwarding
    // assumption this app already relies on for OPENCODE_SERVER_PASSWORD/HOME today
    // (see the git history for codingServer.ts), just via tmux instead of a plain spawn.
    const cmdArgs = [
      'env', ...envArgs,
      'tmux', '-S', sock, 'new-session', '-A', '-d', '-s', SESSION_NAME, '-c', workingDir,
      claudeBin,
    ]
    const r = await runSandboxed(cmdArgs, workingDir)
    if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr || r.stdout}`)
    // Mouse mode is what makes tmux's ASCII splits feel Ghostty-like rather than
    // needing bespoke resize UI: xterm.js forwards mouse events straight through, and
    // tmux's own mouse mode consumes drag-on-divider events to resize panes.
    const mouseResult = await runSandboxed(['tmux', '-S', sock, 'set', '-g', 'mouse', 'on'], workingDir)
    if (mouseResult.code !== 0) logger.warn(`[coding] tmux mouse mode failed to enable for user ${userId}: ${mouseResult.stderr}`)
  })()
  ensuring.set(userId, p)
  try { await p } finally { ensuring.delete(userId) }
}

/** Kills the session — used when the coding_model setting changes (env is baked in at session start, not re-readable mid-session) or for admin/debug cleanup. */
export async function killTmuxSession(userId: string): Promise<void> {
  const workingDir = workspaceDirFor(userId)
  const sock = socketPathFor(workingDir)
  if (!existsSync(sock)) return
  await runSandboxed(['tmux', '-S', sock, 'kill-server'], workingDir)
}

export type PaneAction = 'split-h' | 'split-v' | 'close'

/**
 * tmux's `-h`/`-v` flags name the divider orientation, not the pane arrangement — a
 * frequent point of confusion. `-h` ("horizontal" divider) produces side-by-side
 * (left/right) panes; `-v` produces stacked (top/bottom) panes. Mapped straight
 * through to our own 'split-h'/'split-v' action names with that same meaning.
 */
export async function paneControl(userId: string, action: PaneAction): Promise<void> {
  await ensureTmuxSession(userId)
  if (action === 'close') {
    const workingDir = workspaceDirFor(userId)
    const sock = socketPathFor(workingDir)
    const r = await runSandboxed(['tmux', '-S', sock, 'kill-pane', '-t', SESSION_NAME], workingDir)
    if (r.code !== 0) throw new Error(`tmux ${action} failed: ${r.stderr || r.stdout}`)
    return
  }
  // Every pane in the Coding app should run Claude Code, not tmux's default fallback
  // shell — `split-window` with no trailing command just launches $SHELL, which
  // isn't what "split" means in a coding-agent terminal. Re-specify the same
  // env/HOME/model/claudeBin used for the session's first pane (tmux's own captured
  // global environment technically covers the env vars already, but this makes the
  // pane's actual launch command explicit rather than relying on that).
  const { claudeBin, envArgs, workingDir, sock } = await resolveClaudeLaunch(userId)
  const flag = action === 'split-h' ? '-h' : '-v'
  const cmd = ['tmux', '-S', sock, 'split-window', flag, '-t', SESSION_NAME, '-c', workingDir, 'env', ...envArgs, claudeBin]
  const r = await runSandboxed(cmd, workingDir)
  if (r.code !== 0) throw new Error(`tmux ${action} failed: ${r.stderr || r.stdout}`)
}

/**
 * Builds the sandboxed command line for a one-shot headless `claude -p` invocation
 * (used by the companion coding tool, tools/coding.ts) — same env/HOME/sandbox-wrap
 * logic as the interactive tmux session above, just without tmux itself: a headless
 * run doesn't need a persistent multiplexed session, only the same model routing and
 * OS-level isolation.
 */
export async function buildHeadlessClaudeCommand(userId: string, task: string): Promise<{ bin: string; args: string[]; cwd: string }> {
  const { claudeBin, envArgs, workingDir } = await resolveClaudeLaunch(userId)
  // --permission-mode bypassPermissions: a headless run can't prompt interactively for
  // approval the way the tmux session does, so edits/commands auto-accept here. Safe
  // because the OS-user sandbox already contains the blast radius to this user's own
  // workspace. Confirmed live against the installed CLI's own --help output (one of
  // its documented --permission-mode choices, alongside acceptEdits/auto/manual/
  // dontAsk/plan).
  const claudeArgs = ['-p', task, '--output-format', 'json', '--permission-mode', 'bypassPermissions']
  const cmdArgs = ['env', ...envArgs, claudeBin, ...claudeArgs]
  const { bin, args } = sandboxWrap(cmdArgs)
  return { bin, args, cwd: workingDir }
}

/**
 * Spawn params for the coding-pty-sidecar's WS `/attach` endpoint — the one place
 * that actually needs a real PTY (tmux checks `isatty()` on its controlling
 * terminal for `attach-session`; ordinary tmux control commands like split/kill/
 * has-session don't need one, see runSandboxed above). The attach client runs as the
 * same sandboxed OS user as the session itself: a different OS user couldn't reach
 * the session's own socket file regardless.
 */
export async function buildAttachSpawnParams(userId: string): Promise<{ cmd: string; args: string[]; cwd: string; env: Record<string, string> }> {
  await ensureTmuxSession(userId)
  const workingDir = workspaceDirFor(userId)
  const sock = socketPathFor(workingDir)
  const { bin, args } = sandboxWrap(['tmux', '-S', sock, 'attach-session', '-t', SESSION_NAME])
  // Deliberately NOT the full process.env: this backend's own env carries real
  // secrets (DB connection strings, PIN pepper, etc.) that an attach client — which
  // only needs PATH to find sudo/tmux and a sane TERM — has no reason to see, even
  // over a loopback-only connection to the PTY sidecar.
  const env: Record<string, string> = { TERM: 'xterm-256color' }
  if (process.env.PATH) env.PATH = process.env.PATH
  return { cmd: bin, args, cwd: workingDir, env }
}
