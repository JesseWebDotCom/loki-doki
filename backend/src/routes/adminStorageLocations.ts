import { Hono } from 'hono'
import { isAbsolute } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { storageLocations, plexPathMappings, contentTypeStorage, blobs } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import { checkDirectoryAccess, crossPlatformPathHint, type AccessCheckResult } from '@/lib/storage/accessCheck'

// The gate MUST be node:path's own host-native isAbsolute() — a permissive cross-platform
// shape check let a Windows UNC path through on a POSIX host once, and the real fs check
// that was supposed to catch it didn't: POSIX silently treats a backslash-UNC string as one
// bizarre RELATIVE filename and happily creates it in the app's own working directory
// instead of erroring. crossPlatformPathHint() exists only to make the resulting rejection
// message specific ("this looks like a Windows path...") instead of a generic one.
function notAbsoluteResult(candidatePath: string): AccessCheckResult {
  return {
    ok: false,
    checks: { read: false, write: false, rename: false, delete: false },
    error: crossPlatformPathHint(candidatePath) ?? 'Path must be an absolute filesystem path for the OS this backend runs on.',
    freeBytes: null,
    freeFormatted: null,
  }
}

const app = new Hono()
app.use('*', requireAdmin)

// ── GET / — list storage locations, each with its Plex path mapping (if any) ──────

app.get('/', async (c) => {
  const locations = await db.select().from(storageLocations)
  const mappings = await db.select().from(plexPathMappings)
  const mappingByLocation = new Map(mappings.map(m => [m.storageLocationId, m]))
  return c.json({
    locations: locations.map(loc => ({
      ...loc,
      plexPath: mappingByLocation.get(loc.id)?.plexPath ?? null,
    })),
  })
})

// ── POST /validate — test a candidate path before saving it as a location ─────────

app.post('/validate', async (c) => {
  const { path: candidatePath } = await c.req.json<{ path: string }>()
  // Always return the full AccessCheckResult shape, even on this early rejection — the
  // frontend renders `checks.read`/etc. unconditionally, and a differently-shaped `{ok,
  // error}` response here previously crashed the whole tab instead of showing the message.
  if (!candidatePath || !isAbsolute(candidatePath)) {
    return c.json(notAbsoluteResult(candidatePath ?? ''), 400)
  }
  const result = await checkDirectoryAccess(candidatePath)
  return c.json(result)
})

// ── POST / — create a storage location ─────────────────────────────────────────

app.post('/', async (c) => {
  const { name, path } = await c.req.json<{ name: string; path: string }>()
  if (!name?.trim() || !path?.trim() || !isAbsolute(path)) {
    return c.json({ ok: false, error: crossPlatformPathHint(path ?? '') ?? 'A name and an absolute path (for the OS this backend runs on) are required.' }, 400)
  }
  const now = new Date()
  const row = { id: crypto.randomUUID(), name: name.trim(), path: path.trim(), createdAt: now, updatedAt: now }
  await db.insert(storageLocations).values(row)
  return c.json({ ok: true, location: row })
})

// Shared by DELETE and the PUT path-change guard below — a location can't be removed or
// have its `path` changed while real files still physically live there under it, or the
// app would start looking for those bytes at the wrong place the moment the row disappears
// (blobAbsPath/gcSweep resolve a blob's root via blobs.storageLocationId — a dangling or
// stale id silently falls back to the default data root instead of throwing, which reads as
// "file missing" rather than a clear error). Renaming (the `name` field) is always safe.
async function blockingReason(id: string): Promise<string | null> {
  const inUse = await db.select().from(contentTypeStorage).where(eq(contentTypeStorage.storageLocationId, id))
  if (inUse.length > 0) return `In use by: ${inUse.map(r => r.contentType).join(', ')}. Reassign that content type's storage first.`
  const [referenced] = await db.select({ hash: blobs.hash }).from(blobs).where(eq(blobs.storageLocationId, id)).limit(1)
  if (referenced) return 'Files are still stored here. Move or delete that content first.'
  return null
}

// ── DELETE /:id — remove a storage location (and its Plex mapping, if any) ────────

app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const reason = await blockingReason(id)
  if (reason) return c.json({ ok: false, error: reason }, 400)
  await db.delete(plexPathMappings).where(eq(plexPathMappings.storageLocationId, id))
  await db.delete(storageLocations).where(eq(storageLocations.id, id))
  return c.json({ ok: true })
})

// ── PUT /:id — rename, or change the path (only when nothing references it yet) ───

