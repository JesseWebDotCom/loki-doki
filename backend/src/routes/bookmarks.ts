import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  bookmarks,
  bookmarkCollections,
  bookmarkTags,
  bookmarkItemTags,
  bookmarkSnapshots,
  bookmarkHighlights,
  userPreferences,
} from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { safeFetch } from '@/lib/ssrfGuard'
import { enqueueArchiveArticle, enqueueBookmarkThumbnail } from '@/lib/downloadJobs'
import { stripHtml } from '@/lib/content/extract'
import { summarizeArticle, askArticle } from '@/lib/bookmarks/ai'
import { dataDir } from '@/lib/download'
import { BOOKMARK_ARCHIVE_ROOT } from '@/lib/bookmarks/snapshot'
import { renderedHtmlPath } from '@/lib/bookmarks/archive'
import { createBookmark } from '@/lib/bookmarks/create'
import { WATCH_MODES, type WatchMode } from '@/lib/bookmarks/watch'
import { join, normalize, dirname } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import type { AppEnv } from '@/types'

const bookmarksRouter = new Hono<AppEnv>()

// ── helpers ────────────────────────────────────────────────────────────────────

// Build an FTS5 MATCH expression: drop control chars, keep tokens ≥2 chars, prefix
// the last token so a partial word matches as you type. Empty → no usable query.
function buildMatch(q: string): string {
  const tokens = q.toLowerCase().replace(/["*()^:]/g, ' ').split(/\s+/).filter((t) => t.length >= 2)
  if (!tokens.length) return ''
  return tokens.map((t, i) => (i === tokens.length - 1 ? `${t}*` : t)).join(' ')
}

async function hiddenIdsFor(userId: string): Promise<string[]> {
  const pref = await db.select().from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'bookmarks.hidden')))
    .then((r) => r[0])
  return pref ? JSON.parse(pref.value) : []
}

// Resolve tag names → tag ids for this owner, creating any that don't exist.
async function resolveTagIds(ownerId: string, names: string[]): Promise<string[]> {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
  if (!clean.length) return []
  const existing = await db.select().from(bookmarkTags)
    .where(and(eq(bookmarkTags.ownerId, ownerId), inArray(bookmarkTags.name, clean)))
  const byName = new Map(existing.map((t) => [t.name, t.id]))
  const out: string[] = []
  for (const name of clean) {
    let id = byName.get(name)
    if (!id) {
      id = crypto.randomUUID()
      await db.insert(bookmarkTags).values({ id, ownerId, name })
    }
    out.push(id)
  }
  return out
}

async function setItemTags(itemId: string, tagIds: string[]): Promise<void> {
  await db.delete(bookmarkItemTags).where(eq(bookmarkItemTags.itemId, itemId))
  for (const tagId of tagIds) await db.insert(bookmarkItemTags).values({ itemId, tagId })
}

// Attach a `tags: string[]` field to a set of items in one round-trip.
async function tagsByItem(itemIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!itemIds.length) return out
  const rows = await db
    .select({ itemId: bookmarkItemTags.itemId, name: bookmarkTags.name })
    .from(bookmarkItemTags)
    .innerJoin(bookmarkTags, eq(bookmarkItemTags.tagId, bookmarkTags.id))
    .where(inArray(bookmarkItemTags.itemId, itemIds))
  for (const r of rows) {
    const list = out.get(r.itemId) ?? []
    list.push(r.name)
    out.set(r.itemId, list)
  }
  return out
}

async function findCollectionId(ownerId: string, name: string): Promise<string> {
  const trimmed = name.trim()
  const existing = await db.select().from(bookmarkCollections)
    .where(and(eq(bookmarkCollections.ownerId, ownerId), eq(bookmarkCollections.name, trimmed)))
    .then((r) => r[0])
  if (existing) return existing.id
  const id = crypto.randomUUID()
  await db.insert(bookmarkCollections).values({ id, ownerId, name: trimmed, sortOrder: 0, createdAt: new Date() })
  return id
}

/** Promote a saved feed item into the user's Reader library (source='feed'). Called by
 *  the Feeds save handler. Idempotent per (ownerId, sourceRef). */
export async function promoteToBookmarks(
  feedItem: { id: string; url: string | null; title: string | null; contentHtml: string | null; imageUrl: string | null; author: string | null; summary: string | null },
  userId: string,
): Promise<void> {
  if (!feedItem.url) return
  const sourceRef = `feed:${feedItem.id}`
  const existing = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.ownerId, userId), eq(bookmarks.sourceRef, sourceRef)))
    .then((r) => r[0])
  if (existing) return

  const now = new Date()
  const hasContent = !!feedItem.contentHtml
  const text = hasContent ? stripHtml(feedItem.contentHtml!) : null
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0
  const id = crypto.randomUUID()
  await db.insert(bookmarks).values({
    id,
    ownerId: userId,
    source: 'feed',
    sourceRef,
    type: 'offline',
    url: feedItem.url,
    title: feedItem.title ?? feedItem.url,
    byline: feedItem.author ?? null,
    siteName: null,
    faviconUrl: null,
    excerpt: feedItem.summary ?? (text ? text.slice(0, 280) : null),
    contentHtml: feedItem.contentHtml,
    contentText: text,
    wordCount: words,
    readingMins: words ? Math.max(1, Math.round(words / 200)) : 0,
    status: 'unread',
    archiveState: hasContent ? 'ready' : 'pending',
    archiveError: null,
    readAt: null,
    useProxy: false,
    useEmbed: false,
    category: 'Feeds',
    collectionId: null,
    sortOrder: 0,
    screenshotPath: null,
    snapshotPath: null,
    ogImagePath: null,
    isAdult: false,
    createdAt: now,
    updatedAt: now,
  })
  if (!hasContent) await enqueueArchiveArticle(id, feedItem.title ?? feedItem.url)
}

