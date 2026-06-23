import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  readerItems,
  readerCollections,
  readerTags,
  readerItemTags,
  userPreferences,
} from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { safeFetch } from '@/lib/ssrfGuard'
import { enqueueArchiveArticle, enqueueReaderThumbnail } from '@/lib/downloadJobs'
import { stripHtml } from '@/lib/content/extract'
import { summarizeArticle, askArticle } from '@/lib/reader/ai'
import { dataDir } from '@/lib/download'
import { ARCHIVE_ROOT } from '@/lib/reader/snapshot'
import { renderedHtmlPath } from '@/lib/reader/archive'
import { join, normalize, dirname } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import type { AppEnv } from '@/types'

const readerRouter = new Hono<AppEnv>()

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
  const existing = await db.select().from(readerTags)
    .where(and(eq(readerTags.ownerId, ownerId), inArray(readerTags.name, clean)))
  const byName = new Map(existing.map((t) => [t.name, t.id]))
  const out: string[] = []
  for (const name of clean) {
    let id = byName.get(name)
    if (!id) {
      id = crypto.randomUUID()
      await db.insert(readerTags).values({ id, ownerId, name })
    }
    out.push(id)
  }
  return out
}

async function setItemTags(itemId: string, tagIds: string[]): Promise<void> {
  await db.delete(readerItemTags).where(eq(readerItemTags.itemId, itemId))
  for (const tagId of tagIds) await db.insert(readerItemTags).values({ itemId, tagId })
}

// Attach a `tags: string[]` field to a set of items in one round-trip.
async function tagsByItem(itemIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!itemIds.length) return out
  const rows = await db
    .select({ itemId: readerItemTags.itemId, name: readerTags.name })
    .from(readerItemTags)
    .innerJoin(readerTags, eq(readerItemTags.tagId, readerTags.id))
    .where(inArray(readerItemTags.itemId, itemIds))
  for (const r of rows) {
    const list = out.get(r.itemId) ?? []
    list.push(r.name)
    out.set(r.itemId, list)
  }
  return out
}

async function findCollectionId(ownerId: string, name: string): Promise<string> {
  const trimmed = name.trim()
  const existing = await db.select().from(readerCollections)
    .where(and(eq(readerCollections.ownerId, ownerId), eq(readerCollections.name, trimmed)))
    .then((r) => r[0])
  if (existing) return existing.id
  const id = crypto.randomUUID()
  await db.insert(readerCollections).values({ id, ownerId, name: trimmed, sortOrder: 0, createdAt: new Date() })
  return id
}

/** Promote a saved feed item into the user's Reader library (source='feed'). Called by
 *  the Feeds save handler. Idempotent per (ownerId, sourceRef). */
