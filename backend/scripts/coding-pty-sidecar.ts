// Coding-terminal PTY sidecar — a thin, coding-agnostic bridge between a WebSocket
// and a real PTY-attached child process (tmux attach-session, in practice).
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
//   WS   /attach           first message: JSON { cmd, args, cwd, env, cols, rows }
//                          then: binary frames = raw PTY I/O both ways;
//                          text frames = JSON control { type: 'resize', cols, rows }

import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import * as pty from 'node-pty'

const PORT = parseInt(process.env.CODING_PTY_SIDECAR_PORT ?? '8094')

interface SpawnMsg {
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols?: number
  rows?: number
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server, path: '/attach' })

wss.on('connection', (ws: WebSocket) => {
  let term: pty.IPty | null = null

  const cleanup = () => { try { term?.kill() } catch { /* already gone */ } }

  ws.once('message', (raw) => {
    let spawnMsg: SpawnMsg
    try { spawnMsg = JSON.parse(raw.toString()) as SpawnMsg }
    catch { ws.close(1008, 'first message must be JSON spawn params'); return }

    try {
      term = pty.spawn(spawnMsg.cmd, spawnMsg.args, {
        name: 'xterm-256color',
        cols: spawnMsg.cols ?? 80,
        rows: spawnMsg.rows ?? 24,
        cwd: spawnMsg.cwd,
        env: spawnMsg.env,
      })
    } catch (err) {
      ws.close(1011, `pty spawn failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    term.onData((data) => { try { ws.send(data) } catch { /* client gone */ } })
    term.onExit(() => { try { ws.close() } catch { /* already closed */ } })

    ws.on('message', (data, isBinary) => {
      if (!term) return
      if (!isBinary) {
        // Text frame: control message, not PTY input.
        try {
          const msg = JSON.parse(data.toString()) as { type?: string; cols?: number; rows?: number }
          if (msg.type === 'resize' && msg.cols && msg.rows) term.resize(msg.cols, msg.rows)
          return
        } catch { /* not JSON — fall through and treat as raw input */ }
      }
      term.write(data.toString())
    })
  })

  ws.on('close', cleanup)
  ws.on('error', cleanup)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`coding-pty-sidecar listening on 127.0.0.1:${PORT}`)
})