/** Remove a previously promoted feed item (on unsave). */
export async function unpromoteFromBookmarks(feedItemId: string, userId: string): Promise<void> {
  await db.delete(bookmarks)
    .where(and(eq(bookmarks.ownerId, userId), eq(bookmarks.sourceRef, `feed:${feedItemId}`)))
}

// ── Probe (favicon / reachability / frame-blocking) ────────────────────────────
// Registered before /:id so "probe" isn't read as an id.

bookmarksRouter.get('/probe', requireAuth, async (c) => {
  const url = c.req.query('url')
  if (!url) return c.json({ error: 'url required' }, 400)
  let parsed: URL
  try { parsed = new URL(url) } catch { return c.json({ error: 'Invalid URL' }, 400) }
  if (!['http:', 'https:'].includes(parsed.protocol)) return c.json({ error: 'Only http/https URLs supported' }, 400)

  try {
    const res = await safeFetch(url, { method: 'GET', headers: { accept: 'text/html,*/*', 'user-agent': 'Mozilla/5.0 (compatible)' } }, { timeoutMs: 8_000 })
    const xfo = res.headers.get('x-frame-options')
    const csp = res.headers.get('content-security-policy') ?? ''
    let framesBlocked = !!xfo
    if (!framesBlocked) {
      const fa = csp.match(/frame-ancestors\s+([^;]+)/i)
      if (fa) framesBlocked = !(fa[1] ?? '').includes('*')
    }
    let faviconUrl: string | null = null
    const origin = new URL(url).origin
    let pageTitle: string | null = null
    if ((res.headers.get('content-type') ?? '').includes('text/html')) {
      const html = await res.text()
      const m =
        html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i) ??
        html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i)
      if (m) { try { faviconUrl = new URL(m[1] ?? '', origin).href } catch {} }
      const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
      if (tm) pageTitle = stripHtml(tm[1] ?? '').slice(0, 200) || null
    }
    if (!faviconUrl) {
      try {
        const ico = await safeFetch(`${origin}/favicon.ico`, { method: 'HEAD' }, { timeoutMs: 3_000 })
        if (ico.ok) faviconUrl = `${origin}/favicon.ico`
      } catch {}
    }
    return c.json({ reachable: true, framesBlocked, faviconUrl, title: pageTitle })
  } catch {
    return c.json({ reachable: false, framesBlocked: false, faviconUrl: null, title: null })
  }
})

// ── Collections ─────────────────────────────────────────────────────────────────

bookmarksRouter.get('/collections', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(bookmarkCollections).where(eq(bookmarkCollections.ownerId, user.id))
  return c.json({ collections: rows })
})

bookmarksRouter.post('/collections', requireAuth, async (c) => {
  const user = c.get('user')
  const { name } = await c.req.json<{ name: string }>()
  if (!name?.trim()) return c.json({ error: 'name required' }, 400)
  const id = await findCollectionId(user.id, name)
  return c.json({ id })
})

bookmarksRouter.patch('/collections/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<Partial<{ name: string; icon: string | null; color: string | null; sortOrder: number }>>()
  const existing = await db.select().from(bookmarkCollections)
    .where(and(eq(bookmarkCollections.id, id), eq(bookmarkCollections.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.update(bookmarkCollections).set({
    name: body.name !== undefined ? body.name.trim() : existing.name,
    icon: body.icon !== undefined ? body.icon : existing.icon,
    color: body.color !== undefined ? body.color : existing.color,
    sortOrder: body.sortOrder !== undefined ? body.sortOrder : existing.sortOrder,
  }).where(eq(bookmarkCollections.id, id))
  return c.json({ ok: true })
})

bookmarksRouter.delete('/collections/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  await db.delete(bookmarkCollections).where(and(eq(bookmarkCollections.id, id), eq(bookmarkCollections.ownerId, user.id)))
  return c.json({ ok: true })
})

// ── Tags ─────────────────────────────────────────────────────────────────────────

bookmarksRouter.get('/tags', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(bookmarkTags).where(eq(bookmarkTags.ownerId, user.id))
  return c.json({ tags: rows })
})

// ── Netscape bookmarks.html import / export (Shiori-style) ──────────────────────

