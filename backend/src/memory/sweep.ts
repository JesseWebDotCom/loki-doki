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
import { runJudge, relinkEntityIds } from './judge'
import { runMaintenance } from './maintenance'
import { generateEpisode } from './episode'
import { getModel } from '@/lib/models'
import { logger } from '@/lib/logger'

// ─── Tuning ───────────────────────────────────────────────────────────────────

const JUDGE_INTERVAL_MS = 5 * 60 * 1_000          // run judge check every 5 min
const IDLE_THRESHOLD_MS = 5 * 60 * 1_000          // conversation must be quiet for 5 min
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000   // run maintenance every 1 hr

// Max messages to feed the judge per run (keeps the prompt bounded)
const MAX_JUDGE_MESSAGES = 60

// Generate an episode summary when a conversation reaches this many messages
const EPISODE_MESSAGE_THRESHOLD = 20

// ─── Judge sweep ──────────────────────────────────────────────────────────────

// Overlap guard: if a sweep runs longer than JUDGE_INTERVAL_MS the next tick
// would re-enter and double-process the same conversations. Skip while busy.
let sweeping = false

async function runJudgeSweep(): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
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

      // Run judge
      const judgeResult = await runJudge(
        conv.id,
        conv.userId,
        conv.characterId ?? null,
        msgList,
        model,
      )

      // Link any facts that reference entities created in this batch
      await relinkEntityIds(conv.userId, conv.characterId ?? null)

      // Advance the cursor to the latest processed message timestamp
      const newestMsgTime = unprocessedRows[unprocessedRows.length - 1]!.createdAt

      await db
        .update(conversations)
        .set({ memoryProcessedThrough: newestMsgTime })
        .where(eq(conversations.id, conv.id))

      // Episode generation: if the conversation has crossed the threshold and doesn't
      // have a recent episode, generate one
      const [msgCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(eq(messages.conversationId, conv.id))

      if ((msgCount?.count ?? 0) >= EPISODE_MESSAGE_THRESHOLD) {
        const allMsgs = await db
          .select({ role: messages.role, content: messages.content })
          .from(messages)
          .where(eq(messages.conversationId, conv.id))
          .orderBy(messages.createdAt)
          .limit(MAX_JUDGE_MESSAGES)

        generateEpisode(conv.id, conv.userId, conv.characterId ?? null, allMsgs, model).catch(() => {})
      }

      if (judgeResult.factsAdded > 0 || judgeResult.entitiesUpserted > 0) {
        logger.info(
          `[memory:judge] conv=${conv.id} ` +
          `entities=${judgeResult.entitiesUpserted} ` +
          `added=${judgeResult.factsAdded} updated=${judgeResult.factsUpdated} ` +
          `superseded=${judgeResult.factsSuperseded} no_change=${judgeResult.factsNoChange}`,
        )
      }
    } catch (err) {
      logger.error(`[memory:sweep] judge failed for conv=${conv.id}: ${err}`)
    }
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
  }, MAINTENANCE_INTERVAL_MS)

  // Run maintenance once shortly after startup (cleans up any stale state)
  setTimeout(() => {
    runMaintenance().catch((err) => logger.error(`[memory:sweep] startup maintenance error: ${err}`))
  }, 30_000)

  return {
    stop() {
      clearInterval(judgeTimer)
      clearInterval(maintenanceTimer)
    },
  }
}

/**
 * Trigger the judge immediately for a specific conversation (e.g. on explicit close).
 * Fire-and-forget — callers should not await this in the request path.
 */
export async function triggerJudgeForConversation(
  convId: string,
  userId: string,
  characterId: string | null,
  allMessages: Array<{ role: string; content: string }>,
): Promise<void> {
  try {
    const model = await getModel()
    const judgeResult = await runJudge(convId, userId, characterId, allMessages, model)
    await relinkEntityIds(userId, characterId)

    const now = new Date()
    await db.update(conversations).set({ memoryProcessedThrough: now }).where(eq(conversations.id, convId))

    logger.info(
      `[memory:judge:explicit] conv=${convId} ` +
      `entities=${judgeResult.entitiesUpserted} added=${judgeResult.factsAdded}`,
    )
  } catch (err) {
    logger.error(`[memory:judge:explicit] failed for conv=${convId}: ${err}`)
  }
}
