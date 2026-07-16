// Explicit memory control: "remember that…" / "forget what I said about…".
// The judge extracts facts passively minutes after a conversation goes idle; these
// tools give the user a DIRECT, immediate write/erase path with a spoken
// confirmation (directReply — no LLM synthesis, so nothing gets reworded).
// Both write to the shared brain (characterId = null): every companion knows.
//
// remember is ALSO the capture path for the Notes app: one fast-model classification
// decides whether the content is a short conversational fact (memories table, the
// original path) or reference/procedural/measurement knowledge, which lands in a
// real note instead ("the far pothole took 8 bags" → append to "Driveway repair" or
// start a new personal note). Note capture (append-vs-create, duplicate suppression,
// Home Inventory device linking) lives in lib/notes/capture.ts, shared with the
// passive memory judge so the two paths cannot diverge. ANY classification failure
// falls back to the memory path, so behavior degrades to exactly what it was before.

import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { memories } from '@/db/schema'
import { embed, cosineSimilarity } from '@/llm/embed'
import { structuredCall } from '@/llm/structured'
import { invalidateMemoryBlocksForUser } from '@/memory/blockCache'
import { captureNoteFact } from '@/lib/notes/capture'
import { stageWithDirective } from '@/lib/companionActions'
import { logger } from '@/lib/logger'
import type { Tool, ToolResult } from './index'

// Duplicate guard for remember: at/above this cosine the fact is already stored.
const DUPLICATE_COSINE = 0.88
// Match floor for forget: below this we refuse to guess which memory they meant.
const FORGET_MIN_COSINE = 0.55

const REMEMBER_LEAD_RE = /^(?:hey\s+\w+[,!]?\s+)?(?:please\s+)?(?:can you\s+|could you\s+|will you\s+)?(?:remember|note|log|write down|jot down|keep in mind|don'?t forget)(?:\s+that)?[:,]?\s*/i
const FORGET_LEAD_RE = /^(?:hey\s+\w+[,!]?\s+)?(?:please\s+)?(?:can you\s+|could you\s+)?(?:forget|erase|delete|remove)(?:\s+(?:that|what i (?:said|told you) about|about|the (?:memory|fact|thing) (?:that|about)?))?[:,]?\s*/i

async function activeUserMemories(userId: string) {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.userId, userId), isNull(memories.characterId), eq(memories.status, 'active')))
}

interface CaptureVerdict { kind: 'memory' | 'note'; title: string }

// Fast-model classification: memory vs note. Falls back to memory on ANY failure so
// the legacy remember path is the worst case.
async function classifyCapture(fact: string): Promise<CaptureVerdict> {
  try {
    // Deferred import: lib/models → llm/router → tools/index → this file is a cycle.
    const { getFastModel } = await import('@/lib/models')
    const model = await getFastModel()
    const verdict = await structuredCall<Partial<CaptureVerdict>>(
      model,
      `Fact: "${fact}"

Classify this fact the user asked to save:
- "memory" = a short personal or conversational fact about the user or their people (preferences, dates, relationships, where they parked, states of mind).
- "note" = procedural, reference, technical, measurement, or project knowledge worth keeping in a document (how-tos, install gotchas, quantities and materials used, server or device configs, build plans).

Also give a short 2-5 word title naming the subject or project it belongs to (e.g. "Driveway repair", "Media server setup"), never a material, quantity, or date.
JSON: {"kind": "memory" | "note", "title": "..."}`,
    )
    if (verdict.kind !== 'note') return { kind: 'memory', title: '' }
    return { kind: 'note', title: (verdict.title ?? '').trim().slice(0, 80) }
  } catch (err) {
    logger.warn(`[remember] capture classification failed, defaulting to memory: ${err}`)
    return { kind: 'memory', title: '' }
  }
}

export const rememberTool: Tool = {
  id: 'remember',
  name: 'Remember',
  description: 'Store a fact the user explicitly asked to be remembered',
  offline: true, // embeddings are local
  core: true,
  dataSources: [],
  passMessage: 'text',
  examples: [
    'remember that my anniversary is in October',
    'please remember I park in garage spot 14',
    "don't forget that Sarah is allergic to peanuts",
    'keep in mind that I switched jobs to the hospital',
    'note that the far driveway pothole took 8 bags of cold patch',
    'log that I replaced the furnace filter today',
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

      // Capture classification: reference/procedural/measurement content becomes a
      // real note (Notes app) instead of a conversational memory. Classification
      // failure = memory path, exactly the pre-notes behavior.
      const verdict = await classifyCapture(fact)
      if (verdict.kind === 'note') {
        const captured = await captureNoteFact({
          userId,
          allowSharedAppend: config['_isAdmin'] === true,
          fact,
          factEmbedding,
          title: verdict.title || undefined,
        })
        const linkedSuffix = captured.device?.newlyLinked ? ` and linked it to ${captured.device.name}` : ''
        const directReply =
          captured.status === 'duplicate' ? `I've already got that written down in "${captured.title}".`
          : captured.status === 'appended' ? `Noted. I added that to "${captured.title}"${linkedSuffix}.`
          : `Noted. I started a note called "${captured.title}" for that${linkedSuffix}.`
        return {
          success: true,
          data: {
            stored: captured.status !== 'duplicate',
            note: true,
            noteId: captured.noteId,
            appended: captured.status === 'appended',
            deviceId: captured.device?.id ?? null,
            text: fact,
          },
          directReply,
        }
      }

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
  core: true,
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

      // Destructive: stage the removal and ask, instead of deleting on a fuzzy
      // match. The confirm_pending tool (or a surface approve button) resolves it.
      const target = best
      const { directive } = stageWithDirective({
        userId,
        conversationId: String(config['_conversationId'] ?? ''),
        toolId: 'forget',
        summary: `forget "${target.text}"`,
        approveLabel: 'Yes, forget it',
        declineLabel: 'Keep it',
        execute: async () => {
          await db
            .update(memories)
            .set({ status: 'superseded', updatedAt: new Date() })
            .where(eq(memories.id, target.id))
          invalidateMemoryBlocksForUser(userId)
          return `Done — I've forgotten "${target.text}".`
        },
      })
      return {
        success: true,
        data: { pendingConfirm: true, text: target.text },
        directReply: `Just to confirm, you want me to forget "${target.text}"?`,
        directive,
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}