bookmarksRouter.get('/export/html', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.ownerId, user.id), eq(bookmarks.type, 'live')))
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const lines = rows.map((b) =>
    `        <DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.floor((b.createdAt?.getTime() ?? Date.now()) / 1000)}">${esc(b.title || b.url)}</A>`,
  )
  const html =
    `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n    <DT><H3>Loki Reader</H3>\n    <DL><p>\n${lines.join('\n')}\n    </DL><p>\n</DL><p>\n`
  c.header('Content-Type', 'text/html; charset=utf-8')
  c.header('Content-Disposition', 'attachment; filename="loki-bookmarks.html"')
  return c.body(html)
})

bookmarksRouter.post('/import/html', requireAuth, async (c) => {
  const user = c.get('user')
  const { html } = await c.req.json<{ html: string }>()
  if (!html) return c.json({ error: 'html required' }, 400)

  // Flat parse: each <A HREF> becomes a Live item; the nearest preceding <H3> folder
  // (if any) becomes its collection. Nested folder trees are flattened to one level.
  const collectionCache = new Map<string, string>()
  let currentFolder: string | null = null
  let imported = 0
  const now = new Date()
  // Walk H3/A tokens in document order.
  const tokenRe = /<H3[^>]*>([\s\S]*?)<\/H3>|<A\s+[^>]*HREF=["']([^"']+)["'][^>]*>([\s\S]*?)<\/A>/gi
  for (const m of html.matchAll(tokenRe)) {
    if (m[1] !== undefined) {
      currentFolder = stripHtml(m[1]).trim() || null
      continue
    }
    const url = m[2]
    if (!url || !/^https?:\/\//i.test(url)) continue
    const title = stripHtml(m[3] ?? '').trim() || url
    let collectionId: string | null = null
    if (currentFolder) {
      collectionId = collectionCache.get(currentFolder) ?? null
      if (!collectionId) {
        collectionId = await findCollectionId(user.id, currentFolder)
        collectionCache.set(currentFolder, collectionId)
      }
    }
    await db.insert(bookmarks).values({
      id: crypto.randomUUID(), ownerId: user.id, source: 'bookmark', sourceRef: null, type: 'live',
      url, title, byline: null, siteName: null, faviconUrl: null, excerpt: null,
      contentHtml: null, contentText: null, wordCount: 0, readingMins: 0,
      status: 'unread', archiveState: 'none', archiveError: null, readAt: null,
      useProxy: false, useEmbed: false, category: currentFolder ?? 'Imported', collectionId,
      sortOrder: 0, screenshotPath: null, snapshotPath: null, ogImagePath: null, isAdult: false,
      createdAt: now, updatedAt: now,
    })
    imported++
  }
  return c.json({ imported })
})

// ── Unified import: Netscape HTML, JSON (Pinboard / Pocket / array), or CSV ──────
// One endpoint the import dialog posts to with the raw file text; the format is sniffed
// (or forced). Every entry becomes a Live bookmark, deduped against the user's existing URLs.

type ImportEntry = { url: string; title?: string; tags?: string[]; folder?: string }

function asTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(/[, ]+/).map((s) => s.trim()).filter(Boolean)
  return []
}

function parseNetscape(html: string): ImportEntry[] {
  const out: ImportEntry[] = []
  let folder: string | null = null
  const tokenRe = /<H3[^>]*>([\s\S]*?)<\/H3>|<A\s+([^>]*)HREF=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/A>/gi
  for (const m of html.matchAll(tokenRe)) {
    if (m[1] !== undefined) { folder = stripHtml(m[1]).trim() || null; continue }
    const url = m[3]
    if (!url || !/^https?:\/\//i.test(url)) continue
    const attrs = `${m[2] ?? ''} ${m[4] ?? ''}`
    const tagsAttr = attrs.match(/TAGS=["']([^"']*)["']/i)?.[1]
    out.push({ url, title: stripHtml(m[5] ?? '').trim() || url, tags: asTags(tagsAttr), folder: folder ?? undefined })
  }
  return out
}

function parseJsonImport(text: string): ImportEntry[] {
  const data = JSON.parse(text) as unknown
  // Normalize the various shapes into a flat list of record objects.
  let records: Record<string, unknown>[] = []
  if (Array.isArray(data)) records = data as Record<string, unknown>[]
  else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (obj.list && typeof obj.list === 'object') records = Object.values(obj.list as Record<string, unknown>) as Record<string, unknown>[] // Pocket API
    else if (Array.isArray(obj.bookmarks)) records = obj.bookmarks as Record<string, unknown>[]
    else records = Object.values(obj).filter((v) => v && typeof v === 'object') as Record<string, unknown>[]
  }
  const out: ImportEntry[] = []
  for (const r of records) {
    const url = String(r.url ?? r.href ?? r.uri ?? r.given_url ?? r.resolved_url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    const title = String(r.title ?? r.description ?? r.name ?? r.given_title ?? r.resolved_title ?? '').trim()
    out.push({ url, title: title || url, tags: asTags(r.tags), folder: typeof r.folder === 'string' ? r.folder : undefined })
  }
  return out
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQ = false
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { cells.push(cur); cur = '' }
    else cur += ch
  }
  cells.push(cur)
  return cells.map((s) => s.trim())
}