export async function promoteToReader(
  feedItem: { id: string; url: string | null; title: string | null; contentHtml: string | null; imageUrl: string | null; author: string | null; summary: string | null },
  userId: string,
): Promise<void> {
  if (!feedItem.url) return
  const sourceRef = `feed:${feedItem.id}`
  const existing = await db.select().from(readerItems)
    .where(and(eq(readerItems.ownerId, userId), eq(readerItems.sourceRef, sourceRef)))
    .then((r) => r[0])
  if (existing) return

  const now = new Date()
  const hasContent = !!feedItem.contentHtml
  const text = hasContent ? stripHtml(feedItem.contentHtml!) : null
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0
  const id = crypto.randomUUID()
  await db.insert(readerItems).values({
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
export async function unpromoteFromReader(feedItemId: string, userId: string): Promise<void> {
  await db.delete(readerItems)
    .where(and(eq(readerItems.ownerId, userId), eq(readerItems.sourceRef, `feed:${feedItemId}`)))
}

// ── Probe (favicon / reachability / frame-blocking) ────────────────────────────
// Registered before /:id so "probe" isn't read as an id.

readerRouter.get('/probe', requireAuth, async (c) => {
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

readerRouter.get('/collections', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(readerCollections).where(eq(readerCollections.ownerId, user.id))
  return c.json({ collections: rows })
})

readerRouter.post('/collections', requireAuth, async (c) => {
  const user = c.get('user')
  const { name } = await c.req.json<{ name: string }>()
  if (!name?.trim()) return c.json({ error: 'name required' }, 400)
  const id = await findCollectionId(user.id, name)
  return c.json({ id })
})

readerRouter.patch('/collections/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<Partial<{ name: string; sortOrder: number }>>()
  const existing = await db.select().from(readerCollections)
    .where(and(eq(readerCollections.id, id), eq(readerCollections.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.update(readerCollections).set({
    name: body.name !== undefined ? body.name.trim() : existing.name,
    sortOrder: body.sortOrder !== undefined ? body.sortOrder : existing.sortOrder,
  }).where(eq(readerCollections.id, id))
  return c.json({ ok: true })
})

readerRouter.delete('/collections/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  await db.delete(readerCollections).where(and(eq(readerCollections.id, id), eq(readerCollections.ownerId, user.id)))
  return c.json({ ok: true })
})

// ── Tags ─────────────────────────────────────────────────────────────────────────

readerRouter.get('/tags', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(readerTags).where(eq(readerTags.ownerId, user.id))
  return c.json({ tags: rows })
})

// ── Netscape bookmarks.html import / export (Shiori-style) ──────────────────────

readerRouter.get('/export/html', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(readerItems)
    .where(and(eq(readerItems.ownerId, user.id), eq(readerItems.type, 'live')))
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

readerRouter.post('/import/html', requireAuth, async (c) => {
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
    await db.insert(readerItems).values({
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

// ── List (global + own; filters: status, collectionId, tag, q) ──────────────────

readerRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const { status, collectionId, tag, q, type } = c.req.query()

  const conds = [or(isNull(readerItems.ownerId), eq(readerItems.ownerId, user.id))]
  if (status) conds.push(eq(readerItems.status, status as 'unread' | 'reading' | 'archived'))
  if (type) conds.push(eq(readerItems.type, type as 'live' | 'offline'))
  if (collectionId) conds.push(eq(readerItems.collectionId, collectionId))

  if (tag) {
    const tagRow = await db.select().from(readerTags)
      .where(and(eq(readerTags.ownerId, user.id), eq(readerTags.name, tag))).then((r) => r[0])
    if (!tagRow) return c.json({ items: [] })
    const tagged = await db.select({ itemId: readerItemTags.itemId }).from(readerItemTags)
      .where(eq(readerItemTags.tagId, tagRow.id))
    const ids = tagged.map((t) => t.itemId)
    if (!ids.length) return c.json({ items: [] })
    conds.push(inArray(readerItems.id, ids))
  }

  if (q) {
    const match = buildMatch(q)
    if (!match) return c.json({ items: [] })
    conds.push(sql`reader_items.rowid IN (SELECT rowid FROM reader_items_fts WHERE reader_items_fts MATCH ${match})`)
  }

  const rows = await db.select().from(readerItems).where(and(...conds)).orderBy(desc(readerItems.createdAt))
  const hidden = await hiddenIdsFor(user.id)
  const tagMap = await tagsByItem(rows.map((r) => r.id))

  return c.json({
    items: rows.map((r) => ({
      ...r,
      contentHtml: undefined, // omit heavy field from list
      contentText: undefined,
      tags: tagMap.get(r.id) ?? [],
      isGlobal: r.ownerId === null,
      canEdit: r.ownerId === user.id,
      isHidden: r.ownerId === null && hidden.includes(r.id),
    })),
  })
})

// ── Create (live = immediate; offline = enqueue archive job) ────────────────────

readerRouter.post('/', requireAuth, async (c) => {
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
  }>()
  if (!body.url?.trim()) return c.json({ error: 'url required' }, 400)
  const type = body.type === 'offline' ? 'offline' : 'live'

  let collectionId = body.collectionId ?? null
  if (!collectionId && body.collectionName) collectionId = await findCollectionId(user.id, body.collectionName)

  const now = new Date()
  const id = crypto.randomUUID()
  await db.insert(readerItems).values({
    id, ownerId: user.id, source: type === 'offline' ? 'article' : 'bookmark', sourceRef: null, type,
    url: body.url.trim(), title: body.title?.trim() || body.url.trim(),
    byline: null, siteName: null, faviconUrl: body.faviconUrl ?? null, excerpt: null,
    contentHtml: null, contentText: null, wordCount: 0, readingMins: 0,
    status: 'unread', archiveState: type === 'offline' ? 'pending' : 'none', archiveError: null, readAt: null,
    useProxy: body.useProxy ?? false, useEmbed: body.useEmbed ?? false,
    category: body.category?.trim() || 'Other', collectionId, sortOrder: 0,
    screenshotPath: null, snapshotPath: null, ogImagePath: null, isAdult: false,
    createdAt: now, updatedAt: now,
  })

  if (body.tags?.length) await setItemTags(id, await resolveTagIds(user.id, body.tags))
  // Offline → full archive (server-renders + screenshots); live → screenshot thumbnail only.
  if (type === 'offline') await enqueueArchiveArticle(id, body.title?.trim() || body.url.trim())
  else await enqueueReaderThumbnail(id, body.title?.trim() || body.url.trim())

  const item = await db.select().from(readerItems).where(eq(readerItems.id, id)).then((r) => r[0])
  return c.json({ item })
})

// ── Get one (full content) ──────────────────────────────────────────────────────

readerRouter.get('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(readerItems)
    .where(and(eq(readerItems.id, id), or(isNull(readerItems.ownerId), eq(readerItems.ownerId, user.id))))
    .then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)
  const tagMap = await tagsByItem([id])
  return c.json({ item: { ...item, tags: tagMap.get(id) ?? [], isGlobal: item.ownerId === null, canEdit: item.ownerId === user.id } })
})

// ── Serve full-page offline snapshot (index.html + assets/*) ─────────────────────
// The reader's "Full page" iframe and the reader view's localized <img> tags both load
// from here. Same-origin GET → the session cookie authenticates automatically.

const SNAPSHOT_CT: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
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

readerRouter.get('/:id/archive/*', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(readerItems)
    .where(and(eq(readerItems.id, id), or(isNull(readerItems.ownerId), eq(readerItems.ownerId, user.id))))
    .then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)

  // Subpath after `/archive/`; default to index.html. Reject traversal. Files live under
  // reader-archive/<id>/ regardless of snapshotPath (thumbnails exist for live items too).
  const path = new URL(c.req.url).pathname
  let sub = decodeURIComponent(path.split(`/${id}/archive/`)[1] ?? '') || 'index.html'
  sub = normalize(sub).replace(/^(\.\.(\/|\\|$))+/, '')
  if (sub.includes('..')) return c.json({ error: 'Forbidden' }, 403)

  const baseDir = join(dataDir, ARCHIVE_ROOT, id)
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

readerRouter.post('/:id/thumbnail', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(readerItems)
    .where(and(eq(readerItems.id, id), eq(readerItems.ownerId, user.id))).then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)

  const buf = Buffer.from(await c.req.arrayBuffer())
  if (buf.length === 0 || buf.length > MAX_THUMB_BYTES) return c.json({ error: 'Bad image' }, 400)
  if (!(buf[0] === 0x89 && buf[1] === 0x50)) return c.json({ error: 'Expected PNG' }, 400) // PNG magic

  const dir = join(dataDir, ARCHIVE_ROOT, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'thumb.png'), buf)
  await db.update(readerItems).set({ ogImagePath: 'thumb.png', updatedAt: new Date() }).where(eq(readerItems.id, id))
  return c.json({ ok: true })
})

// ── Client-rendered page → faithful offline archive ──────────────────────────────
// The frontend posts the fully-rendered DOM (JS executed in the user's browser via the
// proxy iframe, URLs de-proxied back to their origins). We stash it and (re)enqueue the
// archive job, which localizes assets off the rendered HTML instead of a static fetch.

const MAX_RENDERED_BYTES = 25 * 1024 * 1024

readerRouter.post('/:id/snapshot', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(readerItems)
    .where(and(eq(readerItems.id, id), eq(readerItems.ownerId, user.id))).then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)

  const { html } = await c.req.json<{ html?: string }>()
  if (!html || html.length > MAX_RENDERED_BYTES) return c.json({ error: 'Bad html' }, 400)

  const p = renderedHtmlPath(id)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, html, 'utf8')
  await db.update(readerItems)
    .set({ type: 'offline', archiveState: 'pending', archiveError: null, updatedAt: new Date() })
    .where(eq(readerItems.id, id))
  await enqueueArchiveArticle(id, item.title || item.url)
  return c.json({ ok: true })
})

