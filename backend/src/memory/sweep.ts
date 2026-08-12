/**
 * Memory sweep — background orchestrator (Letta "sleep-time" pattern).
 *
 * Runs two jobs on separate intervals:
 *
 *   Judge sweep (every JUDGE_INTERVAL_MS, default 5 min):
 *     Find conversations where the last message is:
 *       (a) older than IDLE_THRESHOLD_MS (user has gone quiet), AND
 *       (b) newer than memoryProcessedThrough (there are unprocessed messages).
 *     For each, fetch the unprocessed span, run the judge, advance the cursor.
 *
 *   Maintenance sweep (every MAINTENANCE_INTERVAL_MS, default 1 hr):
 *     Run decay scoring and archival across all scopes.
 *
 * Neither job blocks the request path. Errors are caught and logged — a failed
 * sweep is never visible to the user.
 */

import { db } from '@/db'
import { conversations, messages } from '@/db/schema'
import { and, eq, gt, desc, sql } from 'drizzle-orm'
import { runJudge, runSelfJudge, relinkEntityIds } from './judge'
import { runMaintenance } from './maintenance'
import { runMemoryAudit } from './audit'
import { runConsolidation } from './consolidate'
import { markProfileDirty, regenerateDirtyProfiles } from './profile'
import { generateEpisode } from './episode'
import { invalidateMemoryBlocksForUser, invalidateAllMemoryBlocks } from './blockCache'
import { invalidateEntityCache } from './recall'
import { getModel } from '@/lib/models'
import { logger } from '@/lib/logger'
import { waitForInteractiveIdle } from '@/lib/activityGate'

// ─── Tuning ───────────────────────────────────────────────────────────────────

const JUDGE_INTERVAL_MS = 5 * 60 * 1_000          // run judge check every 5 min
const IDLE_THRESHOLD_MS = 5 * 60 * 1_000          // conversation must be quiet for 5 min
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000   // run maintenance every 1 hr

// Max messages to feed the judge per run (keeps the prompt bounded)
const MAX_JUDGE_MESSAGES = 60

// Generate an episode summary when the just-judged SPAN has at least this many
// messages. The old rule ("conversation total ≥ 20") re-summarized the FIRST 60
// messages of a long conversation on every sweep — N near-identical episodes of
// its opening, while content past message 60 was never summarized.
const EPISODE_SPAN_THRESHOLD = 12

// ─── Judge sweep ──────────────────────────────────────────────────────────────

// Overlap guard: if a sweep runs longer than JUDGE_INTERVAL_MS the next tick
// would re-enter and double-process the same conversations. Skip while busy.
let sweeping = false

// Consecutive judge (Phase-1 extraction) failures per conversation. A failed run
// does NOT advance memoryProcessedThrough (the span would be silently lost), but a
// poisoned conversation must not wedge the sweep forever — after this many
// consecutive failures the cursor advances anyway and the span is abandoned.
const MAX_JUDGE_RETRIES = 3
const judgeFailures = new Map<string, number>()

// Yield the event loop back to the HTTP server. bun:sqlite is synchronous and runs on
// the main thread, so a sweep that loops over many conversations back-to-back monopolises
// the loop — and EVERY request (including the no-op /api/health probe) stalls together
// until it finishes, which the frontend pollers surface as a burst of 500s. A macrotask
// yield between conversations lets queued requests run in the gaps.
const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function runJudgeSweep(): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    // The judge runs on the same Ollama the family chats with. Defer to any live
    // conversation so a background memory pass never slows a reply. Bounded (the
    // sweep is idle-triggered and not urgent, so it can wait a while for quiet).
    await waitForInteractiveIdle({ quietMs: 2000, maxWaitMs: 60_000, label: 'memory-judge' })
    await doJudgeSweep()
  } finally {
    sweeping = false
  }
}