function parseCsvImport(text: string): ImportEntry[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase())
  const hasHeader = header.some((h) => ['url', 'href', 'link'].includes(h))
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h))
  const urlI = hasHeader ? idx(['url', 'href', 'link']) : 0
  const titleI = hasHeader ? idx(['title', 'name', 'description']) : 1
  const tagsI = hasHeader ? idx(['tags', 'tag']) : -1
  const out: ImportEntry[] = []
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const cells = splitCsvLine(line)
    const url = (cells[urlI] ?? '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    out.push({
      url,
      title: (titleI >= 0 ? cells[titleI] : '')?.trim() || url,
      tags: tagsI >= 0 ? asTags(cells[tagsI]) : [],
    })
  }
  return out
}

async function bulkInsertBookmarks(userId: string, entries: ImportEntry[]): Promise<number> {
  // Dedup against the user's existing bookmark URLs so re-imports don't pile up.
  const existing = new Set(
    (await db.select({ url: bookmarks.url }).from(bookmarks).where(eq(bookmarks.ownerId, userId))).map((r) => r.url),
  )
  const collectionCache = new Map<string, string>()
  let imported = 0
  const now = new Date()
  for (const e of entries) {
    if (existing.has(e.url)) continue
    existing.add(e.url)
    let collectionId: string | null = null
    if (e.folder) {
      collectionId = collectionCache.get(e.folder) ?? null
      if (!collectionId) { collectionId = await findCollectionId(userId, e.folder); collectionCache.set(e.folder, collectionId) }
    }
    const id = crypto.randomUUID()
    await db.insert(bookmarks).values({
      id, ownerId: userId, source: 'bookmark', sourceRef: null, type: 'live',
      url: e.url, title: e.title || e.url, byline: null, siteName: null, faviconUrl: null, excerpt: null,
      contentHtml: null, contentText: null, wordCount: 0, readingMins: 0,
      status: 'unread', archiveState: 'none', archiveError: null, readAt: null,
      useProxy: false, useEmbed: false, category: e.folder ?? 'Imported', collectionId,
      sortOrder: 0, screenshotPath: null, snapshotPath: null, ogImagePath: null, isAdult: false,
      createdAt: now, updatedAt: now,
    })
    if (e.tags?.length) await setItemTags(id, await resolveTagIds(userId, e.tags))
    imported++
  }
  return imported
}

bookmarksRouter.post('/import', requireAuth, async (c) => {
  const user = c.get('user')
  const { data, format = 'auto' } = await c.req.json<{ data: string; format?: 'auto' | 'html' | 'json' | 'csv' }>()
  if (!data?.trim()) return c.json({ error: 'data required' }, 400)
  const text = data.trim()
  const fmt = format !== 'auto' ? format
    : text.startsWith('{') || text.startsWith('[') ? 'json'
    : /<!DOCTYPE NETSCAPE-Bookmark|<DL|<A\s+[^>]*HREF=/i.test(text) ? 'html'
    : 'csv'
  let entries: ImportEntry[]
  try {
    entries = fmt === 'html' ? parseNetscape(text) : fmt === 'json' ? parseJsonImport(text) : parseCsvImport(text)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Could not parse file' }, 400)
  }
  const imported = await bulkInsertBookmarks(user.id, entries)
  return c.json({ imported, parsed: entries.length, format: fmt })
})

// ── List (global + own; filters: status, collectionId, tag, q) ──────────────────

bookmarksRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const { status, collectionId, tag, q, type } = c.req.query()

  const conds = [or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, user.id))]
  if (status) conds.push(eq(bookmarks.status, status as 'unread' | 'reading' | 'archived'))
  if (type) conds.push(eq(bookmarks.type, type as 'live' | 'offline'))
  if (collectionId) conds.push(eq(bookmarks.collectionId, collectionId))

  if (tag) {
    const tagRow = await db.select().from(bookmarkTags)
      .where(and(eq(bookmarkTags.ownerId, user.id), eq(bookmarkTags.name, tag))).then((r) => r[0])
    if (!tagRow) return c.json({ items: [] })
    const tagged = await db.select({ itemId: bookmarkItemTags.itemId }).from(bookmarkItemTags)
      .where(eq(bookmarkItemTags.tagId, tagRow.id))
    const ids = tagged.map((t) => t.itemId)
    if (!ids.length) return c.json({ items: [] })
    conds.push(inArray(bookmarks.id, ids))
  }

  if (q) {
    const match = buildMatch(q)
    if (!match) return c.json({ items: [] })
    conds.push(sql`bookmarks.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ${match})`)
  }

  const rows = await db.select().from(bookmarks).where(and(...conds)).orderBy(desc(bookmarks.createdAt))
  const hidden = await hiddenIdsFor(user.id)
  const tagMap = await tagsByItem(rows.map((r) => r.id))

  return c.json({
    items: rows.map((r) => ({
      ...r,
      contentHtml: undefined, // omit heavy field from list
      contentText: undefined,
      tags: tagMap.get(r.id) ?? [],
      isGlobal: r.ownerId === null,
      canEdit: r.ownerId === user.id || user.role === 'admin',
      isHidden: r.ownerId === null && hidden.includes(r.id),
    })),
  })
})

