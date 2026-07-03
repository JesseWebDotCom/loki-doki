import { join } from 'node:path'
import { existsSync, writeFileSync, mkdirSync, openSync, chmodSync } from 'node:fs'
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Server } from 'bun'
import { OPENCODE_DIR, OPENCODE_BIN, isOpenCodeInstalled } from '@/lib/opencode'
import {
  SANDBOX_WORKSPACES_ROOT, SANDBOX_RUNTIME_DIR, SANDBOX_USER, LAUNCH_SCRIPT,
  isSandboxUserInstalled, ensureSandboxRuntimeMirrored,
} from '@/lib/codingSandboxUser'
import { ollamaUrl } from '@/llm/ollama'
import { dataDir } from '@/lib/download'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

// Before the coding-sandbox-user install step has run (fresh install, or Windows,
// where it's unsupported), SANDBOX_WORKSPACES_ROOT (/usr/local/var/... or
// /var/lib/...) doesn't exist and this app's own unprivileged process can't create
// it there either: that path is only writable once the restricted user + shared
// group have been set up. Falls back to a directory inside the app's own data/ dir
// (writable like everything else the app manages) until that install step runs;
// this fallback has NO OS-level isolation, only the approval-gate.
const FALLBACK_WORKSPACES_ROOT = join(dataDir, 'coding', 'users')

// Manages one persistent OpenCode workspace PER USER, not our own project records:
// OpenCode's own web UI already has a full project picker (open/recent/switch), so
// there's no reason to duplicate that with our own DB-tracked project list. Each
// user gets one sandboxed root directory (data/coding/users/<userId>/) and OpenCode
// itself manages whatever projects/directories live under it.
//
// `opencode serve` serves OpenCode's own real web UI at `/` (verified live: identical to
// `web`, which only differs by ALSO opening the machine's default browser — see the
// spawn site below): the Coding app embeds that UI in an iframe rather than
// reimplementing streaming/diff/tool-call rendering ourselves.
//
// The sidecar itself only ever binds 127.0.0.1, same as every other sidecar in this
// app (searxng, voice): it's never reachable from the network directly. What IS
// reachable is a dedicated, per-user reverse-proxy this module also starts, on its
// own port, LAN-bound. That proxy is the only thing standing between a browser and the
// sidecar: it checks a short-lived signed token (minted by our own authenticated
// backend route) or a signed cookie set from a prior valid token, then forwards
// verbatim to the loopback sidecar with Basic Auth injected server-side. This exists
// because OpenCode's web UI hardcodes root-absolute asset/API paths with no
// configurable base path. Proxying it under a nested path prefix on our own origin
// would break asset loading, so each user needs their own real origin instead.
//
// Mirrors the voice-server sidecar pattern otherwise (spawn detached, poll a health
// endpoint, crash-restart), keyed per user instead of a singleton, capped + LRU-
// reaped since a home server shouldn't accumulate unbounded background processes.

const PORT_BASE = parseInt(process.env.CODING_SERVER_PORT_BASE ?? '8093')
const PROXY_PORT_BASE = parseInt(process.env.CODING_PROXY_PORT_BASE ?? '9100')
const MAX_CONCURRENT = 4
const IDLE_REAP_MS = 30 * 60_000
const PASSWORD_KEY = 'coding.server_password'
const PROXY_SECRET_KEY = 'coding.proxy_secret'
const TOKEN_TTL_MS = 60_000          // one-time handoff token: just long enough to load the iframe
const COOKIE_TTL_MS = 24 * 60 * 60_000

export function workspaceDirFor(userId: string): string {
  const root = isSandboxUserInstalled() ? SANDBOX_WORKSPACES_ROOT : FALLBACK_WORKSPACES_ROOT
  return join(root, 'users', userId)
}

type WorkspaceState = 'starting' | 'ready' | 'failed'
interface WorkspaceServer {
  userId: string
  workingDir: string
  port: number
  proxyPort: number
  proc: ChildProcess | null
  proxyServer: Server<ProxyWsData> | null
  state: WorkspaceState
  error: string
  busy: boolean
  lastUsedAt: number
  readyWaiters: Array<() => void>
  failWaiters: Array<(err: Error) => void>
}

