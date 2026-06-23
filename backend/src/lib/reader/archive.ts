// Background runner for the 'archive-article' download-queue job: fetch a saved
// reader_items row's URL and archive it for offline reading. Produces BOTH:
//   • a full-page snapshot (every asset downloaded locally → data/reader-archive/<id>/), and
//   • a cleaned reader view (contentHtml/contentText, with images pointing at the snapshot's
//     local copies),
// so the reader UI can toggle between "Reader" and "Full page" entirely offline.

import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { readFile, rm } from 'node:fs/promises'
import { db } from '@/db'
import { readerItems } from '@/db/schema'
import { capturePage } from '@/lib/reader/snapshot'
import { renderPage } from '@/lib/reader/render'
import { dataDir } from '@/lib/download'
import type { DownloadProgress } from '@/lib/download'

// Where POST /reader/:id/snapshot stashes the browser-rendered HTML for the job to pick up.
export const renderedHtmlPath = (itemId: string) => join(dataDir, 'tmp', `reader-render-${itemId}.html`)

export async function runArchiveArticleJob(
  readerItemId: string,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  _signal: AbortSignal,
): Promise<void> {
  const item = await db.select().from(readerItems).where(eq(readerItems.id, readerItemId)).then(r => r[0])
  if (!item) return // row deleted before the job ran — nothing to do

  await db.update(readerItems)
    .set({ archiveState: 'fetching', archiveError: null, updatedAt: new Date() })
    .where(eq(readerItems.id, readerItemId))
  onProgress({ completed: 0, total: 1, speedBps: 0, etaSeconds: 0, note: 'Fetching page…' })

  // Capture-engine fallback chain:
  //   1) server-side headless Chromium (default — JS-rendered HTML + a real screenshot),
  //   2) a browser-rendered capture the client posted (proxy iframe),
  //   3) a plain static fetch (inside capturePage when no HTML is supplied).
  let renderedHtml: string | undefined
  let screenshotPng: Uint8Array | undefined

  onProgress({ completed: 0, total: 1, speedBps: 0, etaSeconds: 0, note: 'Rendering page…' })
  const rendered = await renderPage(item.url).catch(() => null)
  if (rendered) {
    renderedHtml = rendered.html
    screenshotPng = rendered.screenshotPng
  } else {
    // Fallback 2: a capture the client rendered + posted. Consume it either way so a later
    // manual re-archive doesn't silently reuse stale HTML.
    try {
      renderedHtml = await readFile(renderedHtmlPath(readerItemId), 'utf8')
    } catch { /* none — capturePage will static-fetch */ }
  }
  await rm(renderedHtmlPath(readerItemId), { force: true }).catch(() => {})

  try {
    const snap = await capturePage(item.url, readerItemId, (p) => {
      onProgress({ completed: p.completed, total: Math.max(p.total, 1), speedBps: 0, etaSeconds: 0, note: p.note })
    }, { renderedHtml, screenshotPng })
    const a = snap.reader

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
        snapshotPath: snap.snapshotRelDir, // full-page snapshot dir (relative to dataDir)
        ogImagePath: snap.thumbRel, // archive-relative thumbnail path (served via /archive/<thumbRel>)
        // Locally-saved favicon (offline-capable) when found; else keep the probe's remote one.
        faviconUrl: snap.faviconRel ? `/api/reader/${readerItemId}/archive/${snap.faviconRel}` : item.faviconUrl,
        type: 'offline',
        archiveState: 'ready',
        archiveError: null,
        updatedAt: new Date(),
      })
      .where(eq(readerItems.id, readerItemId))
    onProgress({ completed: 1, total: 1, speedBps: 0, etaSeconds: 0, note: `Done · ${snap.assetCount} assets` })
  } catch (err) {
    // Mark failed for the UI; rethrow so the queue retries transient errors. A later
    // successful retry flips archive_state back to 'ready'.
    await db.update(readerItems)
      .set({ archiveState: 'failed', archiveError: String(err), updatedAt: new Date() })
      .where(eq(readerItems.id, readerItemId))
    throw err
  }
}
