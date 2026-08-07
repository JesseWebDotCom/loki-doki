// Generic per-user CLIENT preferences — a thin keyed JSON store over
// user_preferences, namespaced `client.*`. The iPhone app's card style is
// the first tenant: chosen on one device, same everywhere (2026-08-07).
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

export const clientPrefs = new Hono<AppEnv>()
clientPrefs.use('*', requireAuth)

const KEY = /^[\w.-]{1,64}$/

clientPrefs.get('/:key', async (c) => {
  const key = c.req.param('key')
  if (!KEY.test(key)) return c.json({ error: 'bad key' }, 400)
  const user = c.get('user')
  const [row] = await db.select().from(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, `client.${key}`)))
    .limit(1)
  if (!row) return c.json({ value: null })
  try { return c.json({ value: JSON.parse(row.value) }) } catch { return c.json({ value: null }) }
})

clientPrefs.put('/:key', async (c) => {
  const key = c.req.param('key')
  if (!KEY.test(key)) return c.json({ error: 'bad key' }, 400)
  const user = c.get('user')
  const { value } = await c.req.json<{ value: unknown }>().catch(() => ({ value: null as unknown }))
  const v = JSON.stringify(value ?? null)
  if (v.length > 4096) return c.json({ error: 'too large' }, 400)
  await db.insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId: user.id, key: `client.${key}`, value: v, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.key],
      set: { value: v, updatedAt: new Date() },
    })
  return c.json({ ok: true })
})
