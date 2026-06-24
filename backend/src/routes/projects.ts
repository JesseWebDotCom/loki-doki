import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { eq, and, desc } from 'drizzle-orm'
import { join } from 'node:path'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { db } from '@/db'
import { projects, projectDocuments, documentChunks } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { dataDir } from '@/lib/download'
import { extractText, ingestDocument } from '@/lib/rag/ingest'
import { runLongForm } from '@/lib/longform/run'
import { PRESETS } from '@/lib/longform/presets'
import { logger } from '@/lib/logger'

const projectsRouter = new Hono<AppEnv>()

async function ownsProject(userId: string, id: string): Promise<boolean> {
  const [row] = await db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId))).limit(1)
  return !!row
}

projectsRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, user.id))
    .orderBy(desc(projects.createdAt))
  return c.json(rows)
})

projectsRouter.post('/', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json() as {
    name: string
    icon?: string | null
    color?: string | null
    description?: string | null
    instructions?: string | null
  }

  const name = (body.name ?? '').trim()
  if (!name) return c.json({ error: 'Name required' }, 400)

  const now = new Date()
  const id = crypto.randomUUID()
  await db.insert(projects).values({
    id,
    userId: user.id,
    name,
    icon: body.icon ?? null,
    color: body.color ?? null,
    description: body.description ?? null,
    instructions: body.instructions ?? null,
    createdAt: now,
    updatedAt: now,
  })

  const [created] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  return c.json(created, 201)
})

projectsRouter.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [existing] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json() as Partial<{
    name: string
    icon: string | null
    color: string | null
    description: string | null
    instructions: string | null
  }>

  const updates: Partial<typeof existing> & { updatedAt: Date } = { updatedAt: new Date() }
  if (body.name !== undefined) updates.name = body.name.trim() || existing.name
  if ('icon' in body) updates.icon = body.icon ?? null
  if ('color' in body) updates.color = body.color ?? null
  if ('description' in body) updates.description = body.description ?? null
  if ('instructions' in body) updates.instructions = body.instructions ?? null

  await db.update(projects).set(updates).where(eq(projects.id, id))
  const [updated] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  return c.json(updated)
})

projectsRouter.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [existing] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(projects).where(eq(projects.id, id))
  return c.json({ ok: true })
})

// ── Document attachments (RAG) ──────────────────────────────────────────────────

// List a project's documents.
projectsRouter.get('/:id/documents', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!(await ownsProject(user.id, id))) return c.json({ error: 'Not found' }, 404)
  const rows = await db
    .select({
      id: projectDocuments.id, filename: projectDocuments.filename, mime: projectDocuments.mime,
      size: projectDocuments.size, status: projectDocuments.status, chunkCount: projectDocuments.chunkCount,
      createdAt: projectDocuments.createdAt,
    })
    .from(projectDocuments)
    .where(eq(projectDocuments.projectId, id))
    .orderBy(desc(projectDocuments.createdAt))
  return c.json({ documents: rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime() })) })
})

// Upload a document — stored, then chunked + embedded in the background.
projectsRouter.post('/:id/documents', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!(await ownsProject(user.id, id))) return c.json({ error: 'Not found' }, 404)

  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File) || file.size === 0) return c.json({ error: 'file required' }, 400)

  const bytes = new Uint8Array(await file.arrayBuffer())
  const docId = crypto.randomUUID()
  const dir = join(dataDir, 'documents', id)
  await mkdir(dir, { recursive: true })
  const blobPath = join(dir, `${docId}-${file.name.replace(/[^\w.-]/g, '_')}`)
  await writeFile(blobPath, bytes)

  await db.insert(projectDocuments).values({
    id: docId, projectId: id, userId: user.id, filename: file.name,
    mime: file.type || 'application/octet-stream', size: file.size, blobPath,
    status: 'pending', chunkCount: 0, createdAt: new Date(),
  })

  // Extract + embed off the request path; the client polls status.
  void (async () => {
    try {
      const text = await extractText(file.name, file.type, bytes)
      await ingestDocument(docId, id, text)
    } catch (e) {
      logger.warn(`[rag] ingest failed for ${file.name}: ${e}`)
      await db.update(projectDocuments).set({ status: 'failed' }).where(eq(projectDocuments.id, docId))
    }
  })()

  return c.json({ id: docId, filename: file.name, status: 'pending' }, 201)
})

projectsRouter.delete('/:id/documents/:docId', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!(await ownsProject(user.id, id))) return c.json({ error: 'Not found' }, 404)
  const [doc] = await db.select().from(projectDocuments)
    .where(and(eq(projectDocuments.id, c.req.param('docId')), eq(projectDocuments.projectId, id))).limit(1)
  if (!doc) return c.json({ error: 'Not found' }, 404)
  await rm(doc.blobPath, { force: true }).catch(() => {})
  await db.delete(documentChunks).where(eq(documentChunks.documentId, doc.id))
  await db.delete(projectDocuments).where(eq(projectDocuments.id, doc.id))
  return c.json({ ok: true })
})

// ── Long-form generation (SSE) ──────────────────────────────────────────────────

projectsRouter.get('/long-form/presets', requireAuth, (c) =>
  c.json({ presets: PRESETS.map((p) => ({ id: p.id, label: p.label })) }))

projectsRouter.post('/:id/long-form', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!(await ownsProject(user.id, id))) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({})) as { request?: string; preset?: string | null }
  const userText = (body.request ?? '').trim()
  if (!userText) return c.json({ error: 'request required' }, 400)

  return streamSSE(c, async (stream) => {
    let aborted = false
    stream.onAbort(() => { aborted = true })
    await runLongForm(
      { projectId: id, userId: user.id, userText, presetId: body.preset ?? null, signal: { get aborted() { return aborted } } },
      (e) => { void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }) },
    )
  })
})

export { projectsRouter as projects }