const servers = new Map<string, WorkspaceServer>()
const usedPorts = new Set<number>()

async function ensurePassword(): Promise<string> {
  const existing = await getAppSetting(PASSWORD_KEY) as string | null
  if (existing) return existing
  const pw = randomBytes(24).toString('hex')
  await setAppSetting(PASSWORD_KEY, pw)
  return pw
}

async function ensureProxySecret(): Promise<string> {
  const existing = await getAppSetting(PROXY_SECRET_KEY) as string | null
  if (existing) return existing
  const secret = randomBytes(32).toString('hex')
  await setAppSetting(PROXY_SECRET_KEY, secret)
  return secret
}

// ── Signed token/cookie for the per-user proxy ──────────────────────────────────
// Two tiers deliberately: a one-time, minute-lived TOKEN hands off from our normal
// authenticated session (different origin/port, so cookies don't carry over) into a
// day-lived COOKIE scoped to the proxy's own origin, which then covers every
// subsequent asset/API request the embedded UI makes without needing the token again.

function sign(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

function verify(secret: string, value: string, userId: string): boolean {
  const [body, mac] = value.split('.')
  if (!body || !mac) return false
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const a = Buffer.from(mac), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { userId?: string; exp?: number }
    return payload.userId === userId && typeof payload.exp === 'number' && Date.now() < payload.exp
  } catch { return false }
}

/** One-time handoff token for building the iframe src. Call right before returning
 *  the proxy URL to the frontend: it's only valid for a minute. */
export async function mintProxyToken(userId: string): Promise<string> {
  const secret = await ensureProxySecret()
  return sign(secret, { userId, exp: Date.now() + TOKEN_TTL_MS })
}

function allocatePort(base: number): number {
  for (let p = base; p < base + 64; p++) {
    if (!usedPorts.has(p)) { usedPorts.add(p); return p }
  }
  throw new Error('no free coding-server port in range')
}

// Confirmed live via --log-level DEBUG: OpenCode loads its config from
// $HOME/.config/opencode/{config.json,opencode.json,opencode.jsonc}, NOT from cwd.
// Writing opencode.json into workingDir (the old approach) was silently ignored for
// provider registration, even though a few endpoints like /config happened to still
// reflect it. This is also the reason the UI showed "/" as the only project: with no
// real per-project config ever found, it fell back to a placeholder root state.
function homeDirFor(workingDir: string): string {
  return join(workingDir, '.home')
}

function writeConfig(workingDir: string): void {
  const homeDir = homeDirFor(workingDir)
  const configDir = join(homeDir, '.config', 'opencode')
  mkdirSync(configDir, { recursive: true })
  const config = {
    provider: {
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        // Undocumented as strictly required, but every real example in OpenCode's own
        // docs includes it on a custom provider, and omitting it was one of two things
        // (the other: the missing @ai-sdk/openai-compatible install, see opencode.ts)
        // that had this provider silently fail to register at all rather than error.
        name: 'Ollama (local)',
        options: { baseURL: `${ollamaUrl()}/v1` },
        models: { 'ornith:9b': { name: 'Ornith 1.0 9B' } },
      },
    },
    // Hard allowlist, not just omission: OpenCode auto-detects OTHER providers from
    // ambient credentials (an ANTHROPIC_API_KEY in the environment, a global
    // ~/.config/opencode/auth.json) regardless of what this file declares.
    // enabled_providers is the one documented lever that blocks those from loading
    // at all, so "ollama" here is the only model anyone can select or install,
    // full stop, not just the default.
    enabled_providers: ['ollama'],
    model: 'ollama/ornith:9b',
    // "ask" on every risk-bearing category is load-bearing: it's the shared
    // interactive-approval baseline both the Coding app and companion-triggered chat
    // sessions rely on: nothing in this app ever passes --auto. This is layered on
    // top of the real OS-level wall now (see codingSandboxUser.ts): the sidecar runs
    // as a restricted OS user with no access to any home directory whenever that's
    // installed, not the opencode-sandbox plugin, which was verified live to fail
    // open (its Seatbelt/bubblewrap wrapping doesn't work on this machine's macOS
    // version and it silently runs commands unsandboxed instead of blocking them).
    permission: { bash: 'ask', edit: 'ask', write: 'ask' },
  }
  writeFileSync(join(configDir, 'opencode.json'), JSON.stringify(config, null, 2))
}

