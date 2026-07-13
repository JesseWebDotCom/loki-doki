// Note create/append shared by the API routes and the companion capture tool
// (tools/memory.ts) — same split as lib/bookmarks/create.ts. Both paths re-embed
// detached and drop the affected recall block caches so a just-saved note is
// recallable on the next companion turn.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { notes } from '@/db/schema'
import { chunkAndEmbedNote } from './chunks'
import { invalidateNoteBlocks } from './recall'

export interface CreateNoteInput {
  ownerId: string | null // null = household-shared (admin-only; routes enforce)
  createdBy: string
  title: string
  body: string
  notebookId?: string | null
  source?: 'user' | 'companion'
  pinned?: boolean
}

export async function createNote(input: CreateNoteInput) {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    ownerId: input.ownerId,
    notebookId: input.notebookId ?? null,
    title: input.title.trim(),
    body: input.body,
    tagsText: '',
    pinned: input.pinned ?? false,
    source: input.source ?? 'user' as const,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(notes).values(row)
  void chunkAndEmbedNote(row.id)
  invalidateNoteBlocks(input.ownerId)
  return row
}

/** Append a dated bullet to an existing note (companion capture "add to note" path). */
export async function appendToNote(noteId: string, fact: string): Promise<void> {
  const [existing] = await db.select({ body: notes.body, ownerId: notes.ownerId })
    .from(notes).where(eq(notes.id, noteId)).limit(1)
  if (!existing) return
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const line = `- ${dateStr}: ${fact}`
  const body = existing.body.trim() ? `${existing.body.replace(/\s+$/, '')}\n\n${line}` : line
  await db.update(notes).set({ body, updatedAt: new Date() }).where(eq(notes.id, noteId))
  void chunkAndEmbedNote(noteId)
  invalidateNoteBlocks(existing.ownerId)
}