// ── Update own item ──────────────────────────────────────────────────────────────

readerRouter.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<Partial<{
    title: string; status: 'unread' | 'reading' | 'archived'; collectionId: string | null
    tags: string[]; category: string; useProxy: boolean; useEmbed: boolean; sortOrder: number
  }>>()
  const existing = await db.select().from(readerItems)
    .where(and(eq(readerItems.id, id), eq(readerItems.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.update(readerItems).set({
    title: body.title !== undefined ? body.title.trim() : existing.title,
    status: body.status ?? existing.status,
    readAt: body.status === 'reading' || body.status === 'archived' ? (existing.readAt ?? new Date()) : existing.readAt,
    collectionId: body.collectionId !== undefined ? body.collectionId : existing.collectionId,
    category: body.category !== undefined ? body.category.trim() : existing.category,
    useProxy: body.useProxy !== undefined ? body.useProxy : existing.useProxy,
    useEmbed: body.useEmbed !== undefined ? body.useEmbed : existing.useEmbed,
    sortOrder: body.sortOrder !== undefined ? body.sortOrder : existing.sortOrder,
    updatedAt: new Date(),
  }).where(eq(readerItems.id, id))

  if (body.tags !== undefined) await setItemTags(id, await resolveTagIds(user.id, body.tags))
  return c.json({ ok: true })
})

// ── Re-archive (manual refresh of an offline item) ──────────────────────────────

readerRouter.post('/:id/rearchive', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const existing = await db.select().from(readerItems)
    .where(and(eq(readerItems.id, id), eq(readerItems.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.update(readerItems).set({ type: 'offline', archiveState: 'pending', archiveError: null, updatedAt: new Date() }).where(eq(readerItems.id, id))
  await enqueueArchiveArticle(id, existing.title || existing.url)
  return c.json({ ok: true })
})

// ── Delete own item ──────────────────────────────────────────────────────────────

readerRouter.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const existing = await db.select().from(readerItems)
    .where(and(eq(readerItems.id, id), eq(readerItems.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.delete(readerItems).where(eq(readerItems.id, id))
  if (existing.snapshotPath) {
    await rm(join(dataDir, existing.snapshotPath), { recursive: true, force: true }).catch(() => {})
  }
  return c.json({ ok: true })
})

// ── AI: summarize (TL;DR + auto-tags) and ask-the-article ───────────────────────

readerRouter.post('/:id/summarize', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(readerItems)
    .where(and(eq(readerItems.id, id), or(isNull(readerItems.ownerId), eq(readerItems.ownerId, user.id)))).then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)
  if (!item.contentText) return c.json({ error: 'No readable text to summarize' }, 422)
  try {
    const { summary, tags } = await summarizeArticle(item.title, item.contentText)
    // Persist the summary as the excerpt and merge in auto-tags (own items only).
    if (item.ownerId === user.id) {
      await db.update(readerItems).set({ excerpt: summary || item.excerpt, updatedAt: new Date() }).where(eq(readerItems.id, id))
      if (tags.length) {
        const tagIds = await resolveTagIds(user.id, tags)
        const current = await db.select({ tagId: readerItemTags.tagId }).from(readerItemTags).where(eq(readerItemTags.itemId, id))
        const have = new Set(current.map((t) => t.tagId))
        for (const tid of tagIds) if (!have.has(tid)) await db.insert(readerItemTags).values({ itemId: id, tagId: tid })
      }
    }
    return c.json({ summary, tags })
  } catch (err) {
    return c.json({ error: 'Summarization failed', detail: String(err) }, 503)
  }
})

readerRouter.post('/:id/ask', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const { question } = await c.req.json<{ question: string }>()
  if (!question?.trim()) return c.json({ error: 'question required' }, 400)
  const item = await db.select().from(readerItems)
    .where(and(eq(readerItems.id, id), or(isNull(readerItems.ownerId), eq(readerItems.ownerId, user.id)))).then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)
  if (!item.contentText) return c.json({ error: 'No readable text' }, 422)
  try {
    return c.json({ answer: await askArticle(item.title, item.contentText, question.trim()) })
  } catch (err) {
    return c.json({ error: 'Ask failed', detail: String(err) }, 503)
  }
})

// ── Hide / unhide a global item (reuses the legacy bookmarks.hidden pref key) ────

readerRouter.put('/hide/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const bm = await db.select().from(readerItems).where(and(eq(readerItems.id, id), isNull(readerItems.ownerId))).then((r) => r[0])
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

readerRouter.delete('/hide/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const pref = await db.select().from(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, 'bookmarks.hidden'))).then((r) => r[0])
  if (!pref) return c.json({ ok: true })
  const updated = (JSON.parse(pref.value) as string[]).filter((x) => x !== id)
  await db.update(userPreferences).set({ value: JSON.stringify(updated), updatedAt: new Date() }).where(eq(userPreferences.id, pref.id))
  return c.json({ ok: true })
})

export { readerRouter as reader }
