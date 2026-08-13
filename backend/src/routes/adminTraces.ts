// Turn-trace inspector (devtools): the exact assembled system prompt, routing
// decision, tool trail, and token/latency numbers behind recent assistant replies.
// Admin-only - traces contain the full prompt, including memory and briefing
// content. The store is capped at the newest 500 rows (pruned on write, chat.ts).

import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { messageTraces, messages } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const adminTraces = new Hono<AppEnv>()

// Recent traces, newest first - list view (no prompt body; it can be ~8KB each).
adminTraces.get('/', requireAdmin, async (c) => {
  const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') ?? '50', 10) || 50), 200)
  const rows = await db
    .select({
      id: messageTraces.id,
      messageId: messageTraces.messageId,
      conversationId: messageTraces.conversationId,
      userId: messageTraces.userId,
      route: messageTraces.route,
      toolTrail: messageTraces.toolTrail,
      model: messageTraces.model,
      promptTokens: messageTraces.promptTokens,
      genTokens: messageTraces.genTokens,
      durationMs: messageTraces.durationMs,
      firstTokenMs: messageTraces.firstTokenMs,
      createdAt: messageTraces.createdAt,
    })
    .from(messageTraces)
    .orderBy(desc(messageTraces.createdAt))
    .limit(limit)
  return c.json(rows.map((r) => ({
    ...r,
    route: safeParse(r.route),
    toolTrail: safeParse(r.toolTrail),
  })))
})

// One trace with the full assembled prompt + the reply text and any feedback.
adminTraces.get('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(messageTraces).where(eq(messageTraces.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const [msg] = await db
    .select({ content: messages.content, feedback: messages.feedback, feedbackNote: messages.feedbackNote, truncated: messages.truncated })
    .from(messages)
    .where(eq(messages.id, row.messageId))
    .limit(1)
  return c.json({
    ...row,
    route: safeParse(row.route),
    toolTrail: safeParse(row.toolTrail),
    reply: msg ?? null,
  })
})

function safeParse(s: string | null): unknown {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

export { adminTraces }
