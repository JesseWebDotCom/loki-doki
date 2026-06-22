import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAdmin } from '@/middleware/auth'
import { collectUninstallTargets, runUninstall, type UninstallEmit } from '@/lib/uninstall'
import type { AppEnv } from '@/types'

const adminUninstall = new Hono<AppEnv>()

// Read-only preview powering the confirmation dialog: what exactly gets deleted.
adminUninstall.get('/preview', requireAdmin, async (c) => {
  return c.json(await collectUninstallTargets())
})

// Irreversible: wipe the data dir, every Ollama model, and the system Ollama
// install, streaming progress — then shut the server process down so nothing
// keeps the deleted database open. Requires the literal confirmation phrase.
adminUninstall.post('/', requireAdmin, async (c) => {
  const { confirm } = (await c.req.json().catch(() => ({}))) as { confirm?: string }
  if (confirm !== 'UNINSTALL') {
    return c.json({ error: 'Confirmation phrase required.' }, 400)
  }

  return streamSSE(c, async (stream) => {
    const emit: UninstallEmit = (event, data) =>
      stream.writeSSE({ event, data: JSON.stringify(data) })

    try {
      await runUninstall(emit)
      await stream.writeSSE({ event: 'done', data: '{}' })
      // Let the SSE buffer flush to the client, then terminate the process. The
      // database file is gone; staying alive would only rewrite garbage.
      setTimeout(() => process.exit(0), 1_500)
    } catch (err) {
      // Catastrophic failure before/while wiping — leave the server up so the
      // admin can see the error and retry, rather than killing a working install.
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: String(err) }) })
    }
  })
})

export { adminUninstall }