app.put('/:id', async (c) => {
  const id = c.req.param('id')
  const { name, path } = await c.req.json<{ name?: string; path?: string }>()
  const [location] = await db.select().from(storageLocations).where(eq(storageLocations.id, id))
  if (!location) return c.json({ ok: false, error: 'Storage location not found.' }, 404)

  const patch: Partial<typeof storageLocations.$inferInsert> = { updatedAt: new Date() }
  if (name?.trim()) patch.name = name.trim()
  if (path?.trim() && path.trim() !== location.path) {
    if (!isAbsolute(path)) return c.json({ ok: false, error: crossPlatformPathHint(path) ?? 'Path must be an absolute filesystem path for the OS this backend runs on.' }, 400)
    const reason = await blockingReason(id)
    if (reason) return c.json({ ok: false, error: `Can't change the path: ${reason}` }, 400)
    patch.path = path.trim()
  }
  await db.update(storageLocations).set(patch).where(eq(storageLocations.id, id))
  return c.json({ ok: true })
})

// ── PUT /:id/plex-mapping — set/update how Plex sees this location's bytes ────────

// Content types that currently consume a Plex path mapping — used only to auto-assign
// below, so setting a mapping is the ONE action that both configures AND "turns on" export
// for the common case (one location, one Plex-integrated content type) instead of requiring
// a second, separate assignment step. Extend this list as Podcasts/Music/Audiobooks land.
const AUTO_ASSIGNABLE_CONTENT_TYPES = ['youtube']

app.put('/:id/plex-mapping', async (c) => {
  const id = c.req.param('id')
  const { plexPath } = await c.req.json<{ plexPath: string }>()
  if (!plexPath?.trim()) return c.json({ ok: false, error: 'Plex path is required.' }, 400)

  const [location] = await db.select().from(storageLocations).where(eq(storageLocations.id, id))
  if (!location) return c.json({ ok: false, error: 'Storage location not found.' }, 404)

  const now = new Date()
  const [existing] = await db.select().from(plexPathMappings).where(eq(plexPathMappings.storageLocationId, id))
  if (existing) {
    await db.update(plexPathMappings).set({ plexPath: plexPath.trim(), updatedAt: now }).where(eq(plexPathMappings.id, existing.id))
  } else {
    await db.insert(plexPathMappings).values({
      id: crypto.randomUUID(), storageLocationId: id, plexPath: plexPath.trim(), createdAt: now, updatedAt: now,
    })
  }

  // Auto-assign any not-yet-assigned Plex content type to this location — a user who just
  // went to the trouble of mapping a location for Plex clearly means it for that purpose;
  // don't also make them find and use a separate assignment dropdown for the common case.
  // Never overrides an EXISTING explicit assignment (someone already pointed it elsewhere).
  for (const contentType of AUTO_ASSIGNABLE_CONTENT_TYPES) {
    const [assignment] = await db.select().from(contentTypeStorage).where(eq(contentTypeStorage.contentType, contentType))
    if (!assignment?.storageLocationId) {
      if (assignment) await db.update(contentTypeStorage).set({ storageLocationId: id, updatedAt: now }).where(eq(contentTypeStorage.contentType, contentType))
      else await db.insert(contentTypeStorage).values({ contentType, storageLocationId: id, updatedAt: now })
    }
  }
  return c.json({ ok: true })
})

app.delete('/:id/plex-mapping', async (c) => {
  const id = c.req.param('id')
  await db.delete(plexPathMappings).where(eq(plexPathMappings.storageLocationId, id))
  return c.json({ ok: true })
})

// ── Content-type → storage location assignment ────────────────────────────────

app.get('/content-types', async (c) => {
  const rows = await db.select().from(contentTypeStorage)
  return c.json({ assignments: rows })
})

app.put('/content-types/:contentType', async (c) => {
  const contentType = c.req.param('contentType')
  const { storageLocationId } = await c.req.json<{ storageLocationId: string | null }>()
  const now = new Date()

  if (storageLocationId) {
    const [location] = await db.select().from(storageLocations).where(eq(storageLocations.id, storageLocationId))
    if (!location) return c.json({ ok: false, error: 'Storage location not found.' }, 404)
  }

  const [existing] = await db.select().from(contentTypeStorage).where(eq(contentTypeStorage.contentType, contentType))
  if (existing) {
    await db.update(contentTypeStorage).set({ storageLocationId, updatedAt: now }).where(eq(contentTypeStorage.contentType, contentType))
  } else {
    await db.insert(contentTypeStorage).values({ contentType, storageLocationId, updatedAt: now })
  }
  return c.json({ ok: true })
})

export default app
