import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import { icloudAccounts, icloudMailMessages, icloudMailVerdicts } from '@/db/schema'
import { isFeatureEnabled } from '@/lib/featureGate'
import { shouldRunOpportunistic } from '@/lib/idleScheduler'
import { heuristicVerdict, loadSenderStats } from '@/lib/icloud/mail/heuristics'
import { judgeMessage } from '@/lib/icloud/mail/llmJudge'
import { logger } from '@/lib/logger'

// Triage orchestrator (iCloud plan M5). Fresh arrivals get the deterministic
// heuristics immediately (cheap, synchronous with ingest); the uncertain band is
// simply "messages with no verdict row yet" and drains through the local-LLM judge
// only when the idle scheduler says the box is quiet. Verdicts are append-only and
// NOTHING here moves or deletes mail — Phase 1 is dry-run by design.

const DRAIN_TICK_MS = 2 * 60_000
const DRAIN_BATCH = 5
const TRIAGE_LOOKBACK_MS = 7 * 86_400_000   // never judge ancient backlog

let drainStarted = false
let draining = false

async function saveVerdict(
  accountId: string,
  messageRowId: string,
  v: { bucket: 'ignore' | 'notify' | 'respond'; confidence: number; reason: string },
  method: 'heuristic' | 'llm',
  model?: string,
): Promise<void> {
  await db.insert(icloudMailVerdicts).values({
    id: crypto.randomUUID(), accountId, messageId: messageRowId,
    bucket: v.bucket, method, confidence: v.confidence, reason: v.reason,
    model: model ?? null, createdAt: new Date(),
  })
}

/** Rows in the lookback window that have no verdict yet. */
async function pendingMessages(limit: number) {
  return db
    .select({
      id: icloudMailMessages.id,
      accountId: icloudMailMessages.accountId,
      ownerUserId: icloudAccounts.userId,
      fromAddress: icloudMailMessages.fromAddress,
      fromName: icloudMailMessages.fromName,
      subject: icloudMailMessages.subject,
      snippet: icloudMailMessages.snippet,
      listUnsubscribe: icloudMailMessages.listUnsubscribe,
      authResults: icloudMailMessages.authResults,
    })
    .from(icloudMailMessages)
    .innerJoin(icloudAccounts, eq(icloudMailMessages.accountId, icloudAccounts.id))
    .leftJoin(icloudMailVerdicts, eq(icloudMailVerdicts.messageId, icloudMailMessages.id))
    .where(and(
      isNull(icloudMailVerdicts.id),
      gt(icloudMailMessages.receivedAt, new Date(Date.now() - TRIAGE_LOOKBACK_MS)),
    ))
    .orderBy(sql`${icloudMailMessages.receivedAt} DESC`)
    .limit(limit)
}

/** Heuristics pass over everything unjudged — called right after each ingest. */
export async function triagePending(): Promise<{ decided: number; queued: number }> {
  let decided = 0
  let queued = 0
  for (const m of await pendingMessages(200)) {
    const verdict = await heuristicVerdict(m.accountId, m.ownerUserId, m)
    if (verdict) {
      await saveVerdict(m.accountId, m.id, verdict, 'heuristic')
      decided++
    } else {
      queued++   // stays pending for the idle-time LLM drain
    }
  }
  if (decided || queued) logger.info(`[icloud-mail] triage: ${decided} by heuristics, ${queued} queued for judge`)
  return { decided, queued }
}

/** Idle-time drain: judge a small batch of the uncertain band with the local LLM. */
async function drainTick(): Promise<void> {
  if (draining) return
  if (!(await isFeatureEnabled('icloud-mail'))) return
  if (!shouldRunOpportunistic()) return
  draining = true
  try {
    // Heuristics may now resolve messages that were uncertain earlier (sender stats
    // accumulate), so run them first and only judge what remains.
    await triagePending()
    const pending = await pendingMessages(DRAIN_BATCH)
    for (const m of pending) {
      if (!shouldRunOpportunistic()) break   // the box got busy mid-batch
      const stats = m.fromAddress ? await loadSenderStats(m.accountId, m.fromAddress) : null
      const verdict = await judgeMessage({
        fromName: m.fromName, fromAddress: m.fromAddress, subject: m.subject,
        snippet: m.snippet, isListMail: !!m.listUnsubscribe,
        firstTimeSender: (stats?.seenCount ?? 0) <= 1,
      })
      await saveVerdict(m.accountId, m.id, verdict, 'llm', verdict.model)
    }
  } catch (e) {
    logger.warn(`[icloud-mail] triage drain failed: ${e instanceof Error ? e.message : e}`)
  } finally {
    draining = false
  }
}

export function startTriageDrain(): void {
  if (drainStarted) return
  drainStarted = true
  setInterval(() => { void drainTick() }, DRAIN_TICK_MS)
}
