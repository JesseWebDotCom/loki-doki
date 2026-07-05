import { Hono } from 'hono'
import { isAbsolute } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { storageLocations, plexPathMappings, contentTypeStorage } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import { checkDirectoryAccess } from '@/lib/storage/accessCheck'

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
  if (!candidatePath || !isAbsolute(candidatePath)) {
    return c.json({ ok: false, error: 'Path must be an absolute filesystem path.' }, 400)
  }
  const result = await checkDirectoryAccess(candidatePath)
  return c.json(result)
})

// ── POST / — create a storage location ─────────────────────────────────────────

app.post('/', async (c) => {
  const { name, path } = await c.req.json<{ name: string; path: string }>()
  if (!name?.trim() || !path?.trim() || !isAbsolute(path)) {
    return c.json({ ok: false, error: 'A name and an absolute path are required.' }, 400)
  }
  const now = new Date()
  const row = { id: crypto.randomUUID(), name: name.trim(), path: path.trim(), createdAt: now, updatedAt: now }
  await db.insert(storageLocations).values(row)
  return c.json({ ok: true, location: row })
})

// ── DELETE /:id — remove a storage location (and its Plex mapping, if any) ────────

app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const inUse = await db.select().from(contentTypeStorage).where(eq(contentTypeStorage.storageLocationId, id))
  if (inUse.length > 0) {
    return c.json({
      ok: false,
      error: `In use by: ${inUse.map(r => r.contentType).join(', ')}. Reassign that content type's storage first.`,
    }, 400)
  }
  await db.delete(plexPathMappings).where(eq(plexPathMappings.storageLocationId, id))
  await db.delete(storageLocations).where(eq(storageLocations.id, id))
  return c.json({ ok: true })
})

// ── PUT /:id/plex-mapping — set/update how Plex sees this location's bytes ────────

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
