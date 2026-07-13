// Admin > Integrations > Books: manage custom self-hosted OPDS indexers (multiple
// allowed — see backend/src/lib/books/indexer.ts). Credential-bearing, so
// admin-gated, unlike the built-in Gutenberg/Internet Archive/LibriVox toggles
// (any household member can flip those via /api/books/sources).

import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import { listIndexers, createIndexer, updateIndexer, deleteIndexer, testIndexer } from '@/lib/books/indexer'
import { getBuiltinSourceToggles, getGoogleBooksApiKey, isIaLicenseCheckEnabled, setBuiltinSourceToggle, setGoogleBooksApiKey, setIaLicenseCheckEnabled, type BuiltinSource } from '@/lib/books/sourceToggles'
import { listBookRequests, approveBookRequest, denyBookRequest } from '@/lib/books/requests'
import type { AppEnv } from '@/types'

export const adminBooks = new Hono<AppEnv>()
adminBooks.use('*', requireAdmin)

const BUILTIN_SOURCES: BuiltinSource[] = ['gutenberg', 'archiveorg', 'librivox', 'standardebooks', 'wikisource', 'googlebooks', 'openlibrary', 'web']

adminBooks.get('/sources', async (c) => c.json({ toggles: await getBuiltinSourceToggles() }))

adminBooks.put('/sources/:source', async (c) => {
  const source = c.req.param('source') as BuiltinSource
  const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null
  if (!BUILTIN_SOURCES.includes(source) || typeof body?.enabled !== 'boolean') return c.json({ code: 'bad_request' }, 400)
  await setBuiltinSourceToggle(source, body.enabled)
  return c.json({ ok: true })
})

// Debug switch: skip the Internet Archive publicdomain-license download gate.
adminBooks.get('/ia-license-check', async (c) => c.json({ enabled: await isIaLicenseCheckEnabled() }))
adminBooks.put('/ia-license-check', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null
  if (typeof body?.enabled !== 'boolean') return c.json({ code: 'bad_request' }, 400)
  await setIaLicenseCheckEnabled(body.enabled)
  return c.json({ ok: true })
})

adminBooks.get('/google-books-key', async (c) => c.json({ configured: Boolean(await getGoogleBooksApiKey()) }))
adminBooks.put('/google-books-key', async (c) => {
  const body = await c.req.json().catch(() => null) as { apiKey?: string } | null
  if (!body?.apiKey?.trim()) return c.json({ code: 'bad_request' }, 400)
  await setGoogleBooksApiKey(body.apiKey)
  return c.json({ ok: true })
})

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

// Kid-safe acquisition requests awaiting approval (see lib/books/requests.ts).
adminBooks.get('/requests', async (c) => c.json({ requests: await listBookRequests() }))

adminBooks.post('/requests/approve', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => null)) as { userId?: string; bookId?: string } | null
  if (!body?.userId || !body?.bookId) return c.json({ code: 'bad_request' }, 400)
  return c.json(await approveBookRequest(user.id, body.userId, body.bookId))
})

adminBooks.post('/requests/deny', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { userId?: string; bookId?: string } | null
  if (!body?.userId || !body?.bookId) return c.json({ code: 'bad_request' }, 400)
  return c.json(await denyBookRequest(body.userId, body.bookId))
})
