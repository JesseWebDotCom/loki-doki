import { Hono } from 'hono'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { ollamaList, ollamaHealthCheck } from '@/llm/ollama'
import { CATALOG } from '@/lib/catalog'
import type { AppEnv } from '@/types'

// Ollama tags of every catalog model marked uncensored — hidden from non-admins.
const UNCENSORED_TAGS = new Set(
  CATALOG.filter(m => m.role === 'uncensored_llm' || m.tags?.includes('uncensored'))
    .map(m => m.ollamaTag ?? m.id),
)

const ollamaUrl = () => (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')

const models = new Hono<AppEnv>()

models.get('/status', requireAuth, async (c) => {
  const online = await ollamaHealthCheck()
  return c.json({ online })
})

models.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const list = await ollamaList()
  // A non-admin (e.g. a child) must not even see uncensored models in the picker.
  return c.json(user.role === 'admin' ? list : list.filter(m => !UNCENSORED_TAGS.has(m.name)))
})

// Uninstall an Ollama model — frees disk space
models.post('/uninstall', requireAdmin, async (c) => {
  const { tag } = await c.req.json() as { tag?: string }
  if (!tag?.trim()) return c.json({ error: 'tag required' }, 400)
  try {
    const res = await fetch(`${ollamaUrl()}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: tag }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return c.json({ error: 'Ollama delete failed' }, 502)
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'Ollama unreachable' }, 502)
  }
})

export { models }
