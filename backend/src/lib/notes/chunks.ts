// Semantic chunks for notes (mirrors lib/bookmarks/chunks.ts). Re-chunked + embedded
// DETACHED after every content change; retrieval is cosine-over-JSON-vectors with the
// LRU vector cache. Consumers must treat an empty result as "fall back to FTS" —
// chunks are absent when Ollama/embeddings were down at save time.
//
// Unlike articles there is NO minimum-length floor: a two-line measurement note
// ("far pothole took 8 bags") is exactly the kind of content recall must find, so
// short notes embed whole as a single chunk.

import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '@/db'
import { noteChunks, notes } from '@/db/schema'
import { chunkText } from '@/lib/docChunks'
import { embed, cosineSimilarity, cachedVector } from '@/llm/embed'
import { logger } from '@/lib/logger'

const MAX_CHUNKS_PER_NOTE = 40 // bounds vector volume (~8-9KB JSON each)

// Autosave fires a re-chunk per debounce tick; coalesce so one runs at a time per
// note and a burst schedules exactly one trailing re-run against the final content.
const inFlight = new Map<string, Promise<void>>()
const rerunQueued = new Set<string>()

/** Re-chunk + embed one note. Detached — call without await. Silent no-op when the
 *  embedder is unavailable (availability probed BEFORE deleting existing chunks). */
export function chunkAndEmbedNote(noteId: string): Promise<void> {
  const running = inFlight.get(noteId)
  if (running) {
    rerunQueued.add(noteId)
    return running
  }
  const job = doChunkAndEmbed(noteId).finally(() => {
    inFlight.delete(noteId)
    if (rerunQueued.delete(noteId)) void chunkAndEmbedNote(noteId)
  })
  inFlight.set(noteId, job)
  return job
}

async function doChunkAndEmbed(noteId: string): Promise<void> {
  try {
    const [note] = await db.select({ title: notes.title, body: notes.body })
      .from(notes).where(eq(notes.id, noteId)).limit(1)
    if (!note) return
    const text = `${note.title}\n\n${note.body}`.trim()
    if (!text) return

    // Probe embed availability BEFORE deleting existing chunks.
    const probe = await embed(text.slice(0, 200)).catch(() => null)
    if (!probe) return

    const chunks = chunkText(text).slice(0, MAX_CHUNKS_PER_NOTE)
    await db.delete(noteChunks).where(eq(noteChunks.noteId, noteId))
    const now = new Date()
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      // Sequential — background work; don't stampede Ollama.
      const vector = await embed(chunk).catch(() => null)
      if (!vector) continue
      await db.insert(noteChunks).values({
        id: crypto.randomUUID(),
        noteId,
        idx: i,
        text: chunk,
        embedding: JSON.stringify(vector),
        createdAt: now,
      })
    }
  } catch (err) {
    logger.warn(`[notes] chunk/embed failed for ${noteId}: ${err}`)
  }
}

export interface NoteChunkHit {
  noteId: string
  title: string
  ownerId: string | null
  idx: number
  text: string
  score: number
}

/** Top-k chunks across the user's visible notes (own + household-shared), ranked by
 *  cosine relevance. `[]` on embed failure — callers degrade to FTS. Pass a
 *  pre-computed `queryVec` to reuse the turn's message embedding. */
export async function retrieveNoteChunks(
  userId: string,
  question: string,
  topK = 6,
  queryVecIn?: number[] | null,
): Promise<NoteChunkHit[]> {
  const queryVec = queryVecIn ?? await embed(question).catch(() => null)
  if (!queryVec) return []

  const rows = await db
    .select({
      id: noteChunks.id,
      noteId: noteChunks.noteId,
      idx: noteChunks.idx,
      text: noteChunks.text,
      embedding: noteChunks.embedding,
      title: notes.title,
      ownerId: notes.ownerId,
    })
    .from(noteChunks)
    .innerJoin(notes, eq(notes.id, noteChunks.noteId))
    .where(or(isNull(notes.ownerId), eq(notes.ownerId, userId)))
  if (!rows.length) return []

  return rows
    .map((r) => {
      if (!r.embedding) return null
      const vec = cachedVector(`note:${r.id}`, r.embedding)
      if (!vec) return null
      return { noteId: r.noteId, title: r.title, ownerId: r.ownerId, idx: r.idx, text: r.text, score: cosineSimilarity(queryVec, vec) }
    })
    .filter((x): x is NoteChunkHit => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
