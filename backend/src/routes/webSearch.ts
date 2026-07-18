import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAuth } from '@/middleware/auth'
import { webSearch } from '@/lib/webSearch'
import { searxngImageSearch } from '@/lib/searxng'
import { searchTierFor, type MediaTier } from '@/lib/media/policyTier'
import { filterRelevant } from '@/lib/searchAnswer'
import { getFastModel } from '@/lib/models'
import { ollamaChatStream } from '@/llm/ollama'
import type { AppEnv } from '@/types'

// Direct (non-LLM) web search for the standalone search page + Spotlight preview.
// Mounted at /api/search/web — distinct from /api/search (local-content search).

const webSearchRouter = new Hono<AppEnv>()

const RESULT_LIMIT = 10
const IMAGE_LIMIT = 12
const ANSWER_RESULT_LIMIT = 6
const ANSWER_SOURCE_LIMIT = 5

/** Same age tiers that gate videos/podcasts, mapped onto SearXNG/DuckDuckGo's
 *  safesearch levels (0=off, 1=moderate, 2=strict). */
function safesearchFor(tier: MediaTier): 0 | 1 | 2 {
  if (tier === 'kid') return 2
  if (tier === 'teen') return 1
  return 0
}

webSearchRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const q = c.req.query('q')?.trim() ?? ''
  if (!q) return c.json({ web: [], images: [] })

  const tier = await searchTierFor(user.id)
  const safesearch = safesearchFor(tier)

  const [web, images] = await Promise.all([
    webSearch(q, RESULT_LIMIT, 6000, safesearch),
    // Images stay at least moderate even for open-tier profiles — SearXNG's image
    // categories have no equivalent to the web engines' upstream policy gating.
    searxngImageSearch(q, IMAGE_LIMIT, 7000, safesearch === 0 ? 1 : safesearch),
  ])

  const relevant = filterRelevant(q, web)

  return c.json({ web: relevant, images, tier })
})

// GET /api/search/web/answer — an LLM-synthesized "AI Overview" over the top web
// results, streamed token-by-token. Same shape as musicInfo.ts's POST /ask: a
// `sources` event up front, then `token` events, then `done` (or `error`). A
// down/slow Ollama or a source-free query just means no overview: the plain result
// list on /api/search/web is unaffected and never waits on this endpoint.
webSearchRouter.get('/answer', requireAuth, async (c) => {
  const user = c.get('user')
  const q = c.req.query('q')?.trim() ?? ''
  if (!q) return c.json({ error: 'q required' }, 400)

  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    try {
      const tier = await searchTierFor(user.id)
      const safesearch = safesearchFor(tier)
      const web = await webSearch(q, ANSWER_RESULT_LIMIT, 6000, safesearch)
      const relevant = filterRelevant(q, web).slice(0, ANSWER_SOURCE_LIMIT)

      const sources = relevant.map((r) => ({ title: r.title, url: r.url }))
      await stream.writeSSE({ data: JSON.stringify({ sources }) })

      if (relevant.length === 0) {
        await stream.writeSSE({ data: JSON.stringify({ done: true, noAnswer: true }) })
        return
      }

      const corpus = relevant.map((r, i) => `[${i + 1}] ${r.title}: ${r.snippet}`).join('\n\n').slice(0, 6000)
      const system =
        'You write a brief AI overview answering a web search query, for a family home hub search page (similar to ' +
        'a search engine\'s AI summary). Using ONLY the numbered snippets below, answer the query directly in 2-4 ' +
        'sentences of plain prose (no heading, no bullet list unless genuinely clearer as one). Cite claims inline ' +
        'as [1], [2], etc. matching the snippet numbers. If the snippets do not answer the query, say so briefly ' +
        'instead of guessing. Do not use em dashes.'

      const model = await getFastModel()
      const chunks = ollamaChatStream(model, [
        { role: 'system', content: system },
        { role: 'user', content: `Query: "${q}"\n\nSnippets:\n${corpus}` },
      ], { temperature: 0.3, num_predict: 350 })
      for await (const chunk of chunks) {
        if (chunk.message?.content) await stream.writeSSE({ data: JSON.stringify({ token: chunk.message.content }) })
      }
      await stream.writeSSE({ data: JSON.stringify({ done: true }) })
    } catch (err) {
      await stream.writeSSE({ data: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }) })
    }
  })
})

export { webSearchRouter }
