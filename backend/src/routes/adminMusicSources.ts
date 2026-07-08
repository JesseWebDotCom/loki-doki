// Admin → Music → Sources: manage local music library folders (and, next phase, Plex music
// sections). Adding a folder IS the enable action — it validates, saves, and queues the
// first scan in one step; no separate on/off switch.

import { promises as fs } from 'node:fs'
import { basename, isAbsolute, resolve as resolvePath } from 'node:path'
import { Hono } from 'hono'
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { downloadJobs, musicLocalFolders, musicLocalTracks } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import { enqueueMusicScan } from '@/lib/downloadJobs'
import { crossPlatformPathHint } from '@/lib/storage/accessCheck'
import { logger } from '@/lib/logger'

export const adminMusicSources = new Hono()
adminMusicSources.use('*', requireAdmin)

/** Library folders are read-only external mounts — validate readability only (a NAS export
 *  mounted ro is perfectly fine here; checkDirectoryAccess's write/rename/delete probes are
 *  for app-managed write roots and would wrongly reject it). */
async function checkReadableDir(path: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isDirectory()) return { ok: false, error: 'Path is not a directory.' }
    await fs.readdir(path)
    return { ok: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: 'Directory does not exist.' }
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'The app has no permission to read this directory.' }
    return { ok: false, error: String(err) }
  }
}

async function folderDto(row: typeof musicLocalFolders.$inferSelect) {
  // Live scan-job progress, when one is pending/running for this folder.
  const [job] = await db.select({ status: downloadJobs.status, progress: downloadJobs.progress })
    .from(downloadJobs)
    .where(sql`${downloadJobs.variantKey} = ${'music-scan:' + row.id} AND ${downloadJobs.status} IN ('pending','running')`)
    .limit(1)
  return {
    id: row.id,
    path: row.path,
    name: basename(row.path),
    kind: row.kind,
    enabled: row.enabled,
    trackCount: row.trackCount,
    lastScanAt: row.lastScanAt,
    lastScanStatus: job ? 'scanning' : row.lastScanStatus,
    lastScanError: row.lastScanError,
    scanJob: job ? { status: job.status, progress: job.progress ? JSON.parse(job.progress) : null } : null,
  }
}

// ── GET /sources — everything the Sources panel renders ───────────────────────────
adminMusicSources.get('/sources', async (c) => {
  const folders = await db.select().from(musicLocalFolders).orderBy(asc(musicLocalFolders.createdAt))
  return c.json({
    local: { folders: await Promise.all(folders.map(folderDto)) },
    // Plex music lands in phase A2; the shape is stable so the UI can build against it now.
    plex: { configured: false, sections: [] },
  })
})

// ── POST /local-folders — validate + add + kick the first scan ─────────────────────
adminMusicSources.post('/local-folders', async (c) => {
  const { path } = await c.req.json<{ path: string }>()
  const trimmed = (path ?? '').trim()
  if (!trimmed || !isAbsolute(trimmed)) {
    return c.json({ error: crossPlatformPathHint(trimmed) ?? 'Path must be an absolute filesystem path.' }, 400)
  }
  const normalized = resolvePath(trimmed)
  const check = await checkReadableDir(normalized)
  if (!check.ok) return c.json({ error: check.error }, 400)

  const existing = await db.select({ id: musicLocalFolders.id, path: musicLocalFolders.path }).from(musicLocalFolders)
  if (existing.some((f) => f.path === normalized)) return c.json({ error: 'That folder is already in the library.' }, 409)
  // Nested roots double-index every file (and double-play in the library) — reject early.
  const sep = normalized.endsWith('/') ? '' : '/'
  if (existing.some((f) => normalized.startsWith(`${f.path}/`) || f.path.startsWith(`${normalized}${sep}`))) {
    return c.json({ error: 'That folder overlaps a folder already in the library.' }, 409)
  }

  const id = crypto.randomUUID()
  await db.insert(musicLocalFolders).values({
    id, path: normalized, kind: 'admin', enabled: true,
    lastScanAt: null, lastScanStatus: 'idle', lastScanError: null, trackCount: 0, createdAt: new Date(),
  })
  await enqueueMusicScan(id, `Scan music folder ${basename(normalized)}`)
  const [row] = await db.select().from(musicLocalFolders).where(eq(musicLocalFolders.id, id)).limit(1)
  return c.json({ folder: await folderDto(row!) })
})

// ── POST /local-folders/:id/scan — manual rescan ──────────────────────────────────
adminMusicSources.post('/local-folders/:id/scan', async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(musicLocalFolders).where(eq(musicLocalFolders.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  await enqueueMusicScan(id, `Scan music folder ${basename(row.path)}`)
  return c.json({ ok: true })
})

// ── DELETE /local-folders/:id — remove folder + its indexed tracks ────────────────
// The files themselves are untouched (read-only mount). Track rows cascade via FK;
// playlist/favorite refs to them fall back to YouTube re-resolution at play time.
adminMusicSources.delete('/local-folders/:id', async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(musicLocalFolders).where(eq(musicLocalFolders.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  if (row.kind === 'uploads') return c.json({ error: 'The uploads folder is managed by the app and cannot be removed.' }, 400)
  await db.delete(musicLocalTracks).where(eq(musicLocalTracks.folderId, id))  // explicit (FK cascade is belt-and-suspenders)
  await db.delete(musicLocalFolders).where(eq(musicLocalFolders.id, id))
  logger.info(`[music-sources] removed library folder ${row.path}`)
  return c.json({ ok: true })
})
