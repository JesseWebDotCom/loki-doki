// Impression + dismissal state for suggestion rails. One row per (user, domain, ref):
// shownCount demotes items the user has already scrolled past ("rotate, don't repeat"),
// dismissedAt is the explicit "Not interested" (hard-excluded, and its creator loses
// affinity at the next profile build). Recording happens server-side when a rail serves
// items — cards past the scroll fold count as shown, which is acceptable for rotation
// and avoids an entire client beacon subsystem.

import { randomUUID } from 'node:crypto'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { db } from '@/db'
import { suggestionImpressions } from '@/db/schema'
import { logger } from '@/lib/logger'
import type { InterestDomain } from './types'

export interface ImpressionRow {
  shownCount: number
  lastShownAt: number | null
  dismissedAt: number | null
}

export async function getImpressions(userId: string, domain: InterestDomain): Promise<Map<string, ImpressionRow>> {
  const rows = await db
    .select({
      ref: suggestionImpressions.ref,
      shownCount: suggestionImpressions.shownCount,
      lastShownAt: suggestionImpressions.lastShownAt,
      dismissedAt: suggestionImpressions.dismissedAt,
    })
    .from(suggestionImpressions)
    .where(and(eq(suggestionImpressions.userId, userId), eq(suggestionImpressions.domain, domain)))
  return new Map(
    rows.map((r) => [
      r.ref,
      {
        shownCount: r.shownCount,
        lastShownAt: r.lastShownAt ? r.lastShownAt.getTime() : null,
        dismissedAt: r.dismissedAt ? r.dismissedAt.getTime() : null,
      },
    ]),
  )
}

/** Dismissal counts per creator key (creatorId when known, else lowercased name) — feeds
 *  the profile builder's creator-affinity penalty. */
export async function dismissedCreatorCounts(userId: string, domain: InterestDomain): Promise<Map<string, number>> {
  const rows = await db
    .select({ creatorId: suggestionImpressions.creatorId, creatorName: suggestionImpressions.creatorName })
    .from(suggestionImpressions)
    .where(
      and(
        eq(suggestionImpressions.userId, userId),
        eq(suggestionImpressions.domain, domain),
        sql`${suggestionImpressions.dismissedAt} IS NOT NULL`,
      ),
    )
  const counts = new Map<string, number>()
  for (const r of rows) {
    const key = r.creatorId || r.creatorName?.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export interface ShownItem {
  ref: string
  creatorId?: string | null
  creatorName?: string | null
  title?: string | null
}

/** Bump shownCount for a served rail slice. Never dismisses, never resets a dismissal. */
export async function recordShown(userId: string, domain: InterestDomain, items: ShownItem[]): Promise<void> {
  if (!items.length) return
  const now = new Date()
  try {
    for (const it of items) {
      await db
        .insert(suggestionImpressions)
        .values({
          id: randomUUID(),
          userId,
          domain,
          ref: it.ref,
          creatorId: it.creatorId ?? null,
          creatorName: it.creatorName ?? null,
          title: it.title ?? null,
          shownCount: 1,
          lastShownAt: now,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [suggestionImpressions.userId, suggestionImpressions.domain, suggestionImpressions.ref],
          set: { shownCount: sql`${suggestionImpressions.shownCount} + 1`, lastShownAt: now },
        })
    }
  } catch (err) {
    // Impression tracking is best-effort — never let it break a rail response.
    logger.debug(`[interests] recordShown failed: ${String(err)}`)
  }
}

export async function dismiss(
  userId: string,
  domain: InterestDomain,
  ref: string,
  meta?: { creatorId?: string | null; creatorName?: string | null; title?: string | null },
): Promise<void> {
  const now = new Date()
  await db
    .insert(suggestionImpressions)
    .values({
      id: randomUUID(),
      userId,
      domain,
      ref,
      creatorId: meta?.creatorId ?? null,
      creatorName: meta?.creatorName ?? null,
      title: meta?.title ?? null,
      shownCount: 0,
      dismissedAt: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [suggestionImpressions.userId, suggestionImpressions.domain, suggestionImpressions.ref],
      set: {
        dismissedAt: now,
        // Backfill creator/title when the dismiss carries them and the shown row didn't.
        ...(meta?.creatorId ? { creatorId: meta.creatorId } : {}),
        ...(meta?.creatorName ? { creatorName: meta.creatorName } : {}),
        ...(meta?.title ? { title: meta.title } : {}),
      },
    })
}

export async function undismiss(userId: string, domain: InterestDomain, ref: string): Promise<void> {
  await db
    .update(suggestionImpressions)
    .set({ dismissedAt: null })
    .where(
      and(
        eq(suggestionImpressions.userId, userId),
        eq(suggestionImpressions.domain, domain),
        eq(suggestionImpressions.ref, ref),
      ),
    )
}

/** Daily sweep: forget stale rotation state, keep dismissals forever. Items unseen for
 *  14 days get their demotion reset (they can lead a rail again); non-dismissed rows
 *  idle for 60 days are deleted outright so the table tracks the active pool, not
 *  every suggestion ever made. */
export async function sweepImpressions(): Promise<void> {
  const now = Date.now()
  const resetBefore = new Date(now - 14 * 24 * 60 * 60 * 1000)
  const deleteBefore = new Date(now - 60 * 24 * 60 * 60 * 1000)
  await db
    .delete(suggestionImpressions)
    .where(and(isNull(suggestionImpressions.dismissedAt), lt(suggestionImpressions.lastShownAt, deleteBefore)))
  await db
    .update(suggestionImpressions)
    .set({ shownCount: 0 })
    .where(and(isNull(suggestionImpressions.dismissedAt), lt(suggestionImpressions.lastShownAt, resetBefore)))
}