function reapIdleIfOverCapacity(exceptUserId: string): void {
  if (servers.size < MAX_CONCURRENT) return
  const idle = [...servers.values()]
    .filter((s) => s.userId !== exceptUserId && !s.busy && s.state !== 'starting')
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  if (idle[0]) killWorkspaceServer(idle[0].userId)
}

function killWorkspaceServer(userId: string): void {
  const s = servers.get(userId)
  if (!s) return
  servers.delete(userId)
  usedPorts.delete(s.port)
  usedPorts.delete(s.proxyPort)
  if (s.proc) { try { s.proc.kill('SIGTERM') } catch { /* already gone */ } }
  if (s.proxyServer) { try { s.proxyServer.stop(true) } catch { /* already gone */ } }
}

interface ProxyWsData { path: string; upstream: WebSocket | null }

function startProxy(userId: string, sidecarPort: number, proxyPort: number, upstreamAuth: string, secret: string): Server<ProxyWsData> {
  const cookieName = 'coding_proxy_auth'
  return Bun.serve<ProxyWsData>({
    port: proxyPort,
    hostname: '0.0.0.0',
    async fetch(req, server) {
      const url = new URL(req.url)
      const cookieHeader = req.headers.get('cookie') ?? ''
      const cookieVal = cookieHeader.match(new RegExp(`${cookieName}=([^;]+)`))?.[1]
      const queryToken = url.searchParams.get('t')

      if (cookieVal && verify(secret, cookieVal, userId)) {
        // authenticated: fall through to proxy
      } else if (queryToken && verify(secret, queryToken, userId)) {
        // One-time token redeemed: set the origin-scoped cookie and redirect to the
        // clean URL so the token never lingers in browser history or gets resent.
        url.searchParams.delete('t')
        const cookieVal2 = sign(secret, { userId, exp: Date.now() + COOKIE_TTL_MS })
        const headers = new Headers({ Location: url.pathname + url.search })
        headers.append('Set-Cookie', `${cookieName}=${cookieVal2}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL_MS / 1000}`)
        return new Response(null, { status: 302, headers })
      } else {
        return new Response('Unauthorized', { status: 401 })
      }

      // OpenCode's embedded terminal opens a same-origin WebSocket (`/pty/:id/connect`)
      // expecting cookie auth to carry it, same as any other same-origin request.
      // Confirmed live: without this, that upgrade just fell through to the plain
      // fetch() passthrough below, which can't negotiate a WS handshake, and the
      // client fell back to a direct connection against the sidecar's own loopback
      // address, popping a native Basic Auth dialog for 127.0.0.1:<port> in the
      // browser (reachable because the browser runs on the same machine as the
      // server, not just other machines on the LAN).
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const ok = server.upgrade(req, { data: { path: url.pathname + url.search, upstream: null } })
        return ok ? undefined : new Response('Upgrade failed', { status: 500 })
      }

      const fwdHeaders = new Headers(req.headers)
      fwdHeaders.delete('host')
      fwdHeaders.set('authorization', upstreamAuth)
      // Same root cause already hit and fixed elsewhere in this app (vite.config.ts's
      // SSE proxy entries): Bun's chunked SSE framing corrupts a pooled keep-alive
      // connection, and every OTHER request sharing that pool to the same upstream
      // then fails too, not just the stream. Confirmed live here: opening /global/event
      // took the whole proxy down, including unrelated /global/health polls, until the
      // process was restarted. Node's http-proxy has `agent: false` for this; Bun's
      // native fetch doesn't expose pool control directly, but `Connection: close`
      // tells both ends not to keep this socket around for reuse, which achieves the
      // same "never share a connection across requests" outcome, for every OTHER
      // request. NOT applied to the stream's own request below: doing so made the
      // stream itself die early (confirmed live), presumably Bun treating a
      // Connection: close response as complete sooner than a genuinely-endless SSE
      // stream ever is. Once every sibling request refuses to touch a pooled
      // connection, whatever this one leaves behind in the pool can't poison anything.
      const isEventStream = url.pathname.endsWith('/event')
      if (!isEventStream) fwdHeaders.set('connection', 'close')
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const upstream = await fetch(`http://127.0.0.1:${sidecarPort}${url.pathname}${url.search}`, {
        method: req.method,
        headers: fwdHeaders,
        body: hasBody ? req.body : undefined,
        // @ts-expect-error Bun requires duplex for streaming request bodies
        duplex: hasBody ? 'half' : undefined,
      })
      const outHeaders = new Headers(upstream.headers)
      outHeaders.delete('content-security-policy') // CSP referencing the sidecar's own origin would break under a different one
      // Bun re-chunks upstream.body itself when serving a streamed Response. Copying
      // the upstream's own Transfer-Encoding: chunked header through on top of that
      // double-declares chunking on already-chunked bytes. Confirmed live: curl's
      // lenient parser didn't notice, but Chromium's did (ERR_INCOMPLETE_CHUNKED_
      // ENCODING on the SSE stream specifically, the one response big/slow enough for
      // the corruption to matter). Let Bun set its own, correct encoding fresh.
      outHeaders.delete('transfer-encoding')
      outHeaders.delete('content-length')
      // Same class of bug, different header: fetch() transparently gunzips/brotli-
      // decodes the response body for us, but leaves the original Content-Encoding
      // header untouched on .headers. Copying that through made this proxy claim
      // still-compressed bytes while actually serving plain ones underneath.
      // confirmed live (ERR_CONTENT_DECODING_FAILED on /provider, /agent, /command,
      // every plain JSON route the upstream happened to compress).
      outHeaders.delete('content-encoding')
      return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
    },
    websocket: {
      // Client WS accepted first (server.upgrade already succeeded), then we open our
      // own outbound WS to the real sidecar with Basic Auth injected (a Bun-specific
      // extension of the WebSocket client that lets a server-side connection set
      // custom headers, unlike a browser's) and just pipe frames both ways.
      open(ws) {
        const wsOptions: Bun.WebSocketOptions = { headers: { Authorization: upstreamAuth } }
        // @ts-expect-error TS resolves the DOM lib's WebSocket overload here (protocols?:
        // string | string[]) instead of Bun's own (options?: Bun.WebSocketOptions) even
        // though this runs under Bun, not a browser. Same lib-resolution friction as
        // the duplex cast below.
        const upstream = new WebSocket(`ws://127.0.0.1:${sidecarPort}${ws.data.path}`, wsOptions)
        ws.data.upstream = upstream
        upstream.addEventListener('message', (e) => { try { ws.send(e.data as string | Uint8Array) } catch { /* client gone */ } })
        upstream.addEventListener('close', () => { try { ws.close() } catch { /* already closed */ } })
        upstream.addEventListener('error', () => { try { ws.close() } catch { /* already closed */ } })
      },
      message(ws, message) {
        try { ws.data.upstream?.send(message) } catch { /* upstream gone */ }
      },
      close(ws) {
        try { ws.data.upstream?.close() } catch { /* already closed */ }
      },
    },
  })
}

