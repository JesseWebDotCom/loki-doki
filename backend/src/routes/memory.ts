// User-facing memory management — "What I know about you".
//
// The memory store was previously admin-only: a family member couldn't see,
// correct, pin, or delete what companions know about them, which is a trust gap
// for a privacy-first product. These routes expose ONLY the requesting user's own
// scopes (shared brain + their per-character rows) — never another user's.

import { Hono } from 'hono'
import { and, eq, or, isNull, desc } from 'drizzle-orm'
import { db } from '@/db'
import { memories } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { invalidateMemoryBlocksForUser, invalidateAllMemoryBlocks } from '@/memory/blockCache'
import type { AppEnv } from '@/types'

const memory = new Hono<AppEnv>()

// All active memories visible to the requesting user: their own rows (shared
// brain + per-character) plus HOUSEHOLD rows (userId null, characterId null),
// which every family member shares and may manage.
memory.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({
      id: memories.id,
      text: memories.text,
      sourceText: memories.sourceText,
      category: memories.category,
      tier: memories.tier,
      importance: memories.importance,
      pinned: memories.pinned,
      userId: memories.userId,
      characterId: memories.characterId,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(
      and(
        or(
          eq(memories.userId, user.id),
          and(isNull(memories.userId), isNull(memories.characterId)),
        ),
        eq(memories.status, 'active'),
      ),
    )
    .orderBy(desc(memories.pinned), desc(memories.importance), desc(memories.updatedAt))
  return c.json(rows.map(({ userId, ...r }) => ({ ...r, household: userId === null })))
})

// Rows this user may manage: their own, or household (family trust model).
function manageableWhere(userId: string) {
  return or(
    eq(memories.userId, userId),
    and(isNull(memories.userId), isNull(memories.characterId)),
  )
}

// Pin/unpin or correct the text of one of the user's own memories.
memory.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { pinned?: boolean; text?: string }

  const update: Record<string, unknown> = { updatedAt: new Date() }
  if (typeof body.pinned === 'boolean') update['pinned'] = body.pinned
  if (typeof body.text === 'string' && body.text.trim()) {
    update['text'] = body.text.trim().slice(0, 1000)
    // A corrected text needs a fresh embedding for recall — best-effort, the
    // correction itself must not fail if the embed model is down.
    try {
      const { embed } = await import('@/llm/embed')
      update['embedding'] = JSON.stringify(await embed(body.text.trim()))
    } catch { /* keep the old embedding */ }
  }
  if (Object.keys(update).length === 1) return c.json({ error: 'nothing to update' }, 400)

  const result = await db
    .update(memories)
    .set(update)
    .where(and(eq(memories.id, id), manageableWhere(user.id)))
    .returning({ id: memories.id })
  if (result.length === 0) return c.json({ error: 'not found' }, 404)

  // The row may be household-scoped (visible to everyone) — bust all blocks.
  invalidateAllMemoryBlocks()
  return c.json({ ok: true })
})

// Forget one memory (soft-delete, consistent with the judge's supersede pattern).
memory.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const result = await db
    .update(memories)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(and(eq(memories.id, id), manageableWhere(user.id), eq(memories.status, 'active')))
    .returning({ id: memories.id })
  if (result.length === 0) return c.json({ error: 'not found' }, 404)

  // The row may be household-scoped (visible to everyone) — bust all blocks.
  invalidateAllMemoryBlocks()
  return c.json({ ok: true })
})

// Forget everything in one scope: 'shared' (this user's all-companion brain),
// 'household' (the family-shared scope), or a characterId.
memory.delete('/', requireAuth, async (c) => {
  const user = c.get('user')
  const scope = c.req.query('scope') ?? 'shared'
  const scopeWhere = scope === 'household'
    ? and(isNull(memories.userId), isNull(memories.characterId))
    : scope === 'shared'
      ? and(eq(memories.userId, user.id), isNull(memories.characterId))
      : and(eq(memories.userId, user.id), eq(memories.characterId, scope))
  const result = await db
    .update(memories)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(and(eq(memories.status, 'active'), scopeWhere))
    .returning({ id: memories.id })

  invalidateAllMemoryBlocks()
  return c.json({ ok: true, forgotten: result.length })
})

export { memory }
