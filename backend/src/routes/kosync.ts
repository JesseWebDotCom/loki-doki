// KOReader progress-sync server (KOSync protocol). Point KOReader's "Cloud sync"
// custom server at http://<host>:<port>/api/kosync and it syncs reading position
// across devices. This is the same wire protocol as koreader/koreader-sync-server:
// standalone reader accounts (username + client-hashed md5 key), progress keyed by
// KOReader's own partial-md5 document hash. It does NOT use the app session cookie —
// KOReader authenticates with x-auth-user / x-auth-key headers on every call.
//
// Optionally, a reader account whose username matches an app user's nickname is
// linked to that user at creation, so their KOReader reading can surface in-app later.

import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { bookSyncUsers, bookSyncProgress, users } from '@/db/schema'
import type { AppEnv } from '@/types'

export const kosync = new Hono<AppEnv>()

async function authed(c: { req: { header(n: string): string | undefined } }): Promise<string | null> {
  const username = c.req.header('x-auth-user')
  const key = c.req.header('x-auth-key')
  if (!username || !key) return null
  const [row] = await db.select({ keyHash: bookSyncUsers.keyHash }).from(bookSyncUsers)
    .where(eq(bookSyncUsers.username, username)).limit(1)
  return row && row.keyHash === key ? username : null
}

// Register a new reader account. KOReader sends the password already md5-hashed, so
// we store it verbatim as the key. 201 on success, 402 if the name is taken (the
// code KOReader expects for "already registered").
kosync.post('/users/create', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { username?: string; password?: string } | null
  const username = body?.username?.trim()
  const password = body?.password?.trim()
  if (!username || !password) return c.json({ message: 'Invalid request' }, 400)
  const [existing] = await db.select({ username: bookSyncUsers.username }).from(bookSyncUsers)
    .where(eq(bookSyncUsers.username, username)).limit(1)
  if (existing) return c.json({ message: 'Username is already registered.' }, 402)
  // Best-effort link to an app user with the same nickname (case-insensitive) so the
  // reader account can surface in-app later. Household user counts are tiny.
  const appUsers = await db.select({ id: users.id, nickname: users.nickname }).from(users)
  const linked = appUsers.find((u) => u.nickname?.toLowerCase() === username.toLowerCase())?.id ?? null
  await db.insert(bookSyncUsers).values({ username, keyHash: password, userId: linked, createdAt: new Date() })
  return c.json({ username }, 201)
})

kosync.get('/users/auth', async (c) => {
  const username = await authed(c)
  if (!username) return c.json({ message: 'Unauthorized' }, 401)
  return c.json({ authorized: 'OK' })
})

// Upsert the position for a document. KOReader sends {document, progress, percentage,
// device, device_id}. Returns {document, timestamp}.
kosync.put('/syncs/progress', async (c) => {
  const username = await authed(c)
  if (!username) return c.json({ message: 'Unauthorized' }, 401)
  const body = (await c.req.json().catch(() => null)) as {
    document?: string; progress?: string; percentage?: number; device?: string; device_id?: string
  } | null
  if (!body?.document || body.progress === undefined) return c.json({ message: 'Invalid request' }, 400)
  const now = new Date()
  await db.insert(bookSyncProgress).values({
    username, document: body.document, progress: String(body.progress),
    percentage: typeof body.percentage === 'number' ? body.percentage : 0,
    device: body.device ?? null, deviceId: body.device_id ?? null, updatedAt: now,
  }).onConflictDoUpdate({
    target: [bookSyncProgress.username, bookSyncProgress.document],
    set: {
      progress: String(body.progress),
      percentage: typeof body.percentage === 'number' ? body.percentage : 0,
      device: body.device ?? null, deviceId: body.device_id ?? null, updatedAt: now,
    },
  })
  return c.json({ document: body.document, timestamp: Math.floor(now.getTime() / 1000) })
})

kosync.get('/syncs/progress/:document', async (c) => {
  const username = await authed(c)
  if (!username) return c.json({ message: 'Unauthorized' }, 401)
  const [row] = await db.select().from(bookSyncProgress)
    .where(and(eq(bookSyncProgress.username, username), eq(bookSyncProgress.document, c.req.param('document')))).limit(1)
  if (!row) return c.json({})
  return c.json({
    document: row.document, progress: row.progress, percentage: row.percentage,
    device: row.device, device_id: row.deviceId, timestamp: Math.floor(row.updatedAt.getTime() / 1000),
  })
})
