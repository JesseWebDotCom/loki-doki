// Coding-terminal PTY sidecar — a thin, coding-agnostic bridge between a WebSocket
// and a real PTY-attached child process.
//
// IMPORTANT: this runs under **Node** (not Bun) — node-pty's native addon loads under
// Bun but its data-callback delivery is unreliable there (confirmed live: chunks
// silently dropped/truncated versus identical code under Node). Same root cause as
// the voice-server sidecar (onnxruntime-node segfaults under Bun): a native addon
// whose event delivery depends on libuv/Node's own binding glue, not just N-API
// symbol compatibility. Spawned by lib/codingPtySidecar.ts.
//
// Deliberately knows nothing about tmux, users, or sandboxing — the caller (Bun
// backend) decides what command/args/cwd/env to run; this just gives it a real PTY
// and bridges bytes. Keeps all coding-specific logic in lib/codingServer.ts.
//
//   GET  /health          → { ok: true }
//   POST /session/kill    → body { sessionKey } — kill a persistent session (model change / admin)
//   POST /run             → body { cmd, args, cwd, env, timeoutMs? } — one-shot NON-pty exec
//                          (headless `claude -p`); responds { code, stdout, stderr }. Runs as
//                          THIS process's user — which is the whole point when the sidecar
//                          runs as the restricted sandbox user on Windows.
//   POST /shutdown        → kill every session and exit (cooperative teardown: on Windows the
//                          backend cannot signal a sidecar running as the sandbox user)
//   WS   /attach           first message: JSON { cmd, args, cwd, env, cols, rows, sessionKey?, persistent? }
//                          then: binary frames = raw PTY I/O both ways;
//                          text frames = JSON control { type: 'resize', cols, rows }
//
// Two modes, chosen by the first message:
//   • persistent falsy  → legacy: one pty per socket, killed when the socket closes. tmux
//     (mac/Linux) uses this — the pty runs `tmux attach`, and tmux itself owns persistence.
//   • persistent + sessionKey → a stateful, reattachable session keyed by sessionKey: the pty
//     survives socket disconnects (reload-to-reconnect) and is shared across concurrent tabs.
//     This reproduces tmux's persistence + reattach on platforms without tmux (Windows).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn as spawnChild } from 'node:child_process'
import { WebSocketServer, type WebSocket } from 'ws'
import * as pty from 'node-pty'

const PORT = parseInt(process.env.CODING_PTY_SIDECAR_PORT ?? '8094')
// Sticky first slice of output always replayed on reattach so terminal-mode setup
// (alt-screen enter, mouse mode, SGR) is restored even after the ring has rolled past it.
const INIT_PREFIX_MAX = 8 * 1024
// Rolling recent output kept for reattach scrollback.
const RING_MAX_BYTES  = parseInt(process.env.CODING_RING_MAX_BYTES ?? '1000000')
// A detached session (no attached clients) is reaped after this long, since on a tmux-less
// platform every session lives inside this process and would otherwise leak.
const IDLE_REAP_MS = Math.max(1, parseInt(process.env.CODING_SESSION_IDLE_HOURS ?? '24')) * 3_600_000

interface SpawnMsg {
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols?: number
  rows?: number
  sessionKey?: string
  persistent?: boolean
}

interface Session {
  key: string
  term: pty.IPty
  clients: Set<WebSocket>
  clientSizes: Map<WebSocket, { cols: number; rows: number }>
  initPrefix: string[]
  initLen: number
  ring: string[]
  ringLen: number
  ringDropped: boolean
  cols: number
  rows: number
  reapTimer: ReturnType<typeof setTimeout> | null
  alive: boolean
}

const sessions = new Map<string, Session>()

function trySend(ws: WebSocket, data: string): void { try { ws.send(data) } catch { /* client gone */ } }
function tryClose(ws: WebSocket): void { try { ws.close() } catch { /* already closed */ } }