async function doJudgeSweep(): Promise<void> {
  const model = await getModel()
  const now = Date.now()
  const idleCutoff = new Date(now - IDLE_THRESHOLD_MS)
  // Timestamps are stored as epoch SECONDS (Drizzle `timestamp` mode). Raw `sql`
  // interpolation doesn't run the column mapper, so bind seconds explicitly.
  const idleCutoffSecs = Math.floor(idleCutoff.getTime() / 1000)

  // Find candidate conversations directly in SQL rather than loading every row
  // and filtering in JS. A conversation qualifies when its most-recent message:
  //   1. is older than the idle cutoff (user went quiet), AND
  //   2. is newer than memoryProcessedThrough (there is unprocessed content),
  //      or the conversation has never been processed.
  // The correlated subquery computes the latest message time per conversation;
  // this stays within Drizzle's SQLite dialect.
  const latestMsg = sql<number>`(
    select max(${messages.createdAt})
    from ${messages}
    where ${messages.conversationId} = ${conversations.id}
  )`

  const candidates = await db
    .select()
    .from(conversations)
    .where(
      and(
        sql`${latestMsg} is not null`,
        sql`${latestMsg} <= ${idleCutoffSecs}`,
        sql`(${conversations.memoryProcessedThrough} is null or ${latestMsg} > ${conversations.memoryProcessedThrough})`,
      ),
    )

  for (const conv of candidates) {
    // Let any queued HTTP requests run between conversations so the sweep never holds
    // the synchronous SQLite thread long enough to stall the liveness probe.
    await yieldToLoop()
    try {
      // Find the most recent message in this conversation
      const [latest] = await db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.conversationId, conv.id))
        .orderBy(desc(messages.createdAt))
        .limit(1)

      if (!latest) continue

      const lastMsgTime = latest.createdAt.getTime()

      // Skip if user is still active (message too recent)
      if (lastMsgTime > idleCutoff.getTime()) continue

      // Skip if judge has already processed through this message
      const processedThrough = conv.memoryProcessedThrough?.getTime() ?? 0
      if (lastMsgTime <= processedThrough) continue

      // Fetch unprocessed messages (newer than processedThrough, up to MAX_JUDGE_MESSAGES)
      const unprocessedRows = await db
        .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conv.id),
            processedThrough > 0
              ? gt(messages.createdAt, new Date(processedThrough))
              : undefined,
          ),
        )
        .orderBy(messages.createdAt)
        .limit(MAX_JUDGE_MESSAGES)

      if (unprocessedRows.length === 0) continue

      const msgList = unprocessedRows.map((m) => ({ role: m.role, content: m.content }))

      // Run judge. Facts about the USER go to the shared brain (characterId=null)
      // so every companion shares the same knowledge of the person — switching
      // characters never loses what you've told another one. Per-character texture
      // (first-met, episodes) is written separately, scoped to the character.
      const judgeResult = await runJudge(
        conv.id,
        conv.userId,
        null,
        msgList,
        model,
      )

      // Extraction failed — leave the cursor where it is so the span is retried
      // next sweep, up to the retry budget (then abandon it so one poisoned
      // conversation can't wedge the sweep forever).
      if (judgeResult.failed) {
        const fails = (judgeFailures.get(conv.id) ?? 0) + 1
        if (fails < MAX_JUDGE_RETRIES) {
          judgeFailures.set(conv.id, fails)
          logger.warn(`[memory:sweep] judge extraction failed for conv=${conv.id} (attempt ${fails}/${MAX_JUDGE_RETRIES}) — will retry next sweep`)
          continue
        }
        logger.error(`[memory:sweep] judge extraction failed ${fails}x for conv=${conv.id} — abandoning span`)
      }
      judgeFailures.delete(conv.id)

      // Link any facts that reference entities created in this batch (shared scope)
      await relinkEntityIds(conv.userId, null)

      // Newly-written facts must surface in ONGOING conversations too — drop every
      // cached memory block (and the entity-pass cache) for this user. Previously
      // only the overlay invalidated, so chat conversations ran stale up to 30 min.
      if (judgeResult.factsAdded > 0 || judgeResult.factsUpdated > 0 || judgeResult.factsSuperseded > 0 || judgeResult.entitiesUpserted > 0) {
        invalidateEntityCache(conv.userId)
        // Household facts appear in EVERYONE's recall — bust all blocks.
        if (judgeResult.householdTouched) invalidateAllMemoryBlocks()
        else invalidateMemoryBlocksForUser(conv.userId)
        // The user's knowledge paragraph is stale too — regenerated on the
        // maintenance cadence (see regenerateDirtyProfiles).
        markProfileDirty(conv.userId)
      }

      // Companion self-memory: what the COMPANION said (opinions, promises,
      // personal statements) in this span. Character conversations only —
      // the plain assistant has no persona to stay consistent with.
      if (conv.characterId) {
        try {
          const selfWritten = await runSelfJudge(conv.userId, conv.characterId, msgList, model)
          if (selfWritten > 0) {
            invalidateMemoryBlocksForUser(conv.userId)
            logger.info(`[memory:self-judge] conv=${conv.id} char=${conv.characterId} facts=${selfWritten}`)
          }
        } catch (err) {
          logger.warn(`[memory:self-judge] failed for conv=${conv.id}: ${err}`)
        }
      }

      // Advance the cursor to the latest processed message timestamp
      const newestMsgTime = unprocessedRows[unprocessedRows.length - 1]!.createdAt

      await db
        .update(conversations)
        .set({ memoryProcessedThrough: newestMsgTime })
        .where(eq(conversations.id, conv.id))

      // Episode generation: summarize the SPAN that was just judged. The cursor
      // advance above guarantees each span is summarized at most once, and spans
      // past message 60 get their own episodes as the conversation grows.
      if (unprocessedRows.length >= EPISODE_SPAN_THRESHOLD) {
        generateEpisode(conv.id, conv.userId, conv.characterId ?? null, msgList, model).catch(() => {})
      }

      if (judgeResult.factsAdded > 0 || judgeResult.entitiesUpserted > 0 || judgeResult.notesCaptured > 0) {
        logger.info(
          `[memory:judge] conv=${conv.id} ` +
          `entities=${judgeResult.entitiesUpserted} ` +
          `added=${judgeResult.factsAdded} updated=${judgeResult.factsUpdated} ` +
          `superseded=${judgeResult.factsSuperseded} no_change=${judgeResult.factsNoChange} ` +
          `notes=${judgeResult.notesCaptured}`,
        )
      }
    } catch (err) {
      logger.error(`[memory:sweep] judge failed for conv=${conv.id}: ${err}`)
    }
  }
}

