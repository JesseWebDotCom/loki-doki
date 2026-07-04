// Coding app API. The frontend renders a real terminal (xterm.js) attached to this
// user's persistent tmux session, which wraps a single `claude` (Claude Code CLI)
// process — see lib/codingServer.ts for session/pane management and
// lib/codingPtySidecar.ts for the actual PTY attach (hosted in a small Node sidecar,
// not this Bun process: node-pty's data-callback delivery is unreliable under Bun).
//
// This route is a thin relay: `/terminal` bridges the browser's WebSocket to the PTY
// sidecar's WebSocket, verbatim, in both directions (same open/message/close piping
// shape the old OpenCode auth-proxy used, just a different upstream). The three
// `/pane/*` endpoints just issue tmux split/kill commands against the user's session.

import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { createBunWebSocket } from 'hono/bun'
import { resolveSession, requireAuth } from '@/middleware/auth'
import { buildAttachSpawnParams, paneControl, type PaneAction } from '@/lib/codingServer'
import { ensureCodingPtySidecarReady, codingPtySidecarWsUrl } from '@/lib/codingPtySidecar'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

type UpgradeWebSocket = ReturnType<typeof createBunWebSocket>['upgradeWebSocket']

export function createCodingRoute(upgradeWebSocket: UpgradeWebSocket) {
  const coding = new Hono<AppEnv>()

  coding.get(
    '/terminal',
    upgradeWebSocket(async (c) => {
      // Resolve the session cookie at upgrade time — auth middleware doesn't run on
      // the upgraded socket (same pattern as routes/stt.ts).
      const token = getCookie(c, 'session')
      const user = token ? await resolveSession(token) : null

      let upstream: WebSocket | null = null
      // Setting up `upstream` is asynchronous (ensureCodingPtySidecarReady +
      // buildAttachSpawnParams both await), but the browser's own WS is already
      // "open" the instant its handshake completes — it sends its initial resize
      // message (the terminal's real cols/rows) immediately on open, which can land
      // here before `upstream` is even assigned, or while it's still CONNECTING
      // (send() throws before OPEN, silently swallowed below). Confirmed live: that
      // dropped resize left the PTY stuck at the sidecar's hardcoded 80x24 fallback
      // forever, since nothing resends it once the container's size stops changing.
      // Queue anything that arrives before upstream is genuinely OPEN and flush it,
      // in order, once it is.
      const pending: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = []

      return {
        async onOpen(_evt, ws) {
          if (!user) { try { ws.close(4401, 'unauthorized') } catch { /* ignore */ }; return }
          try {
            await ensureCodingPtySidecarReady()
            const spawnParams = await buildAttachSpawnParams(user.id)
            upstream = new WebSocket(codingPtySidecarWsUrl())
            upstream.addEventListener('open', () => {
              try {
                upstream?.send(JSON.stringify(spawnParams))
                for (const msg of pending) upstream?.send(msg as string)
                pending.length = 0
              } catch { /* closed already */ }
            })
            upstream.addEventListener('message', (e) => { try { ws.send(e.data as string) } catch { /* client gone */ } })
            upstream.addEventListener('close', () => { try { ws.close() } catch { /* already closed */ } })
            upstream.addEventListener('error', () => { try { ws.close() } catch { /* already closed */ } })
          } catch (err) {
            logger.warn(`[coding] terminal attach failed for user ${user.id}: ${err instanceof Error ? err.message : String(err)}`)
            try { ws.close(1011, 'coding terminal unavailable') } catch { /* ignore */ }
          }
        },
        onMessage(evt) {
          if (upstream?.readyState === WebSocket.OPEN) {
            try { upstream.send(evt.data as string) } catch { /* upstream gone */ }
          } else {
            pending.push(evt.data as string)
          }
        },
        onClose() {
          // Kill only this attach client — the tmux session (and `claude` inside it)
          // keeps running server-side. That persistence across disconnect/reload is
          // the entire point of the tmux-backed design.
          try { upstream?.close() } catch { /* already closed */ }
          upstream = null
        },
      }
    }),
  )

  coding.post('/pane/:action', requireAuth, async (c) => {
    const user = c.get('user')
    const action = c.req.param('action') as PaneAction
    if (action !== 'split-h' && action !== 'split-v' && action !== 'close') {
      return c.json({ error: 'invalid pane action' }, 400)
    }
    try {
      await paneControl(user.id, action)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'pane action failed' }, 503)
    }
  })

  return coding
}
