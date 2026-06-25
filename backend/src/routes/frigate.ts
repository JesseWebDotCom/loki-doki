// Frigate-facing routes.
//
//   POST /api/frigate/v1/chat/completions  — OpenAI-compatible shim. Frigate's
//        GenAI provider (object descriptions + 0.17 review summaries) calls this;
//        we route the vision request to the local Ollama VLM and answer in the
//        OpenAI envelope Frigate expects. Authenticated by a bearer shim token,
//        NOT a session cookie (Frigate is an external service on the LAN).
//
//   GET  /api/frigate/announcements/pending  — browser clients poll this and speak
//   POST /api/frigate/announcements/:id/spoken
//   GET  /api/frigate/events                  — recent event history
//
// The shim only ANSWERS Frigate (and logs the description). Notifications and
// spoken announcements come from the MQTT consumer, which has the camera/label/
// plate/severity metadata the genai call lacks. See lib/frigate/mqtt.ts.

import { Hono } from 'hono'
import type { AppEnv } from '@/types'
import { requireAuth } from '@/middleware/auth'
import { getVisionModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import { logger } from '@/lib/logger'
import { getFrigateConfig } from '@/lib/frigate/config'
import { logShimDescription, pendingAnnouncements, claimAnnouncement, recentEvents } from '@/lib/frigate/events'

const frigate = new Hono<AppEnv>()

// ── OpenAI-compatible parsing ─────────────────────────────────────────────────

interface OAIContentPart {
  type: string
  text?: string
  image_url?: { url?: string }
}
interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | string
  content: string | OAIContentPart[]
}

function stripDataUrl(url: string): string | null {
  // data:image/jpeg;base64,<b64>  → <b64>   (Frigate inlines snapshots this way)
  const m = url.match(/^data:[^;,]+;base64,(.+)$/s)
  if (m) return m[1]!
  // Some clients send a bare base64 string with no data: prefix.
  if (/^[A-Za-z0-9+/=\s]+$/.test(url) && url.length > 100) return url.replace(/\s+/g, '')
  return null
}

function bearer(c: { req: { header: (k: string) => string | undefined } }): string | null {
  const h = c.req.header('authorization') ?? c.req.header('Authorization')
  if (!h) return null
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1]!.trim() : null
}

// ── Shim ──────────────────────────────────────────────────────────────────────

frigate.post('/v1/chat/completions', async (c) => {
  const cfg = await getFrigateConfig()
  // Refuse to act as an open VLM proxy: require a configured token that matches.
  if (!cfg.enabled || !cfg.shimToken) return c.json({ error: { message: 'Frigate integration not configured' } }, 503)
  if (bearer(c) !== cfg.shimToken) return c.json({ error: { message: 'Invalid API key' } }, 401)

  let body: { messages?: OAIMessage[]; response_format?: { type?: string; json_schema?: { schema?: unknown } }; temperature?: number }
  try { body = await c.req.json() } catch { return c.json({ error: { message: 'Invalid JSON' } }, 400) }
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (!messages.length) return c.json({ error: { message: 'messages required' } }, 400)

  // Flatten OpenAI multimodal messages into Ollama's shape (text + base64 images).
  const ollamaMessages = messages.map((m) => {
    if (typeof m.content === 'string') return { role: normalizeRole(m.role), content: m.content }
    const texts: string[] = []
    const images: string[] = []
    for (const part of m.content) {
      if (part.type === 'text' && part.text) texts.push(part.text)
      else if (part.type === 'image_url' && part.image_url?.url) {
        const b64 = stripDataUrl(part.image_url.url)
        if (b64) images.push(b64)
      }
    }
    return { role: normalizeRole(m.role), content: texts.join('\n'), ...(images.length && { images }) }
  })

  // Honor a requested JSON response format (review summaries use structured output).
  let format: unknown
  const rf = body.response_format
  if (rf?.type === 'json_object') format = 'json'
  else if (rf?.type === 'json_schema' && rf.json_schema?.schema) format = rf.json_schema.schema

  const model = await getVisionModel()
  try {
    const chunk = await ollamaChat(
      model,
      ollamaMessages,
      undefined,
      { temperature: typeof body.temperature === 'number' ? body.temperature : 0.2, num_ctx: 4096 },
      format,
    )
    const content = chunk.message?.content ?? ''
    void logShimDescription(content)

    return c.json({
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: chunk.prompt_eval_count ?? 0,
        completion_tokens: chunk.eval_count ?? 0,
        total_tokens: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`[frigate] shim VLM call failed: ${msg}`)
    return c.json({ error: { message: msg } }, 500)
  }
})

function normalizeRole(role: string): 'system' | 'user' | 'assistant' {
  return role === 'system' || role === 'assistant' ? role : 'user'
}

// Some OpenAI clients probe /models before use.
frigate.get('/v1/models', async (c) => {
  const cfg = await getFrigateConfig()
  if (cfg.shimToken && bearer(c) !== cfg.shimToken) return c.json({ error: { message: 'Invalid API key' } }, 401)
  const model = await getVisionModel()
  return c.json({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'loki-doki' }] })
})

// ── Browser-facing: companion announcements + history ─────────────────────────

// Cheap gate for the announce poller: "enabled" only when Frigate is actually set up
// (toggle on AND a broker/base URL configured). Lets clients skip the 6s announce poll
// entirely when Frigate is off or unconfigured.
frigate.get('/status', requireAuth, async (c) => {
  const cfg = await getFrigateConfig()
  return c.json({ enabled: cfg.enabled && (!!cfg.mqttHost || !!cfg.baseUrl) })
})

frigate.get('/announcements/pending', requireAuth, async (c) => {
  return c.json({ items: await pendingAnnouncements() })
})

frigate.post('/announcements/:id/spoken', requireAuth, async (c) => {
  const won = await claimAnnouncement(c.req.param('id'))
  return c.json({ ok: true, claimed: won })
})

frigate.get('/events', requireAuth, async (c) => {
  const limit = parseInt(c.req.query('limit') ?? '50')
  return c.json({ events: await recentEvents(Number.isFinite(limit) ? limit : 50) })
})

export { frigate }
