// Background runner for the 'archive-article' download-queue job: fetch a saved
// reader_items row's URL, extract a readable article, and store it for offline reading.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { readerItems } from '@/db/schema'
import { extractArticle } from '@/lib/content/extract'
import type { DownloadProgress } from '@/lib/download'

export async function runArchiveArticleJob(
  readerItemId: string,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  _signal: AbortSignal,
): Promise<void> {
  const item = await db.select().from(readerItems).where(eq(readerItems.id, readerItemId)).then(r => r[0])
  if (!item) return // row deleted before the job ran — nothing to do

  await db.update(readerItems)
    .set({ archiveState: 'fetching', updatedAt: new Date() })
    .where(eq(readerItems.id, readerItemId))
  onProgress({ completed: 0, total: 1, speedBps: 0, etaSeconds: 0, note: 'Fetching article…' })

  try {
    const a = await extractArticle(item.url)
    await db.update(readerItems)
      .set({
        title: item.title || a.title || item.url,
        byline: a.byline ?? item.byline,
        siteName: a.siteName ?? item.siteName,
        excerpt: a.excerpt ?? item.excerpt,
        contentHtml: a.contentHtml,
        contentText: a.contentText,
        wordCount: a.wordCount,
        readingMins: a.readingMins,
        type: 'offline',
        archiveState: 'ready',
        archiveError: null,
        updatedAt: new Date(),
      })
      .where(eq(readerItems.id, readerItemId))
    onProgress({ completed: 1, total: 1, speedBps: 0, etaSeconds: 0, note: 'Done' })
  } catch (err) {
    // Mark failed for the UI; rethrow so the queue retries transient errors. A later
    // successful retry flips archive_state back to 'ready'.
    await db.update(readerItems)
      .set({ archiveState: 'failed', archiveError: String(err), updatedAt: new Date() })
      .where(eq(readerItems.id, readerItemId))
    throw err
  }
}
