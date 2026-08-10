// Admin -> Server -> Addresses. CRUD over the typed-in half of the hub address book,
// plus the detected half read-only so the admin can see the whole ordered list the way
// a client will receive it.

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { hubEndpoints } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import {
  guessEndpointKind,
  listHubEndpoints,
  nextEndpointPriority,
  normalizeEndpointUrl,
  reorderEndpoints,
  type EndpointKind,
} from '@/lib/hubEndpoints'
import { getHubInstanceId, getHubName, setHubName } from '@/lib/hubIdentity'
import type { AppEnv } from '@/types'

const app = new Hono<AppEnv>()
app.use('*', requireAdmin)

const KINDS = new Set<EndpointKind>(['lan', 'overlay', 'public'])

app.get('/', async (c) => c.json({
  instanceId: await getHubInstanceId(),
  name: await getHubName(),
  servedFrom: new URL(c.req.url).origin,
  // Disabled rows included: this is the editor, not the client feed.
  endpoints: await listHubEndpoints({ includeDisabled: true }),
}))

app.put('/name', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({}))
  if (!body.name?.trim()) return c.json({ error: 'Name is required' }, 400)
  await setHubName(body.name)
  return c.json({ name: await getHubName() })
})

app.post('/', async (c) => {
  const body = await c.req.json<{ name?: string; url?: string; kind?: string }>().catch(() => ({}))
  const url = normalizeEndpointUrl(body.url ?? '')
  if (!url) return c.json({ error: 'Enter an address like 192.168.1.50:3000 or hub.example.com' }, 400)
  const name = body.name?.trim().slice(0, 60)
  if (!name) return c.json({ error: 'Give the address a name' }, 400)

  const [existing] = await db.select().from(hubEndpoints).where(eq(hubEndpoints.url, url)).limit(1)
  if (existing) return c.json({ error: `That address is already saved as "${existing.name}"` }, 409)

  const now = new Date()
  await db.insert(hubEndpoints).values({
    id: crypto.randomUUID(),
    name,
    url,
    kind: KINDS.has(body.kind as EndpointKind) ? (body.kind as EndpointKind) : guessEndpointKind(url),
    priority: await nextEndpointPriority(),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  })
  return c.json({ endpoints: await listHubEndpoints({ includeDisabled: true }) })
})

app.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; url?: string; kind?: string; enabled?: boolean }>().catch(() => ({}))
  const patch: Partial<typeof hubEndpoints.$inferInsert> = { updatedAt: new Date() }

  if (body.name !== undefined) {
    const name = body.name.trim().slice(0, 60)
    if (!name) return c.json({ error: 'Give the address a name' }, 400)
    patch.name = name
  }
  if (body.url !== undefined) {
    const url = normalizeEndpointUrl(body.url)
    if (!url) return c.json({ error: 'That does not look like an address' }, 400)
    const [clash] = await db.select().from(hubEndpoints).where(eq(hubEndpoints.url, url)).limit(1)
    if (clash && clash.id !== id) return c.json({ error: `That address is already saved as "${clash.name}"` }, 409)
    patch.url = url
  }
  if (body.kind !== undefined && KINDS.has(body.kind as EndpointKind)) patch.kind = body.kind as EndpointKind
  if (body.enabled !== undefined) patch.enabled = body.enabled

  await db.update(hubEndpoints).set(patch).where(eq(hubEndpoints.id, id))
  return c.json({ endpoints: await listHubEndpoints({ includeDisabled: true }) })
})

app.delete('/:id', async (c) => {
  await db.delete(hubEndpoints).where(eq(hubEndpoints.id, c.req.param('id')))
  return c.json({ endpoints: await listHubEndpoints({ includeDisabled: true }) })
})

/** Drag-to-reorder. Detected rows carry synthetic ids and are simply skipped, so an
 *  admin who wants one ahead of a typed row adds it as a real row instead. */
app.put('/order', async (c) => {
  const body = await c.req.json<{ ids?: string[] }>().catch(() => ({}))
  if (!Array.isArray(body.ids)) return c.json({ error: 'Missing ids' }, 400)
  await reorderEndpoints(body.ids.filter((id) => !id.startsWith('detected:')))
  return c.json({ endpoints: await listHubEndpoints({ includeDisabled: true }) })
})

export default app
