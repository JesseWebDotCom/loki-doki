import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { bookmarkTags, bookmarkItemTags, userPreferences } from '@/db/schema'
import { autoTagArticle } from '@/lib/bookmarks/ai'
import { logger } from '@/lib/logger'

// Unified capture auto-organization (#7): when something is saved (a bookmark/article),
// tag it with the local model automatically, so a family's saves get filed with zero effort
// instead of auto-tag being an opt-in per action. Best-effort and detached: never blocks the
// save, never throws, and never overrides tags the user already set.

const AUTO_ORGANIZE_PREF = 'capture.autoOrganize'

/** Default ON. A stored `false` disables it for that user. */
async function isAutoOrganizeEnabled(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, AUTO_ORGANIZE_PREF)))
    .limit(1)
  if (!row) return true
  try { return JSON.parse(row.value) !== false } catch { return true }
}

// Tag names -> ids for this owner, creating any that don't exist (mirrors the bookmarks route
// helper; kept local so this lib doesn't import the route and risk a cycle).
async function resolveTagIds(ownerId: string, names: string[]): Promise<string[]> {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
  if (!clean.length) return []
  const existing = await db.select().from(bookmarkTags)
    .where(and(eq(bookmarkTags.ownerId, ownerId), inArray(bookmarkTags.name, clean)))
  const byName = new Map(existing.map((t) => [t.name, t.id]))
  const out: string[] = []
  for (const name of clean) {
    let id = byName.get(name)
    if (!id) { id = crypto.randomUUID(); await db.insert(bookmarkTags).values({ id, ownerId, name }) }
    out.push(id)
  }
  return out
}

/**
 * Auto-tag a freshly-captured bookmark. Runs only when auto-organize is enabled (default) and
 * the item has no tags yet. Prefers the owner's existing tag vocabulary for consistency, else
 * generates fresh tags. Safe to call detached (void); it swallows its own errors.
 */
export async function organizeCaptured(opts: {
  userId: string
  bookmarkId: string
  title: string
  text: string | null | undefined
}): Promise<void> {
  const { userId, bookmarkId, title, text } = opts
  try {
    if (!text || text.length < 200) return // too little readable text to tag meaningfully
    if (!(await isAutoOrganizeEnabled(userId))) return

    // Never override tags the user already applied.
    const existing = await db.select({ tagId: bookmarkItemTags.tagId })
      .from(bookmarkItemTags).where(eq(bookmarkItemTags.itemId, bookmarkId))
    if (existing.length) return

    const userTags = (await db.select({ name: bookmarkTags.name }).from(bookmarkTags)
      .where(eq(bookmarkTags.ownerId, userId))).map((t) => t.name)
    const tags = userTags.length
      ? await autoTagArticle(title, text, { mode: 'existing', candidates: userTags })
      : await autoTagArticle(title, text, { mode: 'generate' })
    if (!tags.length) return

    const tagIds = await resolveTagIds(userId, tags)
    for (const tid of tagIds) {
      await db.insert(bookmarkItemTags).values({ itemId: bookmarkId, tagId: tid }).catch(() => {})
    }
    logger.info(`[capture] auto-organized ${bookmarkId} with ${tagIds.length} tag(s)`)
  } catch (err) {
    logger.warn(`[capture] auto-organize failed for ${bookmarkId}: ${err}`)
  }
}
