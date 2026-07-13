// Notes API — household knowledge base (see schema.ts Notes section).
// Ownership follows the bookmarks convention: ownerId null = household-shared,
// visible to every member, mutable by admins only; non-null = personal, full CRUD
// for the owner. Content lives ONLY here; Home Inventory and Bookmarks surface
// linked notes through note_links (GET /by-target).

import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  notes, notebooks, noteTags, noteItemTags, noteLinks,
  homeDevices, bookmarks,
} from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { createNote } from '@/lib/notes/store'
import { chunkAndEmbedNote } from '@/lib/notes/chunks'
import { invalidateNoteBlocks } from '@/lib/notes/recall'
import type { AppEnv } from '@/types'

const notesRouter = new Hono<AppEnv>()

// ── helpers ────────────────────────────────────────────────────────────────────

// Build an FTS5 MATCH expression (mirrors routes/bookmarks.ts): keep tokens ≥2
// chars, prefix the last token so partial words match as you type.
function buildMatch(q: string): string {
  const tokens = q.toLowerCase().replace(/["*()^:]/g, ' ').split(/\s+/).filter((t) => t.length >= 2)
  if (!tokens.length) return ''
  return tokens.map((t, i) => (i === tokens.length - 1 ? `${t}*` : t)).join(' ')
}

type Scope = { ownerId: string | null }

// Resolve tag names → tag ids in the note's scope (personal notes use the owner's
// tag rows; shared notes use shared-scope rows, ownerId null), creating missing ones.
async function resolveNoteTagIds(scope: Scope, names: string[]): Promise<string[]> {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
  if (!clean.length) return []
  const scopeCond = scope.ownerId === null ? isNull(noteTags.ownerId) : eq(noteTags.ownerId, scope.ownerId)
  const existing = await db.select().from(noteTags).where(and(scopeCond, inArray(noteTags.name, clean)))
  const byName = new Map(existing.map((t) => [t.name, t.id]))
  const out: string[] = []
  for (const name of clean) {
    let id = byName.get(name)
    if (!id) {
      id = crypto.randomUUID()
      await db.insert(noteTags).values({ id, ownerId: scope.ownerId, name })
    }
    out.push(id)
  }
  return out
}

async function setNoteTags(noteId: string, scope: Scope, names: string[]): Promise<void> {
  const tagIds = await resolveNoteTagIds(scope, names)
  await db.delete(noteItemTags).where(eq(noteItemTags.noteId, noteId))
  for (const tagId of tagIds) await db.insert(noteItemTags).values({ noteId, tagId })
  // Denormalized mirror so the notes_fts triggers index tag words.
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
  await db.update(notes).set({ tagsText: clean.join(' ') }).where(eq(notes.id, noteId))
}

async function tagsByNote(noteIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!noteIds.length) return out
  const rows = await db
    .select({ noteId: noteItemTags.noteId, name: noteTags.name })
    .from(noteItemTags)
    .innerJoin(noteTags, eq(noteItemTags.tagId, noteTags.id))
    .where(inArray(noteItemTags.noteId, noteIds))
  for (const r of rows) {
    const list = out.get(r.noteId) ?? []
    list.push(r.name)
    out.set(r.noteId, list)
  }
  return out
}

// Visibility: everyone sees household-shared rows plus their own.
function visibleTo(userId: string) {
  return or(isNull(notes.ownerId), eq(notes.ownerId, userId))
}

function excerptOf(body: string): string {
  const text = body.replace(/[#*`>\-\[\]]/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

// A shared note may only live in a shared notebook (or none); a personal note only
// in its owner's notebook. Returns the validated notebookId or an error string.
async function checkNotebookScope(notebookId: string | null | undefined, noteOwnerId: string | null): Promise<{ ok: true; id: string | null } | { ok: false }> {
  if (!notebookId) return { ok: true, id: null }
  const nb = await db.select().from(notebooks).where(eq(notebooks.id, notebookId)).then((r) => r[0])
  if (!nb) return { ok: false }
  if (nb.ownerId !== noteOwnerId) return { ok: false }
  return { ok: true, id: nb.id }
}

async function resolveLinkTitles(links: { id: string; targetType: string; targetId: string }[]) {
  const deviceIds = links.filter((l) => l.targetType === 'device').map((l) => l.targetId)
  const bookmarkIds = links.filter((l) => l.targetType === 'bookmark').map((l) => l.targetId)
  const devices = deviceIds.length
    ? await db.select({ id: homeDevices.id, name: homeDevices.name }).from(homeDevices).where(inArray(homeDevices.id, deviceIds))
    : []
  const marks = bookmarkIds.length
    ? await db.select({ id: bookmarks.id, title: bookmarks.title, url: bookmarks.url }).from(bookmarks).where(inArray(bookmarks.id, bookmarkIds))
    : []
  const deviceName = new Map(devices.map((d) => [d.id, d.name]))
  const markTitle = new Map(marks.map((m) => [m.id, m.title || m.url]))
  return links.map((l) => ({
    ...l,
    targetTitle: (l.targetType === 'device' ? deviceName.get(l.targetId) : markTitle.get(l.targetId)) ?? null,
  }))
}

// ── Notebooks (static paths before /:id) ────────────────────────────────────────

notesRouter.get('/notebooks', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(notebooks)
    .where(or(isNull(notebooks.ownerId), eq(notebooks.ownerId, user.id)))
    .orderBy(notebooks.sortOrder, notebooks.name)
  return c.json({
    notebooks: rows.map((r) => ({
      ...r,
      isShared: r.ownerId === null,
      canEdit: r.ownerId === user.id || user.role === 'admin',
    })),
  })
})

notesRouter.post('/notebooks', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ name: string; icon?: string; color?: string; makeShared?: boolean }>()
  if (!body.name?.trim()) return c.json({ error: 'name required' }, 400)
  const ownerId = (user.role === 'admin' && body.makeShared) ? null : user.id
  const row = {
    id: crypto.randomUUID(),
    ownerId,
    name: body.name.trim(),
    icon: body.icon ?? null,
    color: body.color ?? null,
    sortOrder: 0,
    createdAt: new Date(),
  }
  await db.insert(notebooks).values(row)
  return c.json({ notebook: { ...row, isShared: ownerId === null, canEdit: true } })
})

notesRouter.patch('/notebooks/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const isAdmin = user.role === 'admin'
  const existing = await db.select().from(notebooks)
    .where(and(eq(notebooks.id, id), isAdmin ? undefined : eq(notebooks.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json<Partial<{ name: string; icon: string | null; color: string | null; sortOrder: number; makeShared: boolean }>>()
  // Scope flip is admin-only, mirroring notes. Sharing a notebook does NOT share its
  // notes; out-of-scope notes just fall out of it on their next save (scope rule).
  const ownerId = (isAdmin && body.makeShared !== undefined)
    ? (body.makeShared ? null : user.id)
    : existing.ownerId
  await db.update(notebooks).set({
    name: body.name !== undefined ? body.name.trim() : existing.name,
    icon: body.icon !== undefined ? body.icon : existing.icon,
    color: body.color !== undefined ? body.color : existing.color,
    sortOrder: body.sortOrder !== undefined ? body.sortOrder : existing.sortOrder,
    ownerId,
  }).where(eq(notebooks.id, id))
  return c.json({ ok: true })
})

notesRouter.delete('/notebooks/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const isAdmin = user.role === 'admin'
  const existing = await db.select().from(notebooks)
    .where(and(eq(notebooks.id, id), isAdmin ? undefined : eq(notebooks.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.delete(notebooks).where(eq(notebooks.id, id)) // notes keep living (notebook_id SET NULL)
  return c.json({ ok: true })
})

// ── Tags ─────────────────────────────────────────────────────────────────────────

notesRouter.get('/tags', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({ id: noteTags.id, name: noteTags.name, ownerId: noteTags.ownerId, count: sql<number>`count(${noteItemTags.noteId})` })
    .from(noteTags)
    .leftJoin(noteItemTags, eq(noteItemTags.tagId, noteTags.id))
    .where(or(isNull(noteTags.ownerId), eq(noteTags.ownerId, user.id)))
    .groupBy(noteTags.id)
    .orderBy(noteTags.name)
  return c.json({ tags: rows.filter((r) => r.count > 0).map((r) => ({ name: r.name, count: r.count, isShared: r.ownerId === null })) })
})

// ── Notes linked to an app entity (Home Inventory device sheet, bookmark reader) ──

notesRouter.get('/by-target/:type/:targetId', requireAuth, async (c) => {
  const user = c.get('user')
  const type = c.req.param('type')
  const targetId = c.req.param('targetId')
  if (type !== 'device' && type !== 'bookmark') return c.json({ error: 'Bad target type' }, 400)
  const rows = await db
    .select({ note: notes })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.noteId))
    .where(and(eq(noteLinks.targetType, type), eq(noteLinks.targetId, targetId), visibleTo(user.id)))
    .orderBy(desc(notes.updatedAt))
  return c.json({
    items: rows.map(({ note }) => ({
      id: note.id,
      title: note.title,
      excerpt: excerptOf(note.body),
      isShared: note.ownerId === null,
      canEdit: note.ownerId === user.id || user.role === 'admin',
      updatedAt: note.updatedAt,
    })),
  })
})

// ── List ─────────────────────────────────────────────────────────────────────────

notesRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const { notebookId, tag, scope, pinned, q } = c.req.query()

  const conds = [visibleTo(user.id)]
  if (scope === 'personal') conds.push(eq(notes.ownerId, user.id))
  if (scope === 'household') conds.push(isNull(notes.ownerId))
  if (notebookId) conds.push(eq(notes.notebookId, notebookId))
  if (pinned === 'true') conds.push(eq(notes.pinned, true))

  if (tag) {
    const tagRows = await db.select().from(noteTags)
      .where(and(or(isNull(noteTags.ownerId), eq(noteTags.ownerId, user.id)), eq(noteTags.name, tag)))
    if (!tagRows.length) return c.json({ items: [] })
    const tagged = await db.select({ noteId: noteItemTags.noteId }).from(noteItemTags)
      .where(inArray(noteItemTags.tagId, tagRows.map((t) => t.id)))
    if (!tagged.length) return c.json({ items: [] })
    conds.push(inArray(notes.id, tagged.map((t) => t.noteId)))
  }

  if (q) {
    const match = buildMatch(q)
    if (!match) return c.json({ items: [] })
    conds.push(sql`notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ${match})`)
  }

  const rows = await db.select().from(notes).where(and(...conds))
    .orderBy(desc(notes.pinned), desc(notes.updatedAt))
  const tagMap = await tagsByNote(rows.map((r) => r.id))
  const nbRows = await db.select({ id: notebooks.id, name: notebooks.name }).from(notebooks)
  const nbName = new Map(nbRows.map((n) => [n.id, n.name]))

  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      excerpt: excerptOf(r.body),
      notebookId: r.notebookId,
      notebookName: r.notebookId ? nbName.get(r.notebookId) ?? null : null,
      tags: tagMap.get(r.id) ?? [],
      pinned: r.pinned,
      source: r.source,
      isShared: r.ownerId === null,
      canEdit: r.ownerId === user.id || user.role === 'admin',
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  })
})

