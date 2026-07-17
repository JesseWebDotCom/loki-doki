// Routines API: per-user CRUD (each user owns their routines; admins see all),
// manual test fires, run history, and the public token-authenticated webhook
// trigger (same pattern as routes/monitoring.ts).

import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { routineRuns, routines } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { fireRoutine, fireWebhook, parseActions, parseTrigger } from '@/lib/routines/engine'
import { describeAction, describeTrigger, validateActions, validateTrigger } from '@/lib/routines/types'

const app = new Hono<AppEnv>()

// ── Public webhook trigger (no session; token in query or header) ──────────────
app.post('/hook/:id', async (c) => {
  const token = c.req.query('token') ?? c.req.header('x-routine-token') ?? ''
  const ok = await fireWebhook(c.req.param('id'), token)
  // 404 for both unknown id and bad token: don't confirm which routines exist.
  return ok ? c.json({ ok: true }) : c.json({ ok: false }, 404)
})

app.use('*', requireAuth)

function serialize(row: typeof routines.$inferSelect) {
  const trigger = parseTrigger(row)
  const actions = parseActions(row)
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    enabled: row.enabled,
    trigger,
    actions,
    triggerSummary: trigger ? describeTrigger(trigger) : 'Invalid trigger',
    actionSummaries: actions.map(describeAction),
    createdVia: row.createdVia,
    lastRunAt: row.lastRunAt,
    lastResult: row.lastResult,
    createdAt: row.createdAt,
  }
}

async function ownedRoutine(user: { id: string; role: string }, id: string) {
  const [row] = await db.select().from(routines).where(eq(routines.id, id)).limit(1)
  if (!row) return null
  if (row.userId !== user.id && user.role !== 'admin') return null
  return row
}

app.get('/', async (c) => {
  const user = c.get('user')
  const rows = user.role === 'admin'
    ? await db.select().from(routines).orderBy(desc(routines.createdAt))
    : await db.select().from(routines).where(eq(routines.userId, user.id)).orderBy(desc(routines.createdAt))
  return c.json({ routines: rows.map(serialize) })
})

app.post('/', async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null) as { name?: string; trigger?: unknown; actions?: unknown; enabled?: boolean } | null
  if (!body || typeof body.name !== 'string' || !body.name.trim()) return c.json({ ok: false, error: 'A name is required.' }, 400)
  const trigger = validateTrigger(body.trigger)
  if (!trigger.ok) return c.json({ ok: false, error: trigger.error }, 400)
  const actions = validateActions(body.actions)
  if (!actions.ok) return c.json({ ok: false, error: actions.error }, 400)

  const count = await db.select({ id: routines.id }).from(routines).where(eq(routines.userId, user.id))
  if (count.length >= 50) return c.json({ ok: false, error: 'Routine limit reached (50).' }, 400)

  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    userId: user.id,
    name: body.name.trim().slice(0, 120),
    enabled: body.enabled !== false,
    trigger: JSON.stringify(trigger.trigger),
    actions: JSON.stringify(actions.actions),
    createdVia: 'app',
    lastRunAt: null,
    lastResult: null,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(routines).values(row)
  return c.json({ ok: true, routine: serialize(row as typeof routines.$inferSelect) })
})

app.put('/:id', async (c) => {
  const row = await ownedRoutine(c.get('user'), c.req.param('id'))
  if (!row) return c.json({ ok: false, error: 'Routine not found.' }, 404)
  const body = await c.req.json().catch(() => null) as { name?: string; trigger?: unknown; actions?: unknown; enabled?: boolean } | null
  if (!body) return c.json({ ok: false, error: 'Invalid request body.' }, 400)

  const patch: Partial<typeof routines.$inferInsert> = { updatedAt: new Date() }
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 120)
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (body.trigger !== undefined) {
    // Preserve a webhook trigger's server-generated token across UI round-trips.
    const incoming = body.trigger as Record<string, unknown>
    const existing = parseTrigger(row)
    if (incoming?.type === 'webhook' && existing?.type === 'webhook' && !incoming.token) incoming.token = existing.token
    const trigger = validateTrigger(incoming)
    if (!trigger.ok) return c.json({ ok: false, error: trigger.error }, 400)
    patch.trigger = JSON.stringify(trigger.trigger)
  }
  if (body.actions !== undefined) {
    const actions = validateActions(body.actions)
    if (!actions.ok) return c.json({ ok: false, error: actions.error }, 400)
    patch.actions = JSON.stringify(actions.actions)
  }
  await db.update(routines).set(patch).where(eq(routines.id, row.id))
  const [updated] = await db.select().from(routines).where(eq(routines.id, row.id)).limit(1)
  return c.json({ ok: true, routine: serialize(updated!) })
})

app.delete('/:id', async (c) => {
  const row = await ownedRoutine(c.get('user'), c.req.param('id'))
  if (!row) return c.json({ ok: false, error: 'Routine not found.' }, 404)
  await db.delete(routines).where(eq(routines.id, row.id))
  return c.json({ ok: true })
})

app.post('/:id/run', async (c) => {
  const row = await ownedRoutine(c.get('user'), c.req.param('id'))
  if (!row) return c.json({ ok: false, error: 'Routine not found.' }, 404)
  void fireRoutine(row, 'manual')
  return c.json({ ok: true })
})

app.get('/:id/runs', async (c) => {
  const row = await ownedRoutine(c.get('user'), c.req.param('id'))
  if (!row) return c.json({ ok: false, error: 'Routine not found.' }, 404)
  const runs = await db.select().from(routineRuns)
    .where(and(eq(routineRuns.routineId, row.id)))
    .orderBy(desc(routineRuns.startedAt))
    .limit(20)
  return c.json({ runs })
})

export default app
