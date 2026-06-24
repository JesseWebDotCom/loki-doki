// Document ingestion: extract text from an uploaded file, split into overlapping
// chunks, embed each chunk, and persist them. Best-effort — extraction failures
// mark the document 'failed' rather than throwing into the request.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { documentChunks, projectDocuments } from '@/db/schema'
import { embed } from '@/llm/embed'
import { stripHtml } from '@/lib/htmlText'
import { packEmbedding } from '@/lib/rag/retrieve'
import { logger } from '@/lib/logger'
import { randomUUID } from 'node:crypto'

const CHUNK_CHARS = 2000      // ~500 tokens
const CHUNK_OVERLAP = 200

/** Extract plain text from a file by type. Returns '' when nothing usable is found. */
export async function extractText(filename: string, mime: string, bytes: Uint8Array): Promise<string> {
  const lower = filename.toLowerCase()
  const isPdf = mime.includes('pdf') || lower.endsWith('.pdf')
  const isHtml = mime.includes('html') || lower.endsWith('.html') || lower.endsWith('.htm')

  if (isPdf) {
    try {
      const { extractText: pdfExtract, getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(bytes)
      const { text } = await pdfExtract(pdf, { mergePages: true })
      return (Array.isArray(text) ? text.join('\n') : text).trim()
    } catch (e) {
      logger.warn(`[rag] PDF extract failed for ${filename}: ${e}`)
      return ''
    }
  }

  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (isHtml) return stripHtml(decoded).trim()
  return decoded.trim()
}

/** Split text into overlapping chunks on paragraph/sentence boundaries where possible. */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return []
  if (clean.length <= CHUNK_CHARS) return [clean]

  const chunks: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_CHARS, clean.length)
    if (end < clean.length) {
      // Prefer to break at a paragraph or sentence boundary near the window edge.
      const slice = clean.slice(start, end)
      const para = slice.lastIndexOf('\n\n')
      const sentence = slice.lastIndexOf('. ')
      const breakAt = para > CHUNK_CHARS * 0.5 ? para : sentence > CHUNK_CHARS * 0.5 ? sentence + 1 : -1
      if (breakAt > 0) end = start + breakAt
    }
    const piece = clean.slice(start, end).trim()
    if (piece) chunks.push(piece)
    if (end >= clean.length) break
    start = end - CHUNK_OVERLAP
  }
  return chunks
}

/** Chunk + embed + persist a document's text. Updates the document row's status. */
export async function ingestDocument(documentId: string, projectId: string, text: string): Promise<number> {
  const chunks = chunkText(text)
  if (chunks.length === 0) {
    await db.update(projectDocuments).set({ status: 'failed', chunkCount: 0 }).where(eq(projectDocuments.id, documentId))
    return 0
  }

  const now = new Date()
  let stored = 0
  for (let i = 0; i < chunks.length; i++) {
    let embedding: Buffer | null = null
    try {
      embedding = packEmbedding(await embed(chunks[i]!))
    } catch (e) {
      logger.warn(`[rag] embed failed (chunk ${i} of ${documentId}): ${e}`)
    }
    await db.insert(documentChunks).values({
      id: randomUUID(),
      documentId,
      projectId,
      chunkIndex: i,
      text: chunks[i]!,
      embedding,
      loc: `part ${i + 1}`,
      createdAt: now,
    })
    stored++
  }

  await db.update(projectDocuments).set({ status: 'ready', chunkCount: stored }).where(eq(projectDocuments.id, documentId))
  return stored
}
