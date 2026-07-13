// Collection RSS ingest — a bookmark collection can subscribe to an RSS/Atom feed
// (bookmarkCollections.rssUrl); the poller fetches it on a cadence and auto-saves new
// entries as Live bookmarks into that collection, deduped per (owner, sourceRef). This is
// Linkwarden's "follow an RSS feed inside a collection" feature, reusing the Feeds parser.

import { and, eq, isNotNull } from 'drizzle-orm'
import { db } from '@/db'
import { bookmarks, bookmarkCollections, bookmarkItemTags } from '@/db/schema'
import { safeFetch } from '@/lib/ssrfGuard'
import { parseFeedXml } from '@/lib/feeds/parse'
import { autoTagArticle } from '@/lib/bookmarks/ai'

const POLL_INTERVAL_MS = 30 * 60 * 1000     // re-check every 30 min
const FRESH_MS = 25 * 60 * 1000             // skip feeds fetched within the last 25 min
const MAX_PER_FETCH = 25                    // cap new saves per feed per run

async function ingestCollection(col: typeof bookmarkCollections.$inferSelect): Promise<void> {
  if (!col.rssUrl || !col.ownerId) return
  let xml: string
  try {
    const res = await safeFetch(col.rssUrl, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } }, { timeoutMs: 15_000 })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    xml = await res.text()
  } catch (err) {
    console.warn(`[bookmark-rss] fetch failed for "${col.name}":`, err instanceof Error ? err.message : err)
    await db.update(bookmarkCollections).set({ rssLastFetch: new Date() }).where(eq(bookmarkCollections.id, col.id))
    return
  }

  const parsed = parseFeedXml(xml)
  const existing = new Set(
    (await db.select({ sourceRef: bookmarks.sourceRef }).from(bookmarks)
      .where(and(eq(bookmarks.ownerId, col.ownerId), eq(bookmarks.collectionId, col.id)))).map((r) => r.sourceRef).filter(Boolean) as string[],
  )
  const now = new Date()
  let saved = 0
  for (const entry of parsed.entries) {
    if (saved >= MAX_PER_FETCH) break
    if (!entry.url || !/^https?:\/\//i.test(entry.url)) continue
    const sourceRef = `crss:${entry.guid}`
    if (existing.has(sourceRef)) continue
    existing.add(sourceRef)
    const id = crypto.randomUUID()
    await db.insert(bookmarks).values({
      id, ownerId: col.ownerId, source: 'feed', sourceRef, type: 'live',
      url: entry.url, title: entry.title || entry.url, byline: entry.author ?? null, siteName: parsed.title ?? null,
      faviconUrl: null, excerpt: entry.summary ?? null,
      contentHtml: null, contentText: entry.summary ?? null, wordCount: 0, readingMins: 0,
      status: 'unread', archiveState: 'none', archiveError: null, readAt: null,
      useProxy: false, useEmbed: false, category: col.name, collectionId: col.id, sortOrder: 0,
      screenshotPath: null, snapshotPath: null, ogImagePath: null,
      pdfPath: null, mediaPath: null, captureMedia: false, archiveOrgUrl: null,
      isPinned: false, contentKind: 'link', uploadPath: null, isAdult: false,
      createdAt: now, updatedAt: now,
    })
    // Opt-in AI tags off the entry summary (best-effort; skipped when no LLM / no text).
    if (col.rssAutoTag && entry.summary) {
      try {
        const tags = await autoTagArticle(entry.title || entry.url, entry.summary, { mode: 'generate' })
        for (const name of tags) {
          const tagId = await resolveOwnerTag(col.ownerId, name)
          await db.insert(bookmarkItemTags).values({ itemId: id, tagId })
        }
      } catch { /* tagging is best-effort */ }
    }
    saved++
  }
  await db.update(bookmarkCollections).set({ rssLastFetch: now }).where(eq(bookmarkCollections.id, col.id))
  if (saved) console.log(`[bookmark-rss] saved ${saved} new item(s) into "${col.name}"`)
}

// Resolve (create if needed) a tag by name for an owner. Local to avoid importing the route.
async function resolveOwnerTag(ownerId: string, name: string): Promise<string> {
  const { bookmarkTags } = await import('@/db/schema')
  const clean = name.trim()
  const existing = await db.select().from(bookmarkTags)
    .where(and(eq(bookmarkTags.ownerId, ownerId), eq(bookmarkTags.name, clean))).then((r) => r[0])
  if (existing) return existing.id
  const id = crypto.randomUUID()
  await db.insert(bookmarkTags).values({ id, ownerId, name: clean })
  return id
}

async function tick(): Promise<void> {
  const cols = await db.select().from(bookmarkCollections).where(isNotNull(bookmarkCollections.rssUrl))
  const cutoff = Date.now() - FRESH_MS
  for (const col of cols) {
    if (col.rssLastFetch && col.rssLastFetch.getTime() > cutoff) continue
    await ingestCollection(col).catch((err) => console.warn('[bookmark-rss] tick error:', err))
  }
}

let started = false
export function startBookmarkCollectionRssPoller(): void {
  if (started) return
  started = true
  // First pass shortly after boot, then on a fixed cadence.
  setTimeout(() => { void tick() }, 45_000)
  setInterval(() => { void tick() }, POLL_INTERVAL_MS)
}

/** Fetch one collection's feed right now (called when a user first sets/edits its rssUrl). */
export async function ingestCollectionNow(collectionId: string): Promise<void> {
  const col = await db.select().from(bookmarkCollections).where(eq(bookmarkCollections.id, collectionId)).then((r) => r[0])
  if (col?.rssUrl) await ingestCollection(col)
}