// ── Create (live = immediate; offline = enqueue archive job) ────────────────────

bookmarksRouter.post('/', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    type?: 'live' | 'offline'
    url: string
    title?: string
    faviconUrl?: string
    collectionId?: string
    collectionName?: string
    tags?: string[]
    category?: string
    useProxy?: boolean
    useEmbed?: boolean
    captureMedia?: boolean
    makeGlobal?: boolean
  }>()
  if (!body.url?.trim()) return c.json({ error: 'url required' }, 400)
  const type = body.type === 'offline' ? 'offline' : 'live'

  // Bookmarks are private to the saver by default. Only an admin may opt to make a save global
  // (ownerId = null → visible to everyone) — e.g. the bookmarklet's "Share with everyone" box.
  const ownerId = (user.role === 'admin' && body.makeGlobal) ? null : user.id

  let collectionId = body.collectionId ?? null
  if (!collectionId && body.collectionName) collectionId = await findCollectionId(user.id, body.collectionName)

  // Insert + archive/thumbnail enqueue live in the shared lib (also used by the
  // Telegram bridge and the companion save_bookmark tool).
  const item = await createBookmark({
    ownerId, url: body.url, title: body.title, type,
    faviconUrl: body.faviconUrl ?? null, collectionId, category: body.category,
    useProxy: body.useProxy, useEmbed: body.useEmbed, captureMedia: body.captureMedia,
  })
  if (body.tags?.length) await setItemTags(item.id, await resolveTagIds(user.id, body.tags))
  return c.json({ item })
})

// ── Get one (full content) ──────────────────────────────────────────────────────

bookmarksRouter.get('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, user.id))))
    .then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)
  const tagMap = await tagsByItem([id])
  return c.json({ item: { ...item, tags: tagMap.get(id) ?? [], isGlobal: item.ownerId === null, canEdit: item.ownerId === user.id || user.role === 'admin' } })
})

// ── Version history (one row per archive capture) ────────────────────────────────

bookmarksRouter.get('/:id/snapshots', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, user.id)))).then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)
  const rows = await db.select({
    id: bookmarkSnapshots.id, capturedAt: bookmarkSnapshots.capturedAt,
    title: bookmarkSnapshots.title, wordCount: bookmarkSnapshots.wordCount, changed: bookmarkSnapshots.changed,
    watchValue: bookmarkSnapshots.watchValue,
  }).from(bookmarkSnapshots).where(eq(bookmarkSnapshots.bookmarkId, id)).orderBy(desc(bookmarkSnapshots.capturedAt))
  return c.json({ snapshots: rows })
})

bookmarksRouter.get('/:id/snapshots/:snapId', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, user.id)))).then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)
  const snap = await db.select().from(bookmarkSnapshots)
    .where(and(eq(bookmarkSnapshots.id, c.req.param('snapId')), eq(bookmarkSnapshots.bookmarkId, id))).then((r) => r[0])
  if (!snap) return c.json({ error: 'Not found' }, 404)
  return c.json({ snapshot: snap })
})

// ── Serve full-page offline snapshot (index.html + assets/*) ─────────────────────
// The reader's "Full page" iframe and the reader view's localized <img> tags both load
// from here. Same-origin GET → the session cookie authenticates automatically.

const SNAPSHOT_CT: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav',
}

// Detect common image types from leading magic bytes (for extensionless saved assets).
function sniffContentType(b: Buffer): string | null {
  if (b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b.toString('ascii', 4, 12) === 'ftypavif') return 'image/avif'
  if (b.toString('ascii', 0, 5) === '<?xml' || b.toString('ascii', 0, 4) === '<svg') return 'image/svg+xml'
  return null
}

bookmarksRouter.get('/:id/archive/*', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, user.id))))
    .then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)

  // Subpath after `/archive/`; default to index.html. Reject traversal. Files live under
  // bookmark-archive/<id>/ regardless of snapshotPath (thumbnails exist for live items too).
  const path = new URL(c.req.url).pathname
  let sub = decodeURIComponent(path.split(`/${id}/archive/`)[1] ?? '') || 'index.html'
  sub = normalize(sub).replace(/^(\.\.(\/|\\|$))+/, '')
  if (sub.includes('..')) return c.json({ error: 'Forbidden' }, 403)

  const baseDir = join(dataDir, BOOKMARK_ARCHIVE_ROOT, id)
  const full = normalize(join(baseDir, sub))
  if (full !== baseDir && !full.startsWith(baseDir + '/')) return c.json({ error: 'Forbidden' }, 403)

  let bytes: Buffer
  try {
    bytes = await readFile(full)
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
  const ext = sub.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? ''
  // Extensionless assets (og:images often have no extension) are saved as .bin → sniff the
  // real type from magic bytes so the browser renders them correctly.
  c.header('Content-Type', SNAPSHOT_CT[ext] ?? sniffContentType(bytes) ?? 'application/octet-stream')
  c.header('Cache-Control', 'private, max-age=86400')
  // Snapshot HTML is sandboxed at the iframe; assets are local-only.
  return c.body(new Uint8Array(bytes))
})

