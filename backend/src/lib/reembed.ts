// Full re-embed of every persisted vector store, run when the embedding model changes
// (model-set switch). Vectors from different embedders live in different spaces — even
// at the same dimensionality, mixing them silently breaks cosine ranking (there is no
// dimension/model stamp on rows). So: rewrite everything from the stored source text,
// table by table, in the background.
//
// Durable + resumable: progress (per completed table) is persisted in the
// 'reembed.state' app-setting; a crash mid-table restarts only that table. Rows are
// walked keyset-style (id > cursor) in small batches with a breather between batches so
// interactive chat/embedding traffic always wins — the embedder is a few hundred MB and
// fast, but this can still be tens of thousands of rows on a mature install.
import { and, asc, eq, gt, isNotNull } from 'drizzle-orm'
import { db } from '@/db'
import {
  memories, memoryEpisodes, bookmarkChunks, videoEmbeddings, documentChunks,
  chatDocumentChunks, methods, noteChunks, frigateEvents,
} from '@/db/schema'
import { embed, clearVectorCache } from '@/llm/embed'
import { packEmbedding } from '@/lib/rag/retrieve'
import { getAppSetting, setAppSetting, deleteAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

const STATE_KEY = 'reembed.state'
const BATCH = 50
const BATCH_PAUSE_MS = 250

interface ReembedState { model: string; done: string[] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// One handler per store. Each re-embeds rows that HAVE an embedding (NULL rows are
// lazily embedded by their own feature paths and will use the new model naturally).
type TableJob = { name: string; run: () => Promise<number> }

async function reembedJsonTable(opts: {
  name: string
  table: any
  textOf: (row: any) => string
  bumpUpdatedAt?: boolean
}): Promise<number> {
  const { table } = opts
  let cursor = ''
  let count = 0
  for (;;) {
    const rows = await db.select().from(table)
      .where(and(isNotNull(table.embedding), gt(table.id, cursor)))
      .orderBy(asc(table.id)).limit(BATCH)
    if (!rows.length) break
    for (const row of rows as any[]) {
      const text = opts.textOf(row).trim()
      if (text) {
        try {
          const vec = await embed(text.slice(0, 4000))
          await db.update(table).set({
            embedding: JSON.stringify(vec),
            ...(opts.bumpUpdatedAt ? { updatedAt: new Date() } : {}),
          }).where(eq(table.id, row.id))
          count++
        } catch (err) {
          logger.warn(`[reembed] ${opts.name} row ${row.id} failed: ${String(err)}`)
        }
      }
      cursor = row.id
    }
    await sleep(BATCH_PAUSE_MS)
  }
  return count
}

function jobs(): TableJob[] {
  return [
    { name: 'memories', run: () => reembedJsonTable({ name: 'memories', table: memories, textOf: (r) => r.text ?? '', bumpUpdatedAt: true }) },
    { name: 'memory_episodes', run: () => reembedJsonTable({ name: 'memory_episodes', table: memoryEpisodes, textOf: (r) => r.summary ?? '' }) },
    { name: 'note_chunks', run: () => reembedJsonTable({ name: 'note_chunks', table: noteChunks, textOf: (r) => r.text ?? '' }) },
    { name: 'bookmark_chunks', run: () => reembedJsonTable({ name: 'bookmark_chunks', table: bookmarkChunks, textOf: (r) => r.text ?? '' }) },
    { name: 'chat_document_chunks', run: () => reembedJsonTable({ name: 'chat_document_chunks', table: chatDocumentChunks, textOf: (r) => r.text ?? '' }) },
    { name: 'video_embeddings', run: () => reembedJsonTable({ name: 'video_embeddings', table: videoEmbeddings, textOf: (r) => r.text ?? '', bumpUpdatedAt: true }) },
    { name: 'methods', run: () => reembedJsonTable({ name: 'methods', table: methods, textOf: (r) => `${r.name}. ${r.description}`, bumpUpdatedAt: true }) },
    {
      // Float32-blob store (project doc RAG).
      name: 'document_chunks',
      run: async () => {
        let cursor = ''
        let count = 0
        for (;;) {
          const rows = await db.select().from(documentChunks)
            .where(and(isNotNull(documentChunks.embedding), gt(documentChunks.id, cursor)))
            .orderBy(asc(documentChunks.id)).limit(BATCH)
          if (!rows.length) break
          for (const row of rows) {
            const text = (row.text ?? '').trim()
            if (text) {
              try {
                const vec = await embed(text.slice(0, 4000))
                await db.update(documentChunks).set({ embedding: packEmbedding(vec) }).where(eq(documentChunks.id, row.id))
                count++
              } catch (err) {
                logger.warn(`[reembed] document_chunks row ${row.id} failed: ${String(err)}`)
              }
            }
            cursor = row.id
          }
          await sleep(BATCH_PAUSE_MS)
        }
        return count
      },
    },
    {
      // Camera events are lazily embedded on first search — cheapest correct move is
      // to drop the stale vectors and let the search path refill with the new model.
      name: 'frigate_events',
      run: async () => {
        const res = await db.update(frigateEvents).set({ embedding: null }).where(isNotNull(frigateEvents.embedding))
        return (res as any)?.rowsAffected ?? 0
      },
    },
  ]
}

let running = false

async function runPending(): Promise<void> {
  if (running) return
  running = true
  try {
    const state = (await getAppSetting(STATE_KEY)) as ReembedState | null
    if (!state || typeof state.model !== 'string') return
    logger.info(`[reembed] rebuilding vector stores for '${state.model}' (${state.done.length} table(s) already done)`)
    for (const job of jobs()) {
      if (state.done.includes(job.name)) continue
      const n = await job.run()
      state.done.push(job.name)
      await setAppSetting(STATE_KEY, state)
      logger.info(`[reembed] ${job.name}: ${n} row(s) re-embedded`)
    }
    clearVectorCache()
    await deleteAppSetting(STATE_KEY)
    logger.info('[reembed] all vector stores rebuilt')
  } catch (err) {
    // State is preserved — the next boot (or next switch) resumes where it stopped.
    logger.warn(`[reembed] interrupted: ${String(err)}`)
  } finally {
    running = false
  }
}

/** Start a fresh re-embed for a newly active embedding model. */
export async function startReembed(modelId: string): Promise<void> {
  await setAppSetting(STATE_KEY, { model: modelId, done: [] } satisfies ReembedState)
  void runPending()
}

/** Resume an interrupted re-embed. Call once at boot. */
export async function resumeReembedIfPending(): Promise<void> {
  const state = await getAppSetting(STATE_KEY)
  if (state) void runPending()
}