// Pty size for a session = the SMALLEST cols/rows across attached clients (matches tmux's
// "shrink to the smallest attached client" so no client is asked to draw outside its viewport).
function recomputeSize(s: Session): void {
  if (s.clientSizes.size === 0) return  // keep last size; never resize to 0
  let cols = Infinity, rows = Infinity
  for (const { cols: c, rows: r } of s.clientSizes.values()) { cols = Math.min(cols, c); rows = Math.min(rows, r) }
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return
  if (cols === s.cols && rows === s.rows) return
  s.cols = cols; s.rows = rows
  try { s.term.resize(cols, rows) } catch { /* pty gone */ }
}

function appendOutput(s: Session, data: string): void {
  if (s.initLen < INIT_PREFIX_MAX) { s.initPrefix.push(data); s.initLen += data.length }
  s.ring.push(data); s.ringLen += data.length
  while (s.ringLen > RING_MAX_BYTES && s.ring.length > 1) {
    const dropped = s.ring.shift()!
    s.ringLen -= dropped.length
    s.ringDropped = true
  }
}

function destroySession(s: Session): void {
  if (s.reapTimer) { clearTimeout(s.reapTimer); s.reapTimer = null }
  s.alive = false
  try { s.term.kill() } catch { /* already gone */ }
  for (const ws of s.clients) tryClose(ws)
  s.clients.clear()
  s.clientSizes.clear()
  sessions.delete(s.key)
}

function spawnTerm(msg: SpawnMsg): pty.IPty {
  return pty.spawn(msg.cmd, msg.args, {
    name: 'xterm-256color',
    cols: msg.cols ?? 80,
    rows: msg.rows ?? 24,
    cwd: msg.cwd,
    env: msg.env,
  })
}

