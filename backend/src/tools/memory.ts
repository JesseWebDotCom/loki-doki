// Explicit memory control: "remember that…" / "forget what I said about…".
// The judge extracts facts passively minutes after a conversation goes idle; these
// tools give the user a DIRECT, immediate write/erase path with a spoken
// confirmation (directReply — no LLM synthesis, so nothing gets reworded).
// Both write to the shared brain (characterId = null): every companion knows.

import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { memories } from '@/db/schema'
import { embed, cosineSimilarity } from '@/llm/embed'
import { invalidateMemoryBlocksForUser } from '@/memory/blockCache'
import type { Tool, ToolResult } from './index'

// Duplicate guard for remember: at/above this cosine the fact is already stored.
const DUPLICATE_COSINE = 0.88
// Match floor for forget: below this we refuse to guess which memory they meant.
const FORGET_MIN_COSINE = 0.55

const REMEMBER_LEAD_RE = /^(?:hey\s+\w+[,!]?\s+)?(?:please\s+)?(?:can you\s+|could you\s+|will you\s+)?(?:remember|note|keep in mind|don'?t forget)(?:\s+that)?[:,]?\s*/i
const FORGET_LEAD_RE = /^(?:hey\s+\w+[,!]?\s+)?(?:please\s+)?(?:can you\s+|could you\s+)?(?:forget|erase|delete|remove)(?:\s+(?:that|what i (?:said|told you) about|about|the (?:memory|fact|thing) (?:that|about)?))?[:,]?\s*/i

async function activeUserMemories(userId: string) {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.userId, userId), isNull(memories.characterId), eq(memories.status, 'active')))
}

export const rememberTool: Tool = {
  id: 'remember',
  name: 'Remember',
  description: 'Store a fact the user explicitly asked to be remembered',
  offline: true, // embeddings are local
  dataSources: [],
  passMessage: 'text',
  examples: [
    'remember that my anniversary is in October',
    'please remember I park in garage spot 14',
    "don't forget that Sarah is allergic to peanuts",
    'keep in mind that I switched jobs to the hospital',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Store a fact the user explicitly asked the companion to remember, verbatim from their message.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', description: "The user's full request" } },
      },
    },
  },

  async execute(args: unknown, config: Record<string, unknown>): Promise<ToolResult> {
    const userId = config['_userId'] as string | undefined
    if (!userId) return { success: false, error: 'no user context' }
    const raw = String((args as { text?: unknown })?.text ?? config['_rawMessage'] ?? '').trim()
    const fact = raw.replace(REMEMBER_LEAD_RE, '').trim().replace(/[.?!]+$/, '')
    if (!fact) return { success: false, error: 'nothing to remember' }

    try {
      const factEmbedding = await embed(fact)
      const existing = await activeUserMemories(userId)
      for (const m of existing) {
        if (!m.embedding) continue
        try {
          if (cosineSimilarity(factEmbedding, JSON.parse(m.embedding) as number[]) >= DUPLICATE_COSINE) {
            return { success: true, data: { stored: false, existing: m.text }, directReply: `I've already got that noted — "${m.text}".` }
          }
        } catch { /* skip bad row */ }
      }

      const now = new Date()
      await db.insert(memories).values({
        id: crypto.randomUUID(),
        userId,
        characterId: null,
        entityId: null,
        text: fact,
        sourceText: raw.slice(0, 500),
        category: 'fact',
        tier: 'durable',
        status: 'active',
        embedding: JSON.stringify(factEmbedding),
        importance: 7,
        pinned: false,
        uses: 0,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      invalidateMemoryBlocksForUser(userId)
      return { success: true, data: { stored: true, text: fact }, directReply: `Got it — I'll remember that.` }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const forgetTool: Tool = {
  id: 'forget',
  name: 'Forget',
  description: 'Erase a stored memory the user asked to forget',
  offline: true,
  dataSources: [],
  passMessage: 'text',
  examples: [
    'forget what I said about my old job',
    'please forget that thing about my diet',
    'delete the memory about my brother',
    'erase what I told you about the move',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'forget',
      description: 'Erase a stored memory matching what the user asked to forget, verbatim from their message.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', description: "The user's full request" } },
      },
    },
  },

  async execute(args: unknown, config: Record<string, unknown>): Promise<ToolResult> {
    const userId = config['_userId'] as string | undefined
    if (!userId) return { success: false, error: 'no user context' }
    const raw = String((args as { text?: unknown })?.text ?? config['_rawMessage'] ?? '').trim()
    const query = raw.replace(FORGET_LEAD_RE, '').trim().replace(/[.?!]+$/, '')
    if (!query) return { success: false, error: 'nothing to forget' }

    try {
      const queryEmbedding = await embed(query)
      const existing = await activeUserMemories(userId)
      let best: { id: string; text: string; cos: number } | null = null
      for (const m of existing) {
        if (!m.embedding) continue
        try {
          const cos = cosineSimilarity(queryEmbedding, JSON.parse(m.embedding) as number[])
          if (!best || cos > best.cos) best = { id: m.id, text: m.text, cos }
        } catch { /* skip bad row */ }
      }

      if (!best || best.cos < FORGET_MIN_COSINE) {
        return { success: true, data: { forgotten: false }, directReply: `I couldn't find a memory matching that — nothing was removed.` }
      }

      await db
        .update(memories)
        .set({ status: 'superseded', updatedAt: new Date() })
        .where(eq(memories.id, best.id))
      invalidateMemoryBlocksForUser(userId)
      return { success: true, data: { forgotten: true, text: best.text }, directReply: `Done — I've forgotten "${best.text}".` }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}
