// Semantic chunks for offline articles (mirrors lib/docChunks.ts). Chunked + embedded
// DETACHED after each successful archive; retrieval is cosine-over-JSON-vectors with
// the LRU vector cache. Every consumer must treat an empty result as "fall back to
// FTS" — chunks are absent when Ollama/embeddings were down at archive time.
//
// IMPORTANT: paragraphs must come from contentHtml. stripHtml (lib/content/extract)
// collapses ALL whitespace, so contentText is one giant paragraph — chunking it would
// produce arbitrary 1.4k splits mid-sentence.

import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '@/db'
import { bookmarkChunks, bookmarks } from '@/db/schema'
import { chunkText } from '@/lib/docChunks'
import { stripHtml } from '@/lib/content/extract'
import { embed, cosineSimilarity, cachedVector } from '@/llm/embed'
import { logger } from '@/lib/logger'

const MAX_CHUNKS_PER_BOOKMARK = 40 // bounds vector volume (~8-9KB JSON each)

/** contentHtml → paragraph-structured plain text: inject breaks at block boundaries
 *  BEFORE stripping tags (stripHtml collapses whitespace, so do this first). */
export function bookmarkParagraphText(contentHtml: string): string {
  const withBreaks = contentHtml
    .replace(/<\/(p|h[1-6]|li|blockquote|figcaption|div|section)>/gi, '$&\n\n')
    .replace(/<br\s*\/?>/gi, '\n\n')
  return withBreaks
    .split(/\n{2,}/)
    .map((part) => stripHtml(part).trim())
    .filter(Boolean)
    .join('\n\n')
}

/** Re-chunk + embed one bookmark. Detached — call without await. Silent no-op when
 *  the embedder is unavailable (delete-then-nothing would lose existing chunks, so
 *  availability is probed first). */
export async function chunkAndEmbedBookmark(bookmarkId: string): Promise<void> {
  try {
    const [item] = await db.select({ contentHtml: bookmarks.contentHtml })
      .from(bookmarks).where(eq(bookmarks.id, bookmarkId)).limit(1)
    if (!item?.contentHtml) return

    const text = bookmarkParagraphText(item.contentHtml)
    if (text.length < 200) return // too short to be worth vectors

    // Probe embed availability BEFORE deleting existing chunks.
    const probe = await embed(text.slice(0, 200)).catch(() => null)
    if (!probe) return

    const chunks = chunkText(text).slice(0, MAX_CHUNKS_PER_BOOKMARK)
    await db.delete(bookmarkChunks).where(eq(bookmarkChunks.bookmarkId, bookmarkId))
    const now = new Date()
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      // Sequential — background work; don't stampede Ollama.
      const vector = await embed(chunk).catch(() => null)
      if (!vector) continue
      await db.insert(bookmarkChunks).values({
        id: crypto.randomUUID(),
        bookmarkId,
        idx: i,
        text: chunk,
        embedding: JSON.stringify(vector),
        createdAt: now,
      })
    }
  } catch (err) {
    logger.warn(`[bookmarks] chunk/embed failed for ${bookmarkId}: ${err}`)
  }
}

export interface BookmarkChunkHit {
  bookmarkId: string
  idx: number
  text: string
  score: number
}

/** Top-k chunks across the user's visible bookmarks (own + global), ranked by cosine
 *  relevance to the question. `[]` on embed failure — callers degrade to FTS. */
export async function retrieveBookmarkChunks(
  userId: string,
  question: string,
  topK = 6,
  opts: { bookmarkId?: string } = {},
): Promise<BookmarkChunkHit[]> {
  const queryVec = await embed(question).catch(() => null)
  if (!queryVec) return []

  const rows = await db
    .select({
      id: bookmarkChunks.id,
      bookmarkId: bookmarkChunks.bookmarkId,
      idx: bookmarkChunks.idx,
      text: bookmarkChunks.text,
      embedding: bookmarkChunks.embedding,
    })
    .from(bookmarkChunks)
    .innerJoin(bookmarks, eq(bookmarks.id, bookmarkChunks.bookmarkId))
    .where(and(
      or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, userId)),
      opts.bookmarkId ? eq(bookmarkChunks.bookmarkId, opts.bookmarkId) : undefined,
    ))
  if (!rows.length) return []

  return rows
    .map((r) => {
      if (!r.embedding) return null
      const vec = cachedVector(`bm:${r.id}`, r.embedding)
      if (!vec) return null
      return { bookmarkId: r.bookmarkId, idx: r.idx, text: r.text, score: cosineSimilarity(queryVec, vec) }
    })
    .filter((x): x is BookmarkChunkHit => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