// ── Create ───────────────────────────────────────────────────────────────────────

notesRouter.post('/', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    title?: string
    body?: string
    notebookId?: string | null
    tags?: string[]
    makeShared?: boolean
    links?: { targetType: 'device' | 'bookmark'; targetId: string }[]
  }>()

  // Notes are personal by default; only an admin may create household-shared ones.
  const ownerId = (user.role === 'admin' && body.makeShared) ? null : user.id
  const nb = await checkNotebookScope(body.notebookId, ownerId)
  if (!nb.ok) return c.json({ error: 'Notebook not available for this note' }, 400)

  const note = await createNote({
    ownerId,
    createdBy: user.id,
    title: body.title ?? '',
    body: body.body ?? '',
    notebookId: nb.id,
    source: 'user',
  })
  if (body.tags?.length) await setNoteTags(note.id, { ownerId }, body.tags)
  if (body.links?.length) {
    const now = new Date()
    for (const l of body.links) {
      if (l.targetType !== 'device' && l.targetType !== 'bookmark') continue
      await db.insert(noteLinks).values({ id: crypto.randomUUID(), noteId: note.id, targetType: l.targetType, targetId: l.targetId, createdAt: now })
    }
  }
  return c.json({ item: { ...note, isShared: ownerId === null, canEdit: true } })
})