// ── Client-captured screenshot (thumbnail) ───────────────────────────────────────
// The frontend renders the page in a same-origin proxied iframe and rasterizes it to PNG
// (html-to-image), then posts the bytes here. Works for live bookmarks AND offline articles.

const MAX_THUMB_BYTES = 8 * 1024 * 1024

bookmarksRouter.post('/:id/thumbnail', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), eq(bookmarks.ownerId, user.id))).then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)

  const buf = Buffer.from(await c.req.arrayBuffer())
  if (buf.length === 0 || buf.length > MAX_THUMB_BYTES) return c.json({ error: 'Bad image' }, 400)
  if (!(buf[0] === 0x89 && buf[1] === 0x50)) return c.json({ error: 'Expected PNG' }, 400) // PNG magic

  const dir = join(dataDir, BOOKMARK_ARCHIVE_ROOT, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'thumb.png'), buf)
  await db.update(bookmarks).set({ ogImagePath: 'thumb.png', updatedAt: new Date() }).where(eq(bookmarks.id, id))
  return c.json({ ok: true })
})

// ── Client-rendered page → faithful offline archive ──────────────────────────────
// The frontend posts the fully-rendered DOM (JS executed in the user's browser via the
// proxy iframe, URLs de-proxied back to their origins). We stash it and (re)enqueue the
// archive job, which localizes assets off the rendered HTML instead of a static fetch.

const MAX_RENDERED_BYTES = 25 * 1024 * 1024

bookmarksRouter.post('/:id/snapshot', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), eq(bookmarks.ownerId, user.id))).then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)

  const { html } = await c.req.json<{ html?: string }>()
  if (!html || html.length > MAX_RENDERED_BYTES) return c.json({ error: 'Bad html' }, 400)

  const p = renderedHtmlPath(id)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, html, 'utf8')
  await db.update(bookmarks)
    .set({ type: 'offline', archiveState: 'pending', archiveError: null, updatedAt: new Date() })
    .where(eq(bookmarks.id, id))
  await enqueueArchiveArticle(id, item.title || item.url)
  return c.json({ ok: true })
})

// ── Update own item ──────────────────────────────────────────────────────────────

bookmarksRouter.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<Partial<{
    title: string; status: 'unread' | 'reading' | 'archived'; collectionId: string | null
    tags: string[]; category: string; useProxy: boolean; useEmbed: boolean; sortOrder: number
    autoUpdate: boolean; autoUpdateIntervalMins: number | null; alertOnChange: boolean
    captureMedia: boolean; makeGlobal: boolean
    watchSelector: string | null; watchMode: WatchMode; watchKeyword: string | null; watchThreshold: number | null
  }>>()
  const isAdmin = user.role === 'admin'
  // Owners edit their own items; admins may edit anyone's (incl. global items, ownerId null).
  const existing = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), isAdmin ? undefined : eq(bookmarks.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  // Scope change is admin-only: makeGlobal=true → global (ownerId null); false → owned by the
  // editing admin. Undefined leaves ownership untouched.
  const ownerId = (isAdmin && body.makeGlobal !== undefined)
    ? (body.makeGlobal ? null : user.id)
    : existing.ownerId

  const autoUpdate = body.autoUpdate !== undefined ? body.autoUpdate : existing.autoUpdate
  // Turning monitoring ON for an item we've never captured: kick an immediate baseline archive
  // so there's a fingerprint to diff against (and the first poll isn't a full interval away).
  const turnedOn = autoUpdate && !existing.autoUpdate
  const needsBaseline = turnedOn && !existing.contentHash

  await db.update(bookmarks).set({
    title: body.title !== undefined ? body.title.trim() : existing.title,
    status: body.status ?? existing.status,
    readAt: body.status === 'reading' || body.status === 'archived' ? (existing.readAt ?? new Date()) : existing.readAt,
    collectionId: body.collectionId !== undefined ? body.collectionId : existing.collectionId,
    category: body.category !== undefined ? body.category.trim() : existing.category,
    useProxy: body.useProxy !== undefined ? body.useProxy : existing.useProxy,
    useEmbed: body.useEmbed !== undefined ? body.useEmbed : existing.useEmbed,
    sortOrder: body.sortOrder !== undefined ? body.sortOrder : existing.sortOrder,
    autoUpdate,
    autoUpdateIntervalMins: body.autoUpdateIntervalMins !== undefined ? body.autoUpdateIntervalMins : existing.autoUpdateIntervalMins,
    alertOnChange: body.alertOnChange !== undefined ? body.alertOnChange : existing.alertOnChange,
    captureMedia: body.captureMedia !== undefined ? body.captureMedia : existing.captureMedia,
    // Watch conditions: trimmed, empty → null; unknown modes / non-finite thresholds rejected
    // to their previous values. Changing the scope resets the baseline extract so the next
    // capture re-baselines instead of comparing across differently-scoped text.
    watchSelector: body.watchSelector !== undefined ? (body.watchSelector?.trim() || null) : existing.watchSelector,
    watchMode: body.watchMode !== undefined && WATCH_MODES.includes(body.watchMode) ? body.watchMode : existing.watchMode,
    watchKeyword: body.watchKeyword !== undefined ? (body.watchKeyword?.trim() || null) : existing.watchKeyword,
    watchThreshold: body.watchThreshold !== undefined ? (Number.isFinite(body.watchThreshold) ? body.watchThreshold : null) : existing.watchThreshold,
    lastWatchValue: body.watchSelector !== undefined && (body.watchSelector?.trim() || null) !== existing.watchSelector ? null : existing.lastWatchValue,
    ownerId,
    // Stamp lastCheckedAt when enabling so the poller waits a full interval before the *next*
    // refresh (the baseline below covers "now"). Clear it when disabling.
    lastCheckedAt: turnedOn ? new Date() : (autoUpdate ? existing.lastCheckedAt : null),
    updatedAt: new Date(),
  }).where(eq(bookmarks.id, id))

  if (body.tags !== undefined) await setItemTags(id, await resolveTagIds(user.id, body.tags))
  if (needsBaseline) await enqueueArchiveArticle(id, existing.title || existing.url, { force: true })
  return c.json({ ok: true })
})