// ── Legacy (non-persistent) path: one pty per socket, killed on close. Unchanged behavior. ──
function handleLegacy(ws: WebSocket, msg: SpawnMsg): void {
  let term: pty.IPty | null = null
  const cleanup = () => { try { term?.kill() } catch { /* already gone */ } }
  try {
    term = spawnTerm(msg)
  } catch (err) {
    ws.close(1011, `pty spawn failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  term.onData((data) => trySend(ws, data))
  term.onExit(() => tryClose(ws))
  ws.on('message', (data, isBinary) => {
    if (!term) return
    if (!isBinary) {
      try {
        const control = JSON.parse(data.toString()) as { type?: string; cols?: number; rows?: number }
        if (control.type === 'resize' && control.cols && control.rows) term.resize(control.cols, control.rows)
        return
      } catch { /* not JSON — fall through and treat as raw input */ }
    }
    term.write(data.toString())
  })
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}

// ── Persistent path: reattachable, tab-shared session keyed by sessionKey. ──
function handlePersistent(ws: WebSocket, msg: SpawnMsg, key: string): void {
  let s = sessions.get(key)
  const initialCols = msg.cols ?? 80
  const initialRows = msg.rows ?? 24

  if (!s || !s.alive) {
    // Spawn a fresh session and register it.
    let term: pty.IPty
    try {
      term = spawnTerm(msg)
    } catch (err) {
      ws.close(1011, `pty spawn failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    s = {
      key, term, clients: new Set(), clientSizes: new Map(),
      initPrefix: [], initLen: 0, ring: [], ringLen: 0, ringDropped: false,
      cols: initialCols, rows: initialRows, reapTimer: null, alive: true,
    }
    sessions.set(key, s)
    const session = s
    term.onData((data) => {
      appendOutput(session, data)
      for (const client of session.clients) trySend(client, data)
    })
    term.onExit(() => { if (session.alive) destroySession(session) })
  }

  // Attach this client to the (new or existing) session.
  const session = s
  if (session.reapTimer) { clearTimeout(session.reapTimer); session.reapTimer = null }
  session.clients.add(ws)
  session.clientSizes.set(ws, { cols: initialCols, rows: initialRows })

  // Replay so the freshly-created browser xterm shows current state. If the ring still holds
  // the session start, it already contains the init prefix — send it alone to avoid duplication;
  // otherwise prepend the sticky init prefix (terminal-mode setup) then the rolling ring.
  const replay = session.ringDropped
    ? session.initPrefix.join('') + session.ring.join('')
    : session.ring.join('')
  if (replay) trySend(ws, replay)

  // Recompute the shared size, then nudge it (rows-1 → rows) to force a SIGWINCH so a TUI
  // (claude is an Ink app) repaints. On Windows ConPTY also re-emits its whole buffer on resize.
  recomputeSize(session)
  try {
    session.term.resize(session.cols, Math.max(1, session.rows - 1))
    session.term.resize(session.cols, session.rows)
  } catch { /* pty gone */ }

  ws.on('message', (data, isBinary) => {
    if (!session.alive) return
    if (!isBinary) {
      try {
        const control = JSON.parse(data.toString()) as { type?: string; cols?: number; rows?: number }
        if (control.type === 'resize' && control.cols && control.rows) {
          session.clientSizes.set(ws, { cols: control.cols, rows: control.rows })
          recomputeSize(session)
        }
        return
      } catch { /* not JSON — fall through and treat as raw input */ }
    }
    try { session.term.write(data.toString()) } catch { /* pty gone */ }
  })

  const detach = () => {
    session.clients.delete(ws)
    session.clientSizes.delete(ws)
    recomputeSize(session)
    // Keep the pty alive on disconnect (reload-to-reconnect). Reap only after a long idle with
    // no clients so a tmux-less session doesn't linger forever.
    if (session.clients.size === 0 && session.alive && !session.reapTimer) {
      session.reapTimer = setTimeout(() => { if (session.alive && session.clients.size === 0) destroySession(session) }, IDLE_REAP_MS)
    }
  }
  ws.on('close', detach)
  ws.on('error', detach)
}

// ── HTTP: health + session kill ──
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (req.url === '/session/kill' && req.method === 'POST') {
    void readJsonBody(req).then((body) => {
      const key = typeof body.sessionKey === 'string' ? body.sessionKey : ''
      const s = key ? sessions.get(key) : undefined
      const existed = !!s
      if (s) destroySession(s)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, existed }))
    })
    return
  }
  if (req.url === '/run' && req.method === 'POST') {
    void readJsonBody(req).then((body) => {
      const cmd = typeof body.cmd === 'string' ? body.cmd : ''
      const args = Array.isArray(body.args) ? (body.args as string[]) : []
      const cwd = typeof body.cwd === 'string' ? body.cwd : process.cwd()
      const env = (body.env && typeof body.env === 'object') ? (body.env as Record<string, string>) : {}
      const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 5 * 60_000
      if (!cmd) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'cmd required' }))
        return
      }
      let stdout = ''
      let stderr = ''
      const child = spawnChild(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const timer = setTimeout(() => { try { child.kill('SIGTERM') } catch { /* already gone */ } }, timeoutMs)
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
      let done = false
      const finish = (code: number | null) => {
        if (done) return  // 'error' (spawn failure) and 'close' can both fire
        done = true
        clearTimeout(timer)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code, stdout, stderr }))
      }
      child.on('close', finish)
      child.on('error', (err) => { stderr += String(err); finish(null) })
    })
    return
  }
  if (req.url === '/shutdown' && req.method === 'POST') {
    for (const s of [...sessions.values()]) destroySession(s)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    // Let the response flush before exiting.
    setTimeout(() => process.exit(0), 150)
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server, path: '/attach' })

wss.on('connection', (ws: WebSocket) => {
  ws.once('message', (raw) => {
    let msg: SpawnMsg
    try { msg = JSON.parse(raw.toString()) as SpawnMsg }
    catch { ws.close(1008, 'first message must be JSON spawn params'); return }

    if (msg.persistent && msg.sessionKey) handlePersistent(ws, msg, msg.sessionKey)
    else handleLegacy(ws, msg)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`coding-pty-sidecar listening on 127.0.0.1:${PORT}`)
})