/** Resolve (spawning if needed) the running workspace server for a user. Rejects if it fails to start. */
export async function getUserWorkspace(userId: string): Promise<{ url: string; authHeader: string; proxyPort: number }> {
  const password = await ensurePassword()
  const authHeader = `Basic ${Buffer.from(`loki-doki:${password}`).toString('base64')}`

  let s = servers.get(userId)
  if (s?.state === 'ready') {
    // A `bun --hot` reload of this module (or anything that imports it) resets the
    // `servers` map to a fresh empty one, and Bun's own hot-reload teardown stops the
    // in-process proxy Bun.serve() instance along with it, but the sidecar itself is
    // a separate OS process, entirely unaffected, so it just keeps running. Confirmed
    // live: sidecar alive, proxy dead, backend healthy, all at once, with nothing in
    // this module's own state able to tell the difference without actually checking.
    // A cheap, short-timeout probe here is worth the latency: the alternative is
    // trusting stale state and returning a proxyPort nothing is listening on anymore.
    const alive = await fetch(`http://127.0.0.1:${s.proxyPort}/`, { method: 'HEAD', signal: AbortSignal.timeout(1_500) })
      .then(() => true).catch(() => false)
    if (alive) {
      s.lastUsedAt = Date.now()
      return { url: `http://127.0.0.1:${s.port}`, authHeader, proxyPort: s.proxyPort }
    }
    logger.warn(`[coding] proxy for user ${userId} is dead (sidecar likely still running as an orphan); respawning`)
    killWorkspaceServer(userId)
    s = undefined
  }
  if (s?.state === 'starting') {
    await new Promise<void>((resolve, reject) => { s!.readyWaiters.push(resolve); s!.failWaiters.push(reject) })
    return { url: `http://127.0.0.1:${s.port}`, authHeader, proxyPort: s.proxyPort }
  }

  if (!isOpenCodeInstalled() || !existsSync(OPENCODE_BIN)) {
    throw new Error('OpenCode is not installed. Enable it in Admin → Features')
  }
  reapIdleIfOverCapacity(userId)
  const workingDir = workspaceDirFor(userId)
  mkdirSync(workingDir, { recursive: true })
  // Explicit chmod, not just mkdir's mode param: the umask this process runs under
  // can strip the group-write bit the sandboxed coding user needs to write into its
  // own session directories, and mkdir's recursive mode is subject to that same
  // umask trimming. No-op (harmless) on the unsandboxed fallback path.
  if (isSandboxUserInstalled()) chmodSync(workingDir, 0o770)
  writeConfig(workingDir)

  const port = allocatePort(PORT_BASE)
  const proxyPort = allocatePort(PROXY_PORT_BASE)
  s = {
    userId, workingDir, port, proxyPort, proc: null, proxyServer: null, state: 'starting', error: '',
    busy: false, lastUsedAt: Date.now(), readyWaiters: [], failWaiters: [],
  }
  servers.set(userId, s)

  // `stdio: 'ignore'` (fully null fds, not just discarded output) made `opencode web`
  // fail silently and never bind its port when spawned this way, worked fine
  // manually where output redirected to a real file. Redirecting to actual log files
  // both fixes that and gives us something to read when a sidecar won't start.
  const logPath = join(workingDir, '.opencode-server.log')
  const logFd = openSync(logPath, 'a')
  const sandboxed = isSandboxUserInstalled()
  // `serve`, NOT `web`: both subcommands start the exact same HTTP server (same
  // `Server.listen`, same web UI served at `/`), verified live — the ONLY difference is
  // that `web` also shells out to `open "<url>"` (the sindresorhus `open` package) after
  // binding, launching the machine's default browser straight at the raw sidecar origin
  // (http://127.0.0.1:<port>). On this host that popped a Safari window with a native
  // "Sign in to 127.0.0.1:<port>" Basic-Auth dialog every single time the Coding app
  // spawned a fresh sidecar. There's no `--no-open` flag and `open` ignores $BROWSER on
  // macOS, so the fix is simply not to use `web`: `serve` gives us the identical UI (which
  // we reach through our own authed proxy) with no browser launch.
  const opencodeArgs = ['serve', '--port', String(port), '--hostname', '127.0.0.1']
  // Sandboxed: run as the restricted OS user via the one sudoers-permitted launch
  // script (real filesystem isolation, see codingSandboxUser.ts). Unsandboxed
  // (fresh install, or Windows where this isn't supported): spawn directly, same as
  // before: degraded to approval-gate-only, not a silent gap, surfaced in Admin.
  // sudo resets the environment by default (confirmed live: OPENCODE_SERVER_PASSWORD
  // and HOME set via spawn()'s own `env` option never reached the actual process,
  // just sudo's immediate child before it resets and execs), so those can't be
  // inherited through it. Passing them as `env VAR=val ... command` arguments instead
  // sidesteps that entirely: `env` sets them for its own exec'd child regardless of
  // what sudo already stripped, no sudoers env_keep/SETENV changes needed.
  // Per-user, nested inside their own workspace dir, not a single shared home: this is
  // where writeConfig() above actually put opencode.json (OpenCode reads config from
  // $HOME, not cwd), and a shared HOME across users would mean sharing OpenCode's own
  // per-home state (recent projects, credentials, provider config) between different
  // household members too, not just provider config.
  const homeDir = homeDirFor(workingDir)
  const codingEnvVars = [
    `OPENCODE_SERVER_USERNAME=loki-doki`,
    `OPENCODE_SERVER_PASSWORD=${password}`,
    `HOME=${homeDir}`,
  ]
  const [spawnBin, spawnArgs] = sandboxed
    ? (() => {
        ensureSandboxRuntimeMirrored(OPENCODE_DIR)
        mkdirSync(homeDir, { recursive: true })
        chmodSync(homeDir, 0o770)
        const mirroredBin = join(SANDBOX_RUNTIME_DIR, 'node_modules', '.bin', 'opencode')
        return ['sudo', ['-u', SANDBOX_USER, LAUNCH_SCRIPT, 'env', ...codingEnvVars, mirroredBin, ...opencodeArgs]] as const
      })()
    : (() => {
        mkdirSync(homeDir, { recursive: true })
        return ['env', [...codingEnvVars, OPENCODE_BIN, ...opencodeArgs]] as const
      })()
  const child = spawn(spawnBin, spawnArgs, {
    cwd: workingDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })
  s.proc = child
  child.on('exit', () => {
    const cur = servers.get(userId)
    if (cur !== s) return
    if (s.state === 'ready') logger.warn(`[coding] workspace server for user ${userId} died`)
    servers.delete(userId)
    usedPorts.delete(port)
    usedPorts.delete(proxyPort)
    if (s.proxyServer) { try { s.proxyServer.stop(true) } catch { /* already gone */ } }
  })
  child.unref()

  const deadline = Date.now() + 60_000
  const poll = async (): Promise<void> => {
    if (servers.get(userId) !== s) return
    try {
      // /doc requires Basic Auth like every other endpoint: an unauthenticated poll
      // gets 401 forever and never sees success, timing out even once the server is
      // actually up.
      const r = await fetch(`http://127.0.0.1:${port}/doc`, {
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(3_000),
      })
      if (r.ok) {
        const secret = await ensureProxySecret()
        s.proxyServer = startProxy(userId, port, proxyPort, authHeader, secret)
        s.state = 'ready'
        s.readyWaiters.forEach((w) => w())
        s.readyWaiters = []; s.failWaiters = []
        return
      }
    } catch { /* not up yet */ }
    if (Date.now() >= deadline) {
      s.state = 'failed'
      s.error = 'opencode server did not start within 60 seconds'
      const err = new Error(s.error)
      s.failWaiters.forEach((w) => w(err))
      killWorkspaceServer(userId)
      throw err
    }
    await new Promise((r) => setTimeout(r, 1_000))
    return poll()
  }
  await poll()
  return { url: `http://127.0.0.1:${port}`, authHeader, proxyPort }
}

export function markWorkspaceBusy(userId: string, busy: boolean): void {
  const s = servers.get(userId)
  if (s) { s.busy = busy; s.lastUsedAt = Date.now() }
}

export { killWorkspaceServer }

export function stopAllCodingServers(): void {
  for (const userId of [...servers.keys()]) killWorkspaceServer(userId)
}

// Periodic idle reap so a user who stopped using Coding doesn't hold a process forever.
setInterval(() => {
  const now = Date.now()
  for (const s of [...servers.values()]) {
    if (!s.busy && s.state === 'ready' && now - s.lastUsedAt > IDLE_REAP_MS) killWorkspaceServer(s.userId)
  }
}, 5 * 60_000).unref()