// ── Get one ──────────────────────────────────────────────────────────────────────

notesRouter.get('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await db.select().from(notes)
    .where(and(eq(notes.id, id), visibleTo(user.id))).then((r) => r[0])
  if (!item) return c.json({ error: 'Not found' }, 404)
  const tagMap = await tagsByNote([id])
  const linkRows = await db.select().from(noteLinks).where(eq(noteLinks.noteId, id))
  const links = await resolveLinkTitles(linkRows)
  return c.json({
    item: {
      ...item,
      tags: tagMap.get(id) ?? [],
      links,
      isShared: item.ownerId === null,
      canEdit: item.ownerId === user.id || user.role === 'admin',
    },
  })
})

// ── Update ───────────────────────────────────────────────────────────────────────

notesRouter.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const isAdmin = user.role === 'admin'
  // Owners edit their own notes; admins may edit anyone's (incl. shared, ownerId null).
  const existing = await db.select().from(notes)
    .where(and(eq(notes.id, id), isAdmin ? undefined : eq(notes.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<Partial<{
    title: string; body: string; notebookId: string | null; tags: string[]
    pinned: boolean; makeShared: boolean
  }>>()

  // Scope change is admin-only: makeShared=true → shared (ownerId null); false → owned
  // by the editing admin. Undefined leaves ownership untouched.
  const ownerId = (isAdmin && body.makeShared !== undefined)
    ? (body.makeShared ? null : user.id)
    : existing.ownerId

  let notebookId = existing.notebookId
  if (body.notebookId !== undefined || ownerId !== existing.ownerId) {
    const nb = await checkNotebookScope(body.notebookId !== undefined ? body.notebookId : existing.notebookId, ownerId)
    // A scope flip silently drops an out-of-scope notebook rather than failing the save.
    notebookId = nb.ok ? nb.id : null
    if (!nb.ok && body.notebookId !== undefined) return c.json({ error: 'Notebook not available for this note' }, 400)
  }

  const contentChanged = (body.title !== undefined && body.title !== existing.title)
    || (body.body !== undefined && body.body !== existing.body)

  await db.update(notes).set({
    title: body.title !== undefined ? body.title.trim() : existing.title,
    body: body.body !== undefined ? body.body : existing.body,
    notebookId,
    pinned: body.pinned !== undefined ? body.pinned : existing.pinned,
    ownerId,
    updatedAt: contentChanged || ownerId !== existing.ownerId ? new Date() : existing.updatedAt,
  }).where(eq(notes.id, id))

  if (body.tags !== undefined) await setNoteTags(id, { ownerId }, body.tags)
  if (contentChanged) void chunkAndEmbedNote(id)
  // Invalidate both scopes on a flip so stale personal blocks don't survive a share.
  invalidateNoteBlocks(ownerId)
  if (ownerId !== existing.ownerId) invalidateNoteBlocks(existing.ownerId)
  return c.json({ ok: true })
})

// ── Links (replace set) ──────────────────────────────────────────────────────────

notesRouter.put('/:id/links', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const isAdmin = user.role === 'admin'
  const existing = await db.select().from(notes)
    .where(and(eq(notes.id, id), isAdmin ? undefined : eq(notes.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<{ links: { targetType: 'device' | 'bookmark'; targetId: string }[] }>()
  await db.delete(noteLinks).where(eq(noteLinks.noteId, id))
  const now = new Date()
  for (const l of body.links ?? []) {
    if (l.targetType !== 'device' && l.targetType !== 'bookmark') continue
    if (!l.targetId) continue
    await db.insert(noteLinks).values({ id: crypto.randomUUID(), noteId: id, targetType: l.targetType, targetId: l.targetId, createdAt: now })
  }
  const links = await resolveLinkTitles(await db.select().from(noteLinks).where(eq(noteLinks.noteId, id)))
  return c.json({ links })
})

// ── Delete ───────────────────────────────────────────────────────────────────────

notesRouter.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const isAdmin = user.role === 'admin'
  const existing = await db.select().from(notes)
    .where(and(eq(notes.id, id), isAdmin ? undefined : eq(notes.ownerId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.delete(notes).where(eq(notes.id, id)) // chunks/tags/links cascade
  invalidateNoteBlocks(existing.ownerId)
  return c.json({ ok: true })
})

export { notesRouter }
