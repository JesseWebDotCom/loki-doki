import { Hono } from 'hono'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const projectsRouter = new Hono<AppEnv>()

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

export { projectsRouter as projects }
