// Smart shelves: saved AND/OR filter rules over the user's library, evaluated at
// read time (Kavita smart-filters / BookLore magic-shelves). Rules are evaluated in
// JS over listLibrary()'s items — household libraries are small, and it keeps the
// field set identical to what the UI already renders. Pinned shelves surface in the
// Books nav.

import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { bookShelves } from '@/db/schema'
import { listLibrary, type BookListItem } from './library'

export type ShelfField = 'title' | 'author' | 'contentType' | 'sourceType' | 'status' | 'format' | 'finished'
export type ShelfOp = 'contains' | 'is' | 'isNot'
export interface ShelfRule { field: ShelfField; op: ShelfOp; value: string }
export interface ShelfRules { match: 'all' | 'any'; rules: ShelfRule[] }

export interface Shelf {
  id: string; name: string; icon: string | null; rules: ShelfRules; pinned: boolean; sortOrder: number
}

function parseRules(json: string): ShelfRules {
  try {
    const parsed = JSON.parse(json) as Partial<ShelfRules>
    return { match: parsed.match === 'any' ? 'any' : 'all', rules: Array.isArray(parsed.rules) ? parsed.rules : [] }
  } catch { return { match: 'all', rules: [] } }
}

function fieldValue(item: BookListItem, field: ShelfField): string {
  switch (field) {
    case 'title': return item.title ?? ''
    case 'author': return item.author ?? ''
    case 'contentType': return item.contentType ?? ''
    case 'sourceType': return item.sourceType ?? ''
    case 'status': return item.libraryStatus ?? ''
    case 'format': return [item.hasEbook ? 'ebook' : '', item.hasAudio ? 'audio' : ''].filter(Boolean).join(' ')
    case 'finished': return item.progress?.completed ? 'yes' : 'no'
  }
}

function ruleMatches(item: BookListItem, rule: ShelfRule): boolean {
  const actual = fieldValue(item, rule.field).toLowerCase()
  const want = (rule.value ?? '').toLowerCase().trim()
  if (rule.op === 'contains') return actual.includes(want)
  if (rule.op === 'is') return actual === want
  return actual !== want // isNot
}

export function matchesShelf(item: BookListItem, rules: ShelfRules): boolean {
  if (!rules.rules.length) return true
  return rules.match === 'any'
    ? rules.rules.some((r) => ruleMatches(item, r))
    : rules.rules.every((r) => ruleMatches(item, r))
}

function toShelf(row: typeof bookShelves.$inferSelect): Shelf {
  return { id: row.id, name: row.name, icon: row.icon, rules: parseRules(row.rulesJson), pinned: row.pinned, sortOrder: row.sortOrder }
}

export async function listShelves(userId: string): Promise<Shelf[]> {
  const rows = await db.select().from(bookShelves).where(eq(bookShelves.userId, userId)).orderBy(asc(bookShelves.sortOrder), asc(bookShelves.createdAt))
  return rows.map(toShelf)
}

export async function createShelf(userId: string, input: { name: string; icon?: string | null; rules: ShelfRules; pinned?: boolean }): Promise<Shelf> {
  const now = new Date()
  const id = randomUUID()
  await db.insert(bookShelves).values({
    id, userId, name: input.name.slice(0, 80), icon: input.icon ?? null,
    rulesJson: JSON.stringify(input.rules), pinned: input.pinned ?? false, sortOrder: now.getTime() % 1_000_000, createdAt: now, updatedAt: now,
  })
  const [row] = await db.select().from(bookShelves).where(eq(bookShelves.id, id)).limit(1)
  return toShelf(row!)
}

export async function updateShelf(userId: string, id: string, patch: { name?: string; icon?: string | null; rules?: ShelfRules; pinned?: boolean }): Promise<Shelf | null> {
  const set: Partial<typeof bookShelves.$inferInsert> = { updatedAt: new Date() }
  if (patch.name !== undefined) set.name = patch.name.slice(0, 80)
  if (patch.icon !== undefined) set.icon = patch.icon
  if (patch.rules !== undefined) set.rulesJson = JSON.stringify(patch.rules)
  if (patch.pinned !== undefined) set.pinned = patch.pinned
  await db.update(bookShelves).set(set).where(and(eq(bookShelves.id, id), eq(bookShelves.userId, userId)))
  const [row] = await db.select().from(bookShelves).where(and(eq(bookShelves.id, id), eq(bookShelves.userId, userId))).limit(1)
  return row ? toShelf(row) : null
}

export async function deleteShelf(userId: string, id: string): Promise<void> {
  await db.delete(bookShelves).where(and(eq(bookShelves.id, id), eq(bookShelves.userId, userId)))
}

/** Resolve a shelf's current contents from the user's library. */
export async function resolveShelf(userId: string, id: string): Promise<{ shelf: Shelf; items: BookListItem[] } | null> {
  const [row] = await db.select().from(bookShelves).where(and(eq(bookShelves.id, id), eq(bookShelves.userId, userId))).limit(1)
  if (!row) return null
  const shelf = toShelf(row)
  const library = await listLibrary(userId)
  return { shelf, items: library.filter((item) => matchesShelf(item, shelf.rules)) }
}
