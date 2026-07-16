// Background runner for the 'bookmark-archive' download-queue job: fetch a saved
// bookmarks row's URL and archive it for offline reading. Produces BOTH:
//   • a full-page snapshot (every asset downloaded locally → data/bookmark-archive/<id>/), and
//   • a cleaned reader view (contentHtml/contentText, with images pointing at the snapshot's
//     local copies),
// so the reader UI can toggle between "Reader" and "Full page" entirely offline.

import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { db } from '@/db'
import { bookmarks, bookmarkSnapshots } from '@/db/schema'
import { capturePage } from '@/lib/bookmarks/snapshot'
import { evaluateWatch, extractWatchText } from '@/lib/bookmarks/watch'
import { renderPage } from '@/lib/bookmarks/render'
import { ytDlpBin, withYtDlpSlot } from '@/lib/ytdlp'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'
import type { DownloadProgress } from '@/lib/download'
import { emitNotification } from '@/lib/notify'
import { organizeCaptured } from '@/lib/capture/organize'

// Where POST /bookmarks/:id/snapshot stashes the browser-rendered HTML for the job to pick up.
export const renderedHtmlPath = (itemId: string) => join(dataDir, 'tmp', `bookmark-render-${itemId}.html`)

// Change-detection fingerprint: hash the reader-extracted plaintext with whitespace collapsed,
// so cosmetic reflowing (re-wrapped lines, extra blank lines) doesn't read as a content change.
function contentFingerprint(text: string | null | undefined): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized).digest('hex')
}

// Best-effort page-media capture via yt-dlp (opt-in per bookmark). Downloads the page's
// embedded video/audio into the archive dir as media.<ext> and returns its archive-relative
// name, or null if nothing was found. Concurrency-capped via the shared yt-dlp slot.
// A wedged yt-dlp against a scrape-hostile page holds one of only 6 global slots forever and
// used to freeze every other yt-dlp consumer app-wide (see lib/videos/ytdlpJson.ts). --max-filesize
// bounds bytes, not time, so a hard timeout + SIGKILL and the job's abort signal are what free the slot.
const MEDIA_CAPTURE_TIMEOUT_MS = 10 * 60_000

async function capturePageMedia(url: string, absDir: string, signal?: AbortSignal): Promise<string | null> {
  try {
    await withYtDlpSlot(() => new Promise<void>((resolve, reject) => {
      const proc = spawn(ytDlpBin(), [
        '--no-playlist', '--no-warnings', '-f', 'bv*+ba/b', '--max-filesize', '500M',
        '-o', join(absDir, 'media.%(ext)s'), '--', url,
      ], { stdio: 'ignore', windowsHide: true })
      let done = false
      const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn() }
      const onAbort = () => { try { proc.kill('SIGKILL') } catch { /* gone */ }; finish(() => reject(new Error('aborted'))) }
      const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ }; finish(() => reject(new Error('yt-dlp timed out'))) }, MEDIA_CAPTURE_TIMEOUT_MS)
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      proc.on('exit', (code) => finish(() => (code === 0 ? resolve() : reject(new Error(`yt-dlp exit ${code}`)))))
      proc.on('error', (err) => finish(() => reject(err)))
    }))
    const files = await readdir(absDir)
    return files.find((f) => /^media\.[a-z0-9]+$/i.test(f)) ?? null
  } catch (err) {
    logger.warn(`[bookmarks/archive] media capture skipped: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

// Off-box fallback when local capture fails: ask the Wayback Machine to Save Page Now and
// return the resulting permalink. Best-effort + short timeout — an offline appliance simply
// can't reach archive.org, so failure returns the wildcard calendar URL (valid when online).
async function waybackFallback(url: string): Promise<string> {
  try {
    const res = await fetch(`https://web.archive.org/save/${url}`, { signal: AbortSignal.timeout(20_000) })
    const loc = res.headers.get('content-location')
    if (loc) return `https://web.archive.org${loc}`
  } catch { /* offline or rate-limited → fall through to the calendar URL */ }
  return `https://web.archive.org/web/*/${url}`
}

