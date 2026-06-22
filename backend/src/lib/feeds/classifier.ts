// Feeds interest classifier: learns from a free-text interest profile + thumbs up/down,
// and scores unread items 0–1 so the UI can fold low-interest and highlight high-interest.
// On-demand only (never N-users × items eagerly); best-effort if no model.

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { feedInterests, feedItemScores } from '@/db/schema'
import { structuredCall } from '@/llm/structured'
import { getFastModel } from '@/lib/models'

export interface Interests { interestsText: string; likes: string[]; hides: string[] }

export async function getInterests(userId: string): Promise<Interests> {
  const row = await db.select().from(feedInterests).where(eq(feedInterests.userId, userId)).then((r) => r[0])
  return {
    interestsText: row?.interestsText ?? '',
    likes: row ? JSON.parse(row.likesJson) : [],
    hides: row ? JSON.parse(row.hidesJson) : [],
  }
}

async function saveInterests(userId: string, next: Interests): Promise<void> {
  const now = new Date()
  const existing = await db.select({ userId: feedInterests.userId }).from(feedInterests).where(eq(feedInterests.userId, userId)).then((r) => r[0])
  const vals = { interestsText: next.interestsText, likesJson: JSON.stringify(next.likes.slice(-50)), hidesJson: JSON.stringify(next.hides.slice(-50)), updatedAt: now }
  if (existing) await db.update(feedInterests).set(vals).where(eq(feedInterests.userId, userId))
  else await db.insert(feedInterests).values({ userId, ...vals })
}

export async function setInterestsText(userId: string, text: string): Promise<void> {
  const cur = await getInterests(userId)
  await saveInterests(userId, { ...cur, interestsText: text })
}

/** Record a thumbs up/down on an item title; clears the cached score so it re-scores. */
export async function recordFeedback(userId: string, title: string, vote: 'up' | 'down', itemId?: string): Promise<void> {
  const cur = await getInterests(userId)
  if (vote === 'up') cur.likes = [...cur.likes.filter((t) => t !== title), title]
  else cur.hides = [...cur.hides.filter((t) => t !== title), title]
  await saveInterests(userId, cur)
  if (itemId) await db.delete(feedItemScores).where(and(eq(feedItemScores.userId, userId), eq(feedItemScores.itemId, itemId))).catch(() => {})
}

/** Score a batch of items 0–1 for this user. Caches results; returns id→score. */
export async function scoreItems(userId: string, items: { id: string; title: string; summary?: string | null }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!items.length) return out

  // Serve cached scores; only score the uncached remainder.
  const cached = await db.select().from(feedItemScores)
    .where(and(eq(feedItemScores.userId, userId), inArray(feedItemScores.itemId, items.map((i) => i.id))))
  for (const c of cached) if (c.score != null) out.set(c.itemId, c.score)
  const todo = items.filter((i) => !out.has(i.id)).slice(0, 20)
  if (!todo.length) return out

  const interests = await getInterests(userId)
  if (!interests.interestsText && !interests.likes.length && !interests.hides.length) return out // nothing to learn from yet

  let scored: { id: string; score: number }[] = []
  try {
    const model = await getFastModel()
    const profile = `Interests: ${interests.interestsText || '(none stated)'}\nLikes examples: ${interests.likes.slice(-15).join('; ') || '(none)'}\nDislikes examples: ${interests.hides.slice(-15).join('; ') || '(none)'}`
    const list = todo.map((i, n) => `${n}. ${i.title}${i.summary ? ` — ${i.summary.slice(0, 120)}` : ''}`).join('\n')
    scored = await structuredCall<{ id: string; score: number }[]>(
      model,
      `${profile}\n\nRate how likely this user wants to read each item, 0.0 (skip) to 1.0 (must-read).\nItems:\n${list}\n\nReturn JSON array: [{ "id": <the leading number>, "score": <0..1> }] for every item.`,
      'You rank news/articles by how well they match a user profile.',
    )
  } catch {
    return out // model unavailable — leave unscored
  }

  const now = new Date()
  for (const s of Array.isArray(scored) ? scored : []) {
    const idx = Number(s.id)
    const item = todo[idx]
    if (!item || typeof s.score !== 'number') continue
    const score = Math.max(0, Math.min(1, s.score))
    out.set(item.id, score)
    await db.insert(feedItemScores).values({ id: crypto.randomUUID(), userId, itemId: item.id, score, reason: null, scoredAt: now }).onConflictDoNothing()
  }
  return out
}
