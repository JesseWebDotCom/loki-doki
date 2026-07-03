// Admin-only Books utilities. Indexer CONFIG itself is read/written through the
// existing generic /api/tools/config/global (toolId: 'bookIndexer') — this route
// only adds a connection test, which needs server-side logic (an actual OPDS
// fetch) that the generic config endpoint can't provide.

import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import { getIndexerConfig, searchIndexer } from '@/lib/books/indexer'
import type { AppEnv } from '@/types'

export const adminBooks = new Hono<AppEnv>()
adminBooks.use('*', requireAdmin)

adminBooks.post('/indexer/test', async (c) => {
  const cfg = await getIndexerConfig()
  if (!cfg) return c.json({ ok: false, error: 'Indexer is not configured or not enabled — save settings first' })
  try {
    const results = await searchIndexer('a')
    return c.json({ ok: true, resultCount: results.length })
  } catch (err) {
    return c.json({ ok: false, error: String(err) })
  }
})