// ── Re-archive (manual refresh of an offline item) ──────────────────────────────

bookmarksRouter.post('/:id/rearchive', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const existing = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), eq(bookmarks.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.update(bookmarks).set({ type: 'offline', archiveState: 'pending', archiveError: null, updatedAt: new Date() }).where(eq(bookmarks.id, id))
  await enqueueArchiveArticle(id, existing.title || existing.url)
  return c.json({ ok: true })
})

// ── Delete own item ──────────────────────────────────────────────────────────────

bookmarksRouter.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const isAdmin = user.role === 'admin'
  const existing = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), isAdmin ? undefined : eq(bookmarks.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.delete(bookmarks).where(eq(bookmarks.id, id))
  if (existing.snapshotPath) {
    await rm(join(dataDir, existing.snapshotPath), { recursive: true, force: true }).catch(() => {})
  }
  return c.json({ ok: true })
})

// ── AI: summarize (TL;DR + auto-tags) and ask-the-article ───────────────────────

bookmarksRouter.post('/:id/summarize', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, user.id)))).then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)
  if (!item.contentText) return c.json({ error: 'No readable text to summarize' }, 422)
  try {
    const { summary, tags } = await summarizeArticle(item.title, item.contentText)
    // Persist the summary as the excerpt and merge in auto-tags (own items only).
    if (item.ownerId === user.id) {
      await db.update(bookmarks).set({ excerpt: summary || item.excerpt, updatedAt: new Date() }).where(eq(bookmarks.id, id))
      if (tags.length) {
        const tagIds = await resolveTagIds(user.id, tags)
        const current = await db.select({ tagId: bookmarkItemTags.tagId }).from(bookmarkItemTags).where(eq(bookmarkItemTags.itemId, id))
        const have = new Set(current.map((t) => t.tagId))
        for (const tid of tagIds) if (!have.has(tid)) await db.insert(bookmarkItemTags).values({ itemId: id, tagId: tid })
      }
    }
    return c.json({ summary, tags })
  } catch (err) {
    return c.json({ error: 'Summarization failed', detail: String(err) }, 503)
  }
})

bookmarksRouter.post('/:id/ask', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const { question } = await c.req.json<{ question: string }>()
  if (!question?.trim()) return c.json({ error: 'question required' }, 400)
  const item = await db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, user.id)))).then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)
  if (!item.contentText) return c.json({ error: 'No readable text' }, 422)
  try {
    // The reader's own highlights/notes are prime context — what THEY cared about.
    const notes = await db.select().from(bookmarkHighlights)
      .where(and(eq(bookmarkHighlights.bookmarkId, id), eq(bookmarkHighlights.userId, user.id)))
    const noteBlock = notes.length
      ? `Reader's own notes and highlights:\n${notes.map((h) => `- ${h.quote ? `"${h.quote.slice(0, 200)}"` : ''}${h.note ? ` — ${h.note.slice(0, 300)}` : ''}`).join('\n')}\n\n`
      : ''
    // Long articles: retrieve the most relevant embedded chunks instead of letting the
    // model see only a head-truncated slab (a question about page 5 used to hit air).
    // Falls back to the full text when chunks are absent (embeddings unavailable).
    let contextText = item.contentText
    if (item.contentText.length > 8000) {
      const { retrieveBookmarkChunks } = await import('@/lib/bookmarks/chunks')
      const chunks = await retrieveBookmarkChunks(user.id, question.trim(), 6, { bookmarkId: id }).catch(() => [])
      if (chunks.length) {
        contextText = chunks
          .sort((a, b) => a.idx - b.idx) // document order reads better than score order
          .map((ch) => ch.text)
          .join('\n\n[…]\n\n')
      }
    }
    return c.json({ answer: await askArticle(item.title, `${noteBlock}${contextText}`, question.trim()) })
  } catch (err) {
    return c.json({ error: 'Ask failed', detail: String(err) }, 503)
  }
})