// ─── Audit sweep ────────────────────────────────────────────────────────────────

let auditing = false

async function runAudit(): Promise<void> {
  if (auditing) return
  auditing = true
  try {
    const model = await getModel()
    await runMemoryAudit(model)
  } finally {
    auditing = false
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the background sweep. Call once at server startup.
 * Returns cleanup handles (for testing / graceful shutdown).
 */
export function startMemorySweep(): { stop: () => void } {
  const judgeTimer = setInterval(() => {
    runJudgeSweep().catch((err) => logger.error(`[memory:sweep] judge sweep error: ${err}`))
  }, JUDGE_INTERVAL_MS)

  const maintenanceTimer = setInterval(() => {
    runMaintenance().catch((err) => logger.error(`[memory:sweep] maintenance error: ${err}`))
    runAudit().catch((err) => logger.error(`[memory:sweep] audit error: ${err}`))
    // Sleep-time jobs behind the same idle gate the judge uses: the knowledge
    // paragraphs touched since the last pass, and the (self-gated, weekly)
    // consolidation + contradiction sweep.
    void (async () => {
      try {
        await waitForInteractiveIdle({ quietMs: 2000, maxWaitMs: 60_000, label: 'memory-profile' })
        await regenerateDirtyProfiles()
        await runConsolidation(await getModel())
      } catch (err) {
        logger.error(`[memory:sweep] profile/consolidation error: ${err}`)
      }
    })()
  }, MAINTENANCE_INTERVAL_MS)

  // Run maintenance + audit once shortly after startup (cleans up stale state
  // and prunes any junk that accumulated before this pass existed)
  setTimeout(() => {
    runMaintenance().catch((err) => logger.error(`[memory:sweep] startup maintenance error: ${err}`))
    runAudit().catch((err) => logger.error(`[memory:sweep] startup audit error: ${err}`))
  }, 30_000)

  return {
    stop() {
      clearInterval(judgeTimer)
      clearInterval(maintenanceTimer)
    },
  }
}

/**
 * Trigger the judge immediately for a specific conversation — used when a
 * conversation is DELETED before the idle sweep saw its tail (the messages are
 * already gone from the DB; the caller passes a snapshot).
 * Fire-and-forget — callers should not await this in the request path.
 */
export async function triggerJudgeForConversation(
  convId: string,
  userId: string,
  _characterId: string | null,
  allMessages: Array<{ role: string; content: string }>,
): Promise<void> {
  try {
    const model = await getModel()
    // User facts → shared brain (characterId=null), regardless of which character
    // the conversation was with. See doJudgeSweep for rationale.
    const judgeResult = await runJudge(convId, userId, null, allMessages, model)
    await relinkEntityIds(userId, null)
    invalidateEntityCache(userId)
    if (judgeResult.householdTouched) invalidateAllMemoryBlocks()
    else invalidateMemoryBlocksForUser(userId)

    const now = new Date()
    // No-op when the conversation row was already deleted — harmless.
    await db.update(conversations).set({ memoryProcessedThrough: now }).where(eq(conversations.id, convId))

    logger.info(
      `[memory:judge:explicit] conv=${convId} ` +
      `entities=${judgeResult.entitiesUpserted} added=${judgeResult.factsAdded} notes=${judgeResult.notesCaptured}`,
    )
  } catch (err) {
    logger.error(`[memory:judge:explicit] failed for conv=${convId}: ${err}`)
  }
}
