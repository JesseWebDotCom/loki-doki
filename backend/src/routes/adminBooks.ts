// Admin > Integrations > Books: manage custom self-hosted OPDS indexers (multiple
// allowed — see backend/src/lib/books/indexer.ts). Credential-bearing, so
// admin-gated, unlike the built-in Gutenberg/Internet Archive/LibriVox toggles
// (any household member can flip those via /api/books/sources).

import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import { listIndexers, createIndexer, updateIndexer, deleteIndexer, testIndexer } from '@/lib/books/indexer'
import type { AppEnv } from '@/types'

export const adminBooks = new Hono<AppEnv>()
adminBooks.use('*', requireAdmin)

adminBooks.get('/indexers', async (c) => c.json({ indexers: await listIndexers() }))

adminBooks.post('/indexers', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { label?: string; baseUrl?: string; username?: string; password?: string; enabled?: boolean } | null
  const label = body?.label?.trim()
  const baseUrl = body?.baseUrl?.trim()
  if (!label || !baseUrl) return c.json({ code: 'bad_request' }, 400)
  const indexer = await createIndexer({ label, baseUrl, username: body?.username, password: body?.password, enabled: body?.enabled })
  return c.json({ indexer })
})

adminBooks.put('/indexers/:id', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { label?: string; baseUrl?: string; username?: string | null; password?: string; enabled?: boolean } | null
  if (!body) return c.json({ code: 'bad_request' }, 400)
  await updateIndexer(c.req.param('id'), body)
  return c.json({ ok: true })
})

adminBooks.delete('/indexers/:id', async (c) => {
  await deleteIndexer(c.req.param('id'))
  return c.json({ ok: true })
})

adminBooks.post('/indexers/:id/test', async (c) => c.json(await testIndexer(c.req.param('id'))))
