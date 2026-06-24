// Background runner for the 'bookmark-thumb' job: render a (usually live) bookmark in the
// headless browser and store a screenshot as its thumbnail. Lightweight cousin of the
// archive job — screenshot only, no offline asset capture.

import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { db } from '@/db'
import { bookmarks } from '@/db/schema'
import { renderPage } from '@/lib/bookmarks/render'
import { BOOKMARK_ARCHIVE_ROOT } from '@/lib/bookmarks/snapshot'
import { dataDir } from '@/lib/download'
import type { DownloadProgress } from '@/lib/download'

export async function runBookmarkThumbnailJob(
  bookmarkId: string,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  _signal: AbortSignal,
): Promise<void> {
  const item = await db.select().from(bookmarks).where(eq(bookmarks.id, bookmarkId)).then(r => r[0])
  if (!item) return

  onProgress({ completed: 0, total: 1, speedBps: 0, etaSeconds: 0, note: 'Rendering thumbnail…' })
  const rendered = await renderPage(item.url).catch(() => null)
  if (!rendered) return // no browser / blocked — card falls back to the favicon

  const dir = join(dataDir, BOOKMARK_ARCHIVE_ROOT, bookmarkId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'thumb.png'), rendered.screenshotPng)
  await db.update(bookmarks)
    .set({ ogImagePath: 'thumb.png', updatedAt: new Date() })
    .where(eq(bookmarks.id, bookmarkId))
  onProgress({ completed: 1, total: 1, speedBps: 0, etaSeconds: 0, note: 'Done' })
}
