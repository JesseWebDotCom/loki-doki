// Chunk + embed oversized attached documents for retrieval.
//
// Documents within the prompt-stuffing budget are injected whole (companionTurn's
// docs block). Beyond it, the old behavior hard-truncated at 8k chars — a question
// about page 5 of a 40-page manual hit thin air. Instead: paragraphs are packed
// into ~1.4k-char chunks, embedded DETACHED at attach time (never blocks the
// turn), and each question retrieves the top-k relevant chunks.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { chatDocumentChunks } from '@/db/schema'
import { embed, cosineSimilarity, cachedVector } from '@/llm/embed'
import { logger } from '@/lib/logger'

// Documents at or under this stuff whole; above it they get chunked for retrieval.
export const DOC_STUFF_BUDGET = 8000

const CHUNK_TARGET_CHARS = 1400
const CHUNK_MAX = 200 // per document — bounds embed work for pathological inputs

/** Pack paragraphs into ~CHUNK_TARGET_CHARS chunks (paragraph boundaries preserved;
 *  an oversized single paragraph is hard-split). */
export function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = '' }

  for (const para of paragraphs) {
    if (para.length > CHUNK_TARGET_CHARS) {
      flush()
      for (let i = 0; i < para.length; i += CHUNK_TARGET_CHARS) {
        chunks.push(para.slice(i, i + CHUNK_TARGET_CHARS))
      }
      continue
    }
    if (current.length + para.length + 2 > CHUNK_TARGET_CHARS) flush()
    current = current ? `${current}\n\n${para}` : para
  }
  flush()
  return chunks.slice(0, CHUNK_MAX)
}

/** Chunk + embed one attached document. Detached — call without await. Idempotent
 *  per document (re-attaching under a new id re-chunks that id only). */
export async function chunkAndEmbedDocument(doc: {
  id: string
  conversationId: string
  filename: string
  text: string
}): Promise<void> {
  try {
    // Re-runs for the same document id replace its chunks.
    await db.delete(chatDocumentChunks).where(eq(chatDocumentChunks.documentId, doc.id))

    const chunks = chunkText(doc.text)
    const now = new Date()
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      // Sequential embeds — this is background work; don't stampede Ollama.
      const vector = await embed(chunk).catch(() => null)
      await db.insert(chatDocumentChunks).values({
        id: crypto.randomUUID(),
        documentId: doc.id,
        conversationId: doc.conversationId,
        filename: doc.filename,
        idx: i,
        text: chunk,
        embedding: vector ? JSON.stringify(vector) : null,
        createdAt: now,
      })
    }
    logger.info(`[doc-chunks] embedded ${chunks.length} chunks for ${doc.filename} (${doc.text.length} chars)`)
  } catch (err) {
    logger.warn(`[doc-chunks] chunking failed for ${doc.filename}: ${err}`)
  }
}

export interface DocExcerpt {
  filename: string
  idx: number
  text: string
}

/** Top-k chunks across all of a conversation's documents, ranked by relevance to
 *  the question. Empty when no chunks exist yet (still embedding → caller falls
 *  back to head-truncation). */
export async function retrieveDocChunks(
  conversationId: string,
  question: string,
  topK = 6,
): Promise<DocExcerpt[]> {
  const rows = await db
    .select()
    .from(chatDocumentChunks)
    .where(eq(chatDocumentChunks.conversationId, conversationId))
  if (rows.length === 0) return []

  const queryVec = await embed(question)
  const scored = rows
    .map((r) => {
      if (!r.embedding) return null
      const vec = cachedVector(`doc:${r.id}`, r.embedding)
      if (!vec) return null
      return { r, cos: cosineSimilarity(queryVec, vec) }
    })
    .filter((x): x is { r: (typeof rows)[number]; cos: number } => x !== null)
    .sort((a, b) => b.cos - a.cos)
    .slice(0, topK)
    // Present excerpts in document order — reads far better than score order.
    .sort((a, b) => a.r.filename.localeCompare(b.r.filename) || a.r.idx - b.r.idx)

  return scored.map(({ r }) => ({ filename: r.filename, idx: r.idx, text: r.text }))
}