// ── Highlights & notes ───────────────────────────────────────────────────────────
// Per-user annotations; visible-bookmark check mirrors GET /:id (own or global).

const HL_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const

async function visibleBookmark(id: string, userId: string) {
  return db.select().from(bookmarks)
    .where(and(eq(bookmarks.id, id), or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, userId))))
    .then((r) => r[0])
}

bookmarksRouter.get('/:id/highlights', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!(await visibleBookmark(id, user.id))) return c.json({ error: 'Not found' }, 404)
  const items = await db.select().from(bookmarkHighlights)
    .where(and(eq(bookmarkHighlights.bookmarkId, id), eq(bookmarkHighlights.userId, user.id)))
    .orderBy(bookmarkHighlights.createdAt)
  return c.json({ items })
})

bookmarksRouter.post('/:id/highlights', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!(await visibleBookmark(id, user.id))) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json<{ kind?: 'highlight' | 'note'; quote?: string; prefix?: string; suffix?: string; color?: string; note?: string }>()
  const kind = body.kind === 'note' ? 'note' : 'highlight'
  const quote = (body.quote ?? '').slice(0, 2000)
  if (kind === 'highlight' && !quote.trim()) return c.json({ error: 'quote required for a highlight' }, 400)
  if (kind === 'note' && !(body.note ?? '').trim()) return c.json({ error: 'note text required' }, 400)
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    bookmarkId: id,
    userId: user.id,
    kind,
    quote,
    prefix: (body.prefix ?? '').slice(0, 64),
    suffix: (body.suffix ?? '').slice(0, 64),
    color: HL_COLORS.includes(body.color as typeof HL_COLORS[number]) ? (body.color as typeof HL_COLORS[number]) : 'yellow',
    note: body.note?.slice(0, 4000) ?? null,
    createdAt: now,
    updatedAt: now,
  } satisfies typeof bookmarkHighlights.$inferInsert
  await db.insert(bookmarkHighlights).values(row)
  return c.json({ item: row })
})

bookmarksRouter.patch('/:id/highlights/:hid', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ color?: string; note?: string | null }>()
  const [existing] = await db.select().from(bookmarkHighlights)
    .where(and(eq(bookmarkHighlights.id, c.req.param('hid')), eq(bookmarkHighlights.userId, user.id)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.update(bookmarkHighlights).set({
    color: body.color !== undefined && HL_COLORS.includes(body.color as typeof HL_COLORS[number]) ? body.color : existing.color,
    note: body.note !== undefined ? (body.note?.slice(0, 4000) ?? null) : existing.note,
    updatedAt: new Date(),
  }).where(eq(bookmarkHighlights.id, existing.id))
  return c.json({ ok: true })
})

bookmarksRouter.delete('/:id/highlights/:hid', requireAuth, async (c) => {
  const user = c.get('user')
  await db.delete(bookmarkHighlights)
    .where(and(eq(bookmarkHighlights.id, c.req.param('hid')), eq(bookmarkHighlights.userId, user.id)))
  return c.json({ ok: true })
})

// ── Hide / unhide a global item (reuses the legacy bookmarks.hidden pref key) ────

bookmarksRouter.put('/hide/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const bm = await db.select().from(bookmarks).where(and(eq(bookmarks.id, id), isNull(bookmarks.ownerId))).then((r) => r[0])
  if (!bm) return c.json({ error: 'Not found' }, 404)
  const now = new Date()
  const pref = await db.select().from(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, 'bookmarks.hidden'))).then((r) => r[0])
  const current: string[] = pref ? JSON.parse(pref.value) : []
  if (!current.includes(id)) current.push(id)
  if (pref) {
    await db.update(userPreferences).set({ value: JSON.stringify(current), updatedAt: now }).where(eq(userPreferences.id, pref.id))
  } else {
    await db.insert(userPreferences).values({ id: crypto.randomUUID(), userId: user.id, key: 'bookmarks.hidden', value: JSON.stringify(current), updatedAt: now })
  }
  return c.json({ ok: true })
})

bookmarksRouter.delete('/hide/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const pref = await db.select().from(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, 'bookmarks.hidden'))).then((r) => r[0])
  if (!pref) return c.json({ ok: true })
  const updated = (JSON.parse(pref.value) as string[]).filter((x) => x !== id)
  await db.update(userPreferences).set({ value: JSON.stringify(updated), updatedAt: new Date() }).where(eq(userPreferences.id, pref.id))
  return c.json({ ok: true })
})

export { bookmarksRouter as bookmarks }
