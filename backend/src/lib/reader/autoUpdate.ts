// Recurring poller for Reader "auto-update" items. Every tick it finds items whose
// configured interval has elapsed since their last check and enqueues a (forced) re-archive.
// The archive job (lib/reader/archive.ts) does the actual fetch, content-fingerprinting and —
// when the page changed and alertOnChange is set — fires the owner a notification.
//
// We deliberately ride the existing download queue (domain='local', ≤1 concurrent) so refreshes
// are serialized and never stampede the box. We stamp lastCheckedAt at *enqueue* time so a slow
// or stuck job can't make the same item re-enqueue every tick.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { readerItems } from '@/db/schema'
import { enqueueArchiveArticle } from '@/lib/downloadJobs'
import { logger } from '@/lib/logger'

const TICK_MS = 5 * 60 * 1000          // re-evaluate which items are due every 5 minutes
const DEFAULT_INTERVAL_MINS = 24 * 60  // items with no explicit interval refresh daily
const MAX_PER_TICK = 25                // cap enqueues per tick so a huge backlog drains gradually

let _timer: ReturnType<typeof setInterval> | null = null
let _running = false

async function tick(): Promise<void> {
  if (_running) return // a prior tick is still enqueuing; skip this one
  _running = true
  try {
    const now = Date.now()
    const items = await db.select().from(readerItems).where(eq(readerItems.autoUpdate, true))
    const due = items.filter((i) => {
      const intervalMs = (i.autoUpdateIntervalMins ?? DEFAULT_INTERVAL_MINS) * 60_000
      return !i.lastCheckedAt || now - i.lastCheckedAt.getTime() >= intervalMs
    }).slice(0, MAX_PER_TICK)

    for (const item of due) {
      await db.update(readerItems).set({ lastCheckedAt: new Date() }).where(eq(readerItems.id, item.id))
      await enqueueArchiveArticle(item.id, item.title || item.url, { force: true })
    }
    if (due.length) logger.info(`[reader-autoupdate] enqueued ${due.length} refresh(es)`)
  } catch (err) {
    logger.warn(`[reader-autoupdate] tick failed: ${String(err)}`)
  } finally {
    _running = false
  }
}

export function startReaderAutoUpdatePoller(): void {
  if (_timer) return
  _timer = setInterval(() => { void tick() }, TICK_MS)
  // First sweep shortly after boot (give the download scheduler a moment to come up).
  setTimeout(() => { void tick() }, 30_000)
}
