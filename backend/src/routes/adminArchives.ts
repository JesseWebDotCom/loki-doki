import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { and, eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { db } from '@/db'
import { zimArchives, downloadJobs } from '@/db/schema'
import { ZIM_CATALOG } from '@/lib/zimCatalog'
import {
  kiwixZimDir,
  restartKiwix,
  getKiwixState,
  getKiwixError,
  isKiwixInstalled,
  installKiwixTools,
} from '@/lib/kiwix'
import { downloadArchive, listHealthyArchivePaths, syncKiwixWithArchives } from '@/lib/archives'
import { requireAdmin } from '@/middleware/auth'
import { dataDir } from '@/lib/download'
import { isGloballyOffline, isDownloadBlocked } from '@/lib/connectivity'
import type { AppEnv } from '@/types'

const adminArchives = new Hono<AppEnv>()
adminArchives.use('*', requireAdmin)

// Active downloads: sourceId → AbortController
const activeDownloads = new Map<string, AbortController>()

// ── Catalog ───────────────────────────────────────────────────────────────────

adminArchives.get('/catalog', async (c) => {
  const rows = await db.select().from(zimArchives)
  const installedMap = new Map(rows.map((r) => [r.sourceId, r]))

  const catalog = ZIM_CATALOG.map((source) => {
    const installed = installedMap.get(source.sourceId)
    return {
      ...source,
      installed:   !!installed,
      installedAt: installed?.downloadedAt ?? null,
      fileSizeBytes: installed?.fileSizeBytes ?? null,
      zimDate:     installed?.zimDate ?? null,
      variantKey:  installed?.variantKey ?? source.defaultVariant,
      kiwixBookName: installed?.kiwixBookName ?? null,
    }
  })

  return c.json({
    catalog,
    kiwixInstalled: isKiwixInstalled(),
    kiwixState:     getKiwixState(),
    kiwixError:     getKiwixError() || null,
  })
})

// ── Download (SSE progress stream) ───────────────────────────────────────────

adminArchives.get('/download/:sourceId', async (c) => {
  if (await isDownloadBlocked()) return c.json({ error: 'Offline mode is active — downloads are unavailable.' }, 503)
  const { sourceId } = c.req.param()
  const { variantKey: vk } = c.req.query()

  const source = ZIM_CATALOG.find((s) => s.sourceId === sourceId)
  if (!source) return c.json({ error: 'Unknown source' }, 404)

  const variantKey = vk ?? source.defaultVariant
  const variant    = source.variants.find((v) => v.key === variantKey)
  if (!variant) return c.json({ error: 'Unknown variant' }, 400)

  if (activeDownloads.has(sourceId)) return c.json({ error: 'Already downloading' }, 409)

  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const controller = new AbortController()
    activeDownloads.set(sourceId, controller)

    // If the client closes the stream (page reload, StrictMode remount, retry),
    // abort the in-flight download and drop the registration — otherwise the stale
    // entry makes the next attempt 409 ("Already downloading") and nothing starts.
    stream.onAbort(() => {
      controller.abort()
      activeDownloads.delete(sourceId)
    })

    const emit = async (event: string, data: object) => {
      await stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {})
    }

    try {
      // Shared core (also used by the background download-job manager).
      const { kiwixBookName, filePath } = await downloadArchive(
        sourceId, variantKey,
        async (p) => {
          if (p.note) await emit('status', { msg: p.note })
          else await emit('progress', { completed: p.completed, total: p.total, speedBps: p.speedBps, etaSeconds: p.etaSeconds })
        },
        controller.signal,
      )
      await emit('done', { sourceId, kiwixBookName, filePath })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        await emit('cancelled', { sourceId })
      } else {
        await emit('error', { msg: String(err) })
      }
    } finally {
      activeDownloads.delete(sourceId)
    }
  })
})

// ── Cancel download ───────────────────────────────────────────────────────────

adminArchives.post('/cancel/:sourceId', (c) => {
  const { sourceId } = c.req.param()
  const ctrl = activeDownloads.get(sourceId)
  if (ctrl) { ctrl.abort(); activeDownloads.delete(sourceId) }
  return c.json({ ok: true })
})

// ── Delete installed archive ──────────────────────────────────────────────────

adminArchives.delete('/:sourceId', async (c) => {
  const { sourceId } = c.req.param()
  const row = await db.select().from(zimArchives)
    .where(eq(zimArchives.sourceId, sourceId))
    .then((r) => r[0])

  if (!row) return c.json({ error: 'Not found' }, 404)

  // Delete file
  if (row.filePath && existsSync(row.filePath)) {
    await rm(row.filePath, { force: true })
  }
  // Try to remove the source dir too (if empty)
  try {
    await rm(join(kiwixZimDir, sourceId), { recursive: true, force: true })
  } catch { /* non-fatal */ }

  await db.delete(zimArchives).where(eq(zimArchives.sourceId, sourceId))
  // Drop the background-queue row too, so the pack shows as removed everywhere and a later
  // re-add enqueues a fresh download instead of being skipped as "already completed".
  await db.delete(downloadJobs).where(and(eq(downloadJobs.type, 'archive'), eq(downloadJobs.refId, sourceId)))

  // Restart kiwix with updated list
  const allRows  = await db.select().from(zimArchives)
  const zimPaths = allRows.map((r) => r.filePath).filter(Boolean) as string[]
  restartKiwix(zimPaths).catch(() => {})

  return c.json({ ok: true })
})

// ── Install kiwix-tools (SSE) ─────────────────────────────────────────────────

adminArchives.post('/install-kiwix', async (c) => {
  if (await isDownloadBlocked()) return c.json({ error: 'Offline mode is active — downloads are unavailable.' }, 503)
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const emit = async (msg: string) => {
      await stream.writeSSE({ event: 'status', data: JSON.stringify({ msg }) }).catch(() => {})
    }
    try {
      await installKiwixTools(emit)
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true }) }).catch(() => {})
    } catch (err) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ msg: String(err) }) }).catch(() => {})
    }
  })
})

// ── Verify / repair: scan installed archives, quarantine corrupt ones, re-queue them ──
adminArchives.post('/verify', async (c) => {
  const { valid, quarantined } = await listHealthyArchivePaths()
  await syncKiwixWithArchives()  // restart serving the healthy set
  return c.json({ ok: true, healthy: valid.length, quarantined })
})

export { adminArchives }
