// Background runner for the 'reader-thumb' job: render a (usually live) bookmark in the
// headless browser and store a screenshot as its thumbnail. Lightweight cousin of the
// archive job — screenshot only, no offline asset capture.

import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { db } from '@/db'
import { readerItems } from '@/db/schema'
import { renderPage } from '@/lib/reader/render'
import { ARCHIVE_ROOT } from '@/lib/reader/snapshot'
import { dataDir } from '@/lib/download'
import type { DownloadProgress } from '@/lib/download'

export async function runReaderThumbnailJob(
  readerItemId: string,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  _signal: AbortSignal,
): Promise<void> {
  const item = await db.select().from(readerItems).where(eq(readerItems.id, readerItemId)).then(r => r[0])
  if (!item) return

  onProgress({ completed: 0, total: 1, speedBps: 0, etaSeconds: 0, note: 'Rendering thumbnail…' })
  const rendered = await renderPage(item.url).catch(() => null)
  if (!rendered) return // no browser / blocked — card falls back to the favicon

  const dir = join(dataDir, ARCHIVE_ROOT, readerItemId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'thumb.png'), rendered.screenshotPng)
  await db.update(readerItems)
    .set({ ogImagePath: 'thumb.png', updatedAt: new Date() })
    .where(eq(readerItems.id, readerItemId))
  onProgress({ completed: 1, total: 1, speedBps: 0, etaSeconds: 0, note: 'Done' })
}
