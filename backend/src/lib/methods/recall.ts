// Learned methods: reusable, multi-step procedures the companion saves ("here's how
// we do movie night", "the steps to reset the router") and later RAG-recalls when a
// similar request comes in, injecting the steps into the prompt so the model follows a
// known-good procedure instead of improvising.
//
// Storage + recall mirror the notes/memory pattern exactly: one nomic embedding per
// method (over its name + description), an in-process cosine scan against the user's own
// + household methods, and a capped prompt block. The block rides the SAME memory-block
// cache entry, so a save invalidates recall for the next turn via invalidateMethodBlocks.

import { eq, isNull, or } from 'drizzle-orm'
import { db } from '@/db'
import { methods } from '@/db/schema'
import { embed, cosineSimilarity, cachedVector } from '@/llm/embed'
import { invalidateMemoryBlocksForUser, invalidateAllMemoryBlocks } from '@/memory/blockCache'
import { logger } from '@/lib/logger'

type MethodRow = typeof methods.$inferSelect

// Explicit user-authored procedures should surface confidently but stay quiet on
// unrelated chatter. Between the notes (0.50) and memory-vector (0.55) thresholds.
const METHOD_MIN_COSINE = 0.52
const MAX_METHODS = 2
const STEPS_CHARS = 700
const BLOCK_CHAR_BUDGET = 1400

function recallSurface(name: string, description: string): string {
  return description.trim() ? `${name}. ${description}` : name
}

// ── CRUD ────────────────────────────────────────────────────────────────────────

export interface NewMethod {
  userId: string | null // null = household-wide
  name: string
  description?: string
  steps: string
  createdVia?: string
}

export async function createMethod(m: NewMethod): Promise<MethodRow> {
  const now = new Date()
  const description = (m.description ?? '').trim()
  let embedding: string | null = null
  try {
    embedding = JSON.stringify(await embed(recallSurface(m.name, description)))
  } catch (e) {
    logger.warn(`[methods] could not embed "${m.name}": ${e instanceof Error ? e.message : e}`)
  }
  const row = {
    id: crypto.randomUUID(),
    userId: m.userId,
    name: m.name.trim().slice(0, 120),
    description,
    steps: m.steps.trim(),
    embedding,
    createdVia: m.createdVia ?? 'companion',
    uses: 0,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(methods).values(row)
  invalidateMethodBlocks(m.userId)
  return row as MethodRow
}

/** A user's own methods plus household-wide ones. */
export async function listMethods(userId: string): Promise<MethodRow[]> {
  return db.select().from(methods).where(or(eq(methods.userId, userId), isNull(methods.userId)))
}

/** Delete a method. A user may delete their own; household methods need admin. */
export async function deleteMethod(id: string, userId: string, isAdmin: boolean): Promise<boolean> {
  const [row] = await db.select().from(methods).where(eq(methods.id, id)).limit(1)
  if (!row) return false
  if (row.userId !== userId && !(row.userId === null && isAdmin)) return false
  await db.delete(methods).where(eq(methods.id, id))
  invalidateMethodBlocks(row.userId)
  return true
}

export async function countMethods(userId: string): Promise<number> {
  return (await db.select({ id: methods.id }).from(methods).where(eq(methods.userId, userId))).length
}

// ── Recall ──────────────────────────────────────────────────────────────────────

/** Formatted methods block for the system prompt, or null when nothing relevant. */
export async function recallMethodBlock(
  message: string,
  userId: string,
  promptEmbedding?: number[] | null,
): Promise<string | null> {
  const rows = await listMethods(userId)
  if (!rows.length) return null

  const queryVec = promptEmbedding ?? (await embed(message).catch(() => null))
  if (!queryVec) return null

  const scored: { row: MethodRow; score: number }[] = []
  for (const row of rows) {
    if (!row.embedding) continue
    const vec = cachedVector(`method:${row.id}:${row.updatedAt?.getTime() ?? 0}`, row.embedding)
    if (!vec) continue
    const score = cosineSimilarity(queryVec, vec)
    if (score >= METHOD_MIN_COSINE) scored.push({ row, score })
  }
  if (!scored.length) return null
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, MAX_METHODS)

  const lines: string[] = [
    '## Saved methods',
    '[Step-by-step methods the user or household saved for tasks like this. Follow the matching one when it applies, adapting to the specifics of the request.]',
  ]
  let used = lines.join('\n').length
  for (const { row } of top) {
    const scope = row.userId === null ? 'household method' : 'personal method'
    const steps = row.steps.length > STEPS_CHARS ? `${row.steps.slice(0, STEPS_CHARS)}…` : row.steps
    const entry = `### ${row.name} (${scope})\n${steps}`
    if (used + entry.length + 1 > BLOCK_CHAR_BUDGET) break
    lines.push(entry)
    used += entry.length + 1
  }

  // Fire-and-forget usage bump on the best match, for future ranking/management.
  const best = top[0]?.row
  if (best) {
    void db.update(methods).set({ uses: best.uses + 1, lastUsedAt: new Date() }).where(eq(methods.id, best.id)).catch(() => {})
  }

  return lines.length > 2 ? lines.join('\n') : null
}

/** Drop recall caches affected by a method write (personal → owner; household → all). */
export function invalidateMethodBlocks(ownerId: string | null): void {
  if (ownerId === null) invalidateAllMemoryBlocks()
  else invalidateMemoryBlocksForUser(ownerId)
}
