// Background price-check poller. Wakes every 5 minutes, finds listings whose jittered
// ~4h interval has elapsed, and checks them through the tracker. Two lanes keep the
// appliance polite: plain-fetch stores run with small concurrency behind the shared
// per-host throttle; browser-lane stores (Akamai-fronted — renderPage) run strictly
// one at a time with an extra sleep between items. Failures back off exponentially.

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { shoppingListings } from '@/db/schema'
import { emitNotification } from '@/lib/notify'
import { adapterFor } from '@/lib/shopping/adapters'
import { observeListing, recordFailure, recordObservation, type ListingRow } from '@/lib/shopping/tracker'
import { logger } from '@/lib/logger'

const WAKE_MS = 5 * 60 * 1000
const BASE_INTERVAL_MS = 4 * 60 * 60 * 1000
const JITTER_MS = 45 * 60 * 1000
const MAX_BACKOFF_DOUBLINGS = 3 // 4h → 32h worst case, capped below at 48h
const MAX_INTERVAL_MS = 48 * 60 * 60 * 1000
const FETCH_LANE_CAP = 15
const BROWSER_LANE_CAP = 5
const BROWSER_GAP_MS = 20_000
const FAILS_BEFORE_ADMIN_NOTE = 5

let _polling = false
let _timer: ReturnType<typeof setInterval> | null = null

/** Deterministic per-listing jitter (±45min) so the fleet stays permanently staggered
 *  instead of thundering together after a restart. */
function jitterFor(listingId: string): number {
  let h = 0
  for (let i = 0; i < listingId.length; i++) h = (h * 31 + listingId.charCodeAt(i)) | 0
  const unit = (h >>> 0) / 0xffffffff // 0..1
  return (unit * 2 - 1) * JITTER_MS
}

function intervalFor(listing: ListingRow): number {
  const base = BASE_INTERVAL_MS + jitterFor(listing.id)
  const backoff = 2 ** Math.min(listing.failCount, MAX_BACKOFF_DOUBLINGS)
  return Math.min(base * backoff, MAX_INTERVAL_MS)
}

function isDue(listing: ListingRow, now: number): boolean {
  if (!listing.lastCheckedAt) return true
  return now - listing.lastCheckedAt.getTime() > intervalFor(listing)
}

async function checkListing(listing: ListingRow): Promise<void> {
  try {
    const obs = await observeListing(listing)
    if (obs) {
      await recordObservation(listing, obs)
      return
    }
    const failCount = await recordFailure(listing, 'price check failed')
    if (failCount === FAILS_BEFORE_ADMIN_NOTE) {
      await emitNotification({
        type: 'system',
        userId: null,
        title: 'Price tracker: listing keeps failing',
        body: `${listing.title ?? listing.url} (${listing.retailer}) has failed ${failCount} checks in a row.`,
        url: `/shopping/products/${listing.productId}`,
        dedupeKey: `shopping-fail:${listing.id}`,
      })
    }
  } catch (err) {
    await recordFailure(listing, String(err).slice(0, 200))
  }
}

async function pollOnce(): Promise<void> {
  const now = Date.now()
  const listings = await db.select()
    .from(shoppingListings)
    .where(and(eq(shoppingListings.active, true)))
  const due = listings.filter(l => isDue(l, now))
  if (!due.length) return

  const browserLane: ListingRow[] = []
  const fetchLane: ListingRow[] = []
  for (const listing of due) {
    (adapterFor(listing.retailer)?.needsBrowser ? browserLane : fetchLane).push(listing)
  }
  // Oldest-checked first so nothing starves when the per-wake caps kick in.
  const byAge = (a: ListingRow, b: ListingRow) =>
    (a.lastCheckedAt?.getTime() ?? 0) - (b.lastCheckedAt?.getTime() ?? 0)
  fetchLane.sort(byAge)
  browserLane.sort(byAge)

  const fetchBatch = fetchLane.slice(0, FETCH_LANE_CAP)
  // Two workers: the shared per-host throttle in fetchWithLadder spaces same-store hits.
  const queue = [...fetchBatch]
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      for (let l = queue.shift(); l; l = queue.shift()) await checkListing(l)
    }),
  )

  for (const listing of browserLane.slice(0, BROWSER_LANE_CAP)) {
    await checkListing(listing)
    await new Promise(r => setTimeout(r, BROWSER_GAP_MS + Math.random() * 10_000))
  }

  logger.info(`[shopping] poll: ${fetchBatch.length} fetched, ${Math.min(browserLane.length, BROWSER_LANE_CAP)} rendered, ${due.length} due`)
}

export function startShoppingPoller(): void {
  if (_timer) return
  _timer = setInterval(() => {
    if (_polling) return
    _polling = true
    pollOnce()
      .catch(err => logger.warn(`[shopping] poll failed: ${err}`))
      .finally(() => { _polling = false })
  }, WAKE_MS)
  logger.info('[shopping] price poller started')
}
