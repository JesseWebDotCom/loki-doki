// Retrieval over a project's embedded document chunks. Embeddings are stored as
// raw Float32 bytes in document_chunks.embedding; retrieval is an in-process cosine
// scan (the per-project chunk set is small for a local, single-household app).

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { documentChunks, projectDocuments } from '@/db/schema'
import { embed, cosineSimilarity } from '@/llm/embed'

export function packEmbedding(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer)
}

export function unpackEmbedding(blob: Buffer | Uint8Array | null): number[] | null {
  if (!blob || blob.byteLength < 4) return null
  const buf = blob instanceof Buffer ? blob : Buffer.from(blob)
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
  return Array.from(f32)
}

export interface RetrievedChunk {
  id: string
  documentId: string
  filename: string
  text: string
  loc: string | null
  score: number
}

export type Strategy = 'stuff' | 'floored_top_k' | 'fallback_first_n'

/**
 * Retrieve up to `k` chunks for `query` within a project. Mirrors v2's strategy
 * cascade: if the project is tiny, "stuff" everything; if nothing embeds, fall back
 * to the first N chunks so generation still has source material.
 */
export async function retrieveChunks(
  projectId: string,
  query: string,
  k = 6,
): Promise<{ chunks: RetrievedChunk[]; strategy: Strategy }> {
  const rows = await db
    .select({
      id: documentChunks.id,
      documentId: documentChunks.documentId,
      text: documentChunks.text,
      loc: documentChunks.loc,
      embedding: documentChunks.embedding,
      filename: projectDocuments.filename,
    })
    .from(documentChunks)
    .innerJoin(projectDocuments, eq(documentChunks.documentId, projectDocuments.id))
    .where(eq(documentChunks.projectId, projectId))

  if (rows.length === 0) return { chunks: [], strategy: 'stuff' }

  const base = rows.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    filename: r.filename,
    text: r.text,
    loc: r.loc,
    vec: unpackEmbedding(r.embedding as Buffer | null),
  }))

  // Tiny project: just use everything in document order.
  if (base.length <= k) {
    return { chunks: base.map((b) => ({ ...b, score: 1 })), strategy: 'stuff' }
  }

  let queryVec: number[] | null = null
  try { queryVec = await embed(query) } catch { queryVec = null }

  if (!queryVec) {
    // Embedding unavailable — first-N fallback so generation still has context.
    return { chunks: base.slice(0, k).map((b) => ({ ...b, score: 0 })), strategy: 'fallback_first_n' }
  }

  const scored = base
    .map((b) => ({ ...b, score: b.vec ? cosineSimilarity(queryVec!, b.vec) : -1 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)

  return { chunks: scored.map(({ vec: _vec, ...rest }) => rest), strategy: 'floored_top_k' }
}
