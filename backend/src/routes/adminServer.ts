// Admin server maintenance: version/update status, manual update checks, the
// fast-forward self-update, and restart. Restart/update end in process.exit(0)
// — the launcher's supervise loop (run.ps1 / run.sh) starts the process again.

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAdmin } from '@/middleware/auth'
import { stopSidecarsForExit } from '@/lib/gracefulExit'
import {
  getPhase,
  getServerStatus,
  getUpdateEvents,
  getUpdateSettings,
  onUpdateEvent,
  runManualCheck,
  setUpdateSettings,
  startUpdate,
  tryBeginRestart,
  writeShutdownSentinel,
  type UpdateCheckMode,
} from '@/lib/serverUpdate'
import type { AppEnv } from '@/types'

const adminServer = new Hono<AppEnv>()

adminServer.get('/status', requireAdmin, async (c) => {
  return c.json(await getServerStatus())
})

// Manual "Check for updates": one fetch, plain JSON.
adminServer.post('/check', requireAdmin, async (c) => {
  if (getPhase() !== 'idle') return c.json({ error: 'busy', phase: getPhase() }, 409)
  const res = await runManualCheck()
  if (!res) {
    return c.json({ error: 'Could not check for updates. Is the server online and running from a git checkout with an upstream?' }, 502)
  }
  return c.json(res)
})

// Restart: stop sidecars (they would hold their ports across the supervisor
// restart), flush the stream, exit. Same choreography as adminUninstall.
adminServer.post('/restart', requireAdmin, async (c) => {
  if (!tryBeginRestart()) return c.json({ error: 'busy', phase: getPhase() }, 409)

  return streamSSE(c, async (stream) => {
    const emit = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) })

    await emit('step', { key: 'stop', label: 'Stopping services', status: 'run' })
    await stopSidecarsForExit()
    await emit('step', { key: 'stop', label: 'Stopping services', status: 'ok' })
    await emit('done', { willRestart: true })
    setTimeout(() => process.exit(0), 1_500)
  })
})

// Shutdown: like restart, but drop the sentinel file first so the launcher's
// supervise loop tears down instead of respawning the backend.
adminServer.post('/shutdown', requireAdmin, async (c) => {
  if (!tryBeginRestart()) return c.json({ error: 'busy', phase: getPhase() }, 409)

  return streamSSE(c, async (stream) => {
    const emit = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) })

    await emit('step', { key: 'stop', label: 'Stopping services', status: 'run' })
    await stopSidecarsForExit()
    await writeShutdownSentinel()
    await emit('step', { key: 'stop', label: 'Stopping services', status: 'ok' })
    await emit('done', { shutdown: true })
    setTimeout(() => process.exit(0), 1_500)
  })
})

// Kick off the update pipeline; progress is consumed via GET /update/stream so
// it survives page refreshes and reaches every admin.
adminServer.post('/update', requireAdmin, async (c) => {
  if (!startUpdate()) return c.json({ error: 'busy', phase: getPhase() }, 409)
  return c.json({ started: true }, 202)
})

// Replay-then-follow progress stream (boot-singleton pattern from
// routes/system.ts, but pull-based: each write is awaited in order, so a
// buffer that already ends in done/error still flushes fully before the
// stream closes).
adminServer.get('/update/stream', requireAdmin, async (c) => {
  return streamSSE(c, async (stream) => {
    let wake: (() => void) | null = null
    let open = true
    const unsub = onUpdateEvent(() => wake?.())
    stream.onAbort(() => {
      open = false
      wake?.()
    })

    try {
      let sent = 0
      while (open) {
        let events = getUpdateEvents()
        if (sent > events.length) sent = 0 // a new run swapped in a fresh buffer
        while (open && sent < events.length) {
          const e = events[sent++]!
          await stream.writeSSE(e)
          if (e.event === 'done' || e.event === 'error') return
          events = getUpdateEvents()
        }
        // Fully drained without a terminal event and nothing running: close
        // instead of hanging (fresh boot with an empty buffer).
        if (getPhase() !== 'updating' && getPhase() !== 'restarting') {
          if (open) await stream.writeSSE({ event: 'done', data: JSON.stringify({ idle: true }) })
          return
        }
        if (!open) return
        await new Promise<void>((r) => { wake = r })
        wake = null
      }
    } finally {
      unsub()
    }
  })
})

adminServer.get('/settings', requireAdmin, async (c) => {
  return c.json(await getUpdateSettings())
})

adminServer.put('/settings', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string; intervalHours?: number }
  const patch: { mode?: UpdateCheckMode; intervalHours?: number } = {}
  if (body.mode !== undefined) {
    if (!['off', 'notify', 'auto'].includes(body.mode)) return c.json({ error: 'invalid mode' }, 400)
    patch.mode = body.mode as UpdateCheckMode
  }
  if (body.intervalHours !== undefined) {
    const n = Number(body.intervalHours)
    if (!Number.isFinite(n) || n < 1 || n > 168) return c.json({ error: 'invalid interval' }, 400)
    patch.intervalHours = Math.round(n)
  }
  return c.json(await setUpdateSettings(patch))
})

export { adminServer }
