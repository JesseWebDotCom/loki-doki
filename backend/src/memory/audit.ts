/**
 * Memory audit — periodic re-examination of already-stored memories.
 *
 * The judge only ever evaluates NEW facts as they arrive; it never re-audits the
 * existing store. So once a low-value or transient "fact" lands (e.g. "the user
 * knows the current date"), nothing removes it except slow episodic decay. This
 * pass closes that gap: it re-applies the discard rules to existing low-value
 * episodic memories and soft-deletes (supersedes) the junk.
 *
 * Conservative by design:
 *   - durable + pinned memories are never touched (identity/relationship/prefs)
 *   - only episodic memories with importance <= AUDIT_IMPORTANCE_MAX are candidates
 *   - the LLM must explicitly list ids to discard; ambiguity = keep
 *   - bounded to AUDIT_BATCH_LIMIT rows per run to keep token cost predictable
 */

import { structuredCall } from '@/llm/structured'
import { db } from '@/db'
import { memories } from '@/db/schema'
import { and, eq, lte, inArray, asc } from 'drizzle-orm'
import { logger } from '@/lib/logger'

const AUDIT_IMPORTANCE_MAX = 5   // only scrutinise low-importance episodic memories
const AUDIT_BATCH_LIMIT = 60     // max memories examined per audit run
const AUDIT_CHUNK = 20           // memories per LLM call

const AUDIT_PROMPT = `You are auditing a personal AI's long-term memory store. Each line is a stored "memory" with an id. Flag the ids that should NOT have been stored — they are not durable facts about the user.

DISCARD (flag the id) when the memory is:
- A transient/real-time observation or the user's relationship to it ("the user knows the current date", "the user is unsure about the date", "the user asked about the weather")
- A temporary state, mood, or feeling ("the user is tired", "the user is excited today")
- Trivially true or contentless ("the user said hi", "the user wants help", "the user is chatting")
- A one-off question the user asked, not a fact about them
- World trivia that reveals nothing personal about the user

KEEP (do NOT flag) anything that is a stable fact about the user's identity, life, relationships, preferences, possessions, projects, or goals. When unsure, KEEP.

Memories:
{list}

Return ONLY this JSON object: {"discard": ["<id>", ...]}  (empty array if nothing to discard)`

interface AuditDecision {
  discard: string[]
}

/** Run the AUDIT_PROMPT over a candidate list and return the flagged ids. */
async function flagJunk(model: string, candidates: { id: string; text: string }[]): Promise<string[]> {
  const flagged: string[] = []
  for (let i = 0; i < candidates.length; i += AUDIT_CHUNK) {
    const chunk = candidates.slice(i, i + AUDIT_CHUNK)
    const list = chunk.map((m) => `[${m.id}] ${m.text}`).join('\n')
    const prompt = AUDIT_PROMPT.replace('{list}', list)

    try {
      const decision = await structuredCall<AuditDecision>(model, prompt)
      const ids = Array.isArray(decision?.discard) ? decision.discard : []
      // Only accept ids we actually sent — guards against the model inventing ids
      const valid = new Set(chunk.map((m) => m.id))
      for (const id of ids) if (valid.has(id)) flagged.push(id)
    } catch {
      // best-effort: a failed chunk just means nothing pruned this round
    }
  }
  return flagged
}

export async function runMemoryAudit(model: string): Promise<number> {
  // Candidate junk lives in the episodic tier at low importance. Prefer the
  // least-recently-used rows so genuinely-used memories aren't re-audited forever.
  const candidates = await db
    .select({ id: memories.id, text: memories.text })
    .from(memories)
    .where(
      and(
        eq(memories.status, 'active'),
        eq(memories.tier, 'episodic'),
        eq(memories.pinned, false),
        lte(memories.importance, AUDIT_IMPORTANCE_MAX),
      ),
    )
    .orderBy(asc(memories.lastUsedAt), asc(memories.createdAt))
    .limit(AUDIT_BATCH_LIMIT)

  const toDiscard = candidates.length > 0 ? await flagJunk(model, candidates) : []

  if (toDiscard.length > 0) {
    // Soft-delete (supersede) rather than hard-delete — consistent with the judge's
    // bi-temporal pattern; nothing is ever truly lost.
    await db
      .update(memories)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(inArray(memories.id, toDiscard))
    logger.info(`[memory:audit] superseded ${toDiscard.length} junk memories`)
  }

  // ── Durable-tier pass ─────────────────────────────────────────────────────
  // The judge model picks each fact's tier, so junk occasionally lands marked
  // durable — where maintenance never decays it and the episodic-only audit never
  // saw it. Mis-tiered durable junk is IMMORTAL and, because recall's 150-row
  // candidate window is importance-ordered, it slowly starves episodic memories
  // out of recall. This pass is even more conservative: flagged durable rows are
  // DEMOTED to episodic (letting normal decay handle them), never superseded.
  const durableCandidates = await db
    .select({ id: memories.id, text: memories.text })
    .from(memories)
    .where(
      and(
        eq(memories.status, 'active'),
        eq(memories.tier, 'durable'),
        eq(memories.pinned, false),
        lte(memories.importance, AUDIT_IMPORTANCE_MAX + 1),
      ),
    )
    .orderBy(asc(memories.lastUsedAt), asc(memories.createdAt))
    .limit(AUDIT_BATCH_LIMIT)

  const toDemote = durableCandidates.length > 0 ? await flagJunk(model, durableCandidates) : []
  if (toDemote.length > 0) {
    await db
      .update(memories)
      .set({ tier: 'episodic', updatedAt: new Date() })
      .where(inArray(memories.id, toDemote))
    logger.info(`[memory:audit] demoted ${toDemote.length} mis-tiered durable memories to episodic`)
  }

  return toDiscard.length + toDemote.length
}