export async function runArchiveArticleJob(
  bookmarkId: string,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  _signal: AbortSignal,
): Promise<void> {
  const item = await db.select().from(bookmarks).where(eq(bookmarks.id, bookmarkId)).then(r => r[0])
  if (!item) return // row deleted before the job ran — nothing to do

  await db.update(bookmarks)
    .set({ archiveState: 'fetching', archiveError: null, updatedAt: new Date() })
    .where(eq(bookmarks.id, bookmarkId))
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
      renderedHtml = await readFile(renderedHtmlPath(bookmarkId), 'utf8')
    } catch { /* none — capturePage will static-fetch */ }
  }
  await rm(renderedHtmlPath(bookmarkId), { force: true }).catch(() => {})

  try {
    const snap = await capturePage(item.url, bookmarkId, (p) => {
      onProgress({ completed: p.completed, total: Math.max(p.total, 1), speedBps: 0, etaSeconds: 0, note: p.note })
    }, { renderedHtml, screenshotPng })
    const a = snap.reader
    const absDir = join(dataDir, snap.snapshotRelDir)

    // PDF: a printed copy from the headless render (ArchiveBox-style). Written into the archive
    // dir and served via /api/bookmarks/:id/archive/page.pdf. Only when the render produced one.
    let pdfRel = item.pdfPath
    if (rendered?.pdf) {
      await writeFile(join(absDir, 'page.pdf'), rendered.pdf).catch(() => {})
      pdfRel = 'page.pdf'
    }
    // Page media (opt-in): run yt-dlp against the URL to grab any embedded video/audio.
    let mediaRel = item.mediaPath
    if (item.captureMedia) {
      onProgress({ completed: 0, total: 1, speedBps: 0, etaSeconds: 0, note: 'Capturing media…' })
      mediaRel = (await capturePageMedia(item.url, absDir, _signal)) ?? item.mediaPath
    }

    // Change detection: compare the new fingerprint against the one stored at the previous
    // capture. A change only counts when there *was* a prior hash (so the first archive — and
    // any backfill of an item that never had one — never reads as "changed").
    const now = new Date()
    const newHash = contentFingerprint(a.contentText)
    const changed = !!item.contentHash && item.contentHash !== newHash

    // Watch conditions: extract the (optionally selector-scoped) watch text from the RAW
    // page HTML and evaluate the configured condition edge-triggered against the previous
    // extract. lastWatchValue is the stored baseline; null on first capture (never fires).
    const watchTitle = item.title || a.title || item.url
    const watchValue = await extractWatchText(snap.rawHtml, item.watchSelector, a.contentText ?? '')
    const watch = evaluateWatch(item.lastWatchValue, watchValue, {
      selector: item.watchSelector,
      mode: item.watchMode,
      keyword: item.watchKeyword,
      threshold: item.watchThreshold,
    }, watchTitle)

    await db.update(bookmarks)
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
        pdfPath: pdfRel,
        mediaPath: mediaRel,
        // Locally-saved favicon (offline-capable) when found; else keep the probe's remote one.
        faviconUrl: snap.faviconRel ? `/api/bookmarks/${bookmarkId}/archive/${snap.faviconRel}` : item.faviconUrl,
        // Preserve the item's kind: a live bookmark stays "live" (still embeds in the reader)
        // even though we now hold an offline snapshot for diffing. The manual "Save offline" /
        // re-archive flows set type='offline' on the row *before* enqueueing, so those still win.
        type: item.type,
        contentHash: newHash,
        lastCheckedAt: now,
        contentChangedAt: changed ? now : item.contentChangedAt,
        lastWatchValue: watchValue,
        archiveState: 'ready',
        archiveError: null,
        updatedAt: now,
      })
      .where(eq(bookmarks.id, bookmarkId))

    // Version history: one row per capture so re-archiving builds a timeline (with the reader
    // view preserved) instead of silently overwriting. `changed` flags captures whose content
    // actually differed from the prior one.
    await db.insert(bookmarkSnapshots).values({
      id: randomUUID(),
      bookmarkId,
      capturedAt: now,
      title: a.title || item.title || item.url,
      contentHtml: a.contentHtml,
      contentText: a.contentText,
      wordCount: a.wordCount,
      contentHash: newHash,
      changed,
      watchValue,
    })

    // Alert the owner when the watch condition fires. With a condition or selector
    // configured, the edge-triggered verdict decides; a plain whole-page watch keeps the
    // original fingerprint semantics. emitNotification covers the bell row, pod overlay,
    // and push/telegram/email delivery routing.
    // Auto-organize (#7): tag a freshly-captured item with the local model, detached so it
    // never blocks the archive job. No-ops if the user turned it off or already tagged it.
    if (item.ownerId && a.contentText) {
      void organizeCaptured({ userId: item.ownerId, bookmarkId, title: item.title || a.title || item.url, text: a.contentText })
    }

    const hasWatchConfig = item.watchMode !== 'any_change' || !!item.watchSelector
    const shouldAlert = hasWatchConfig ? watch.triggered : changed
    if (shouldAlert && item.alertOnChange && item.ownerId) {
      const message = watch.triggered && watch.message ? watch.message : `"${watchTitle}" changed`
      await emitNotification({
        type: 'watcher_alert',
        userId: item.ownerId,
        title: message,
        url: `/bookmarks/read/${bookmarkId}`,
        payload: {
          message,
          kind: 'reader-change',
          itemId: bookmarkId,
          value: watchValue.slice(0, 200),
        },
      })
    }
    // Semantic-search chunks: re-chunk + embed detached (never blocks the job; silent
    // no-op when embeddings are unavailable — search falls back to FTS).
    void import('@/lib/bookmarks/chunks').then((m) => m.chunkAndEmbedBookmark(bookmarkId)).catch(() => {})

    onProgress({ completed: 1, total: 1, speedBps: 0, etaSeconds: 0, note: `Done · ${snap.assetCount} assets${changed ? ' · changed' : ''}` })
  } catch (err) {
    // Local capture failed — try to preserve the page off-box via the Wayback Machine so the
    // user still has *something* (best-effort; offline boxes just store the calendar URL).
    const wayback = await waybackFallback(item.url).catch(() => item.archiveOrgUrl)
    // Mark failed for the UI; rethrow so the queue retries transient errors. A later
    // successful retry flips archive_state back to 'ready'.
    await db.update(bookmarks)
      .set({ archiveState: 'failed', archiveError: String(err), archiveOrgUrl: wayback ?? item.archiveOrgUrl, updatedAt: new Date() })
      .where(eq(bookmarks.id, bookmarkId))
    throw err
  }
}
