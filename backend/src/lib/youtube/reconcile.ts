// Back-catalog reconcile — the safety net behind the RSS poller (feed.ts).
//
// YouTube's per-channel/playlist RSS feed only exposes the 15 most-recent items. Anything
// that scrolls past that window between polls — a burst upload, or any uploads that land
// while the server is down for more than a poll cycle — is invisible to the poller forever:
// it never sees those videoIds, so no ytVideos row is ever created, and the video can't be
// browsed, manually saved, or turned into a podcast. It's silently lost.
//
// This module periodically does a *full* InnerTube scan of each subscription and upserts any
// missing rows via the same path the poller uses (upsertSubscriptionVideos). It deliberately
// does NOT run subscription automation: auto-save/auto-podcast are forward-looking ("save new
// uploads as they arrive"), and replaying them over a whole back catalog would mass-download
// entire channels. Reconcile only restores the catalog so missed videos are visible and
// manually actionable again — closing the data-loss gap, nothing more.

import { eq, isNull, or, lt } from 'drizzle-orm'
import { db } from '@/db'
import { ytSubscriptions } from '@/db/schema'
import { logger } from '@/lib/logger'
import { innertubeChannel, innertubePlaylist, type ChannelVideoTab, type ItVideo } from '@/lib/youtube/innertube'
import { upsertSubscriptionVideos, type UpsertVideo } from '@/lib/youtube/feed'

// How often a given subscription is re-scanned. RSS handles the fast path every 15 min; this
// is the slow belt-and-suspenders sweep, so weekly is plenty (pinchflat does monthly).
const RECONCILE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
// How often the scheduler wakes to look for due subscriptions.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
// Hard bounds so a huge channel can't turn one reconcile into thousands of requests. The
// early-stop below means a caught-up channel costs a single page; these only bite on the
// very first scan of a large, long-unseen back catalog.
const MAX_VIDEOS_PER_TAB = 500
const MAX_PAGES_PER_TAB = 30
// Channel uploads live across two distinct catalogs with different renderers/tabs; RSS lumps
// them together, so to match its coverage we scan both. (Completed livestreams surface under
// 'videos', so the 'live' tab is redundant and skipped.)
const CHANNEL_TABS: ChannelVideoTab[] = ['videos', 'shorts']

function toUpsert(v: ItVideo, tab?: ChannelVideoTab): UpsertVideo {
  return {
    videoId: v.videoId,
    title: v.title,
    author: v.author,
    channelId: v.channelId,
    thumbnailUrl: v.thumbnailUrl,
    // The channel/playlist scan only gives relative text ("3 days ago"), not a precise
    // timestamp — leave publishedAt null rather than guess. Duration, when present, is kept.
    publishedAt: null,
    durationSec: v.durationSec,
    description: null,
    // Playlist scans (tab undefined) don't map to a single channel tab — leave null.
    tab: tab ?? null,
  }
}

/** Walk one channel tab via continuation, upserting each page. Stops as soon as a page adds
 *  nothing new — the tab is reverse-chronological, so an all-known page means everything below
 *  it is already known too. Returns how many rows were newly inserted. */
async function reconcileChannelTab(sub: typeof ytSubscriptions.$inferSelect, tab: ChannelVideoTab): Promise<number> {
  let continuation: string | null = null
  let scanned = 0
  let inserted = 0

  for (let page = 0; page < MAX_PAGES_PER_TAB && scanned < MAX_VIDEOS_PER_TAB; page++) {
    const res = await innertubeChannel(sub.externalId, continuation, 30, 8000, tab)
    if (!res.videos.length) break
    scanned += res.videos.length

    const fresh = await upsertSubscriptionVideos(sub, res.videos.map(v => toUpsert(v, tab)))
    inserted += fresh.length

    // Nothing new on this page → caught up; deeper pages are older and already known.
    if (!fresh.length) break
    if (!res.continuation) break
    continuation = res.continuation
  }
  return inserted
}

/** Full back-catalog scan for one subscription. Best-effort: a failure on one tab/playlist
 *  is logged and swallowed so a single bad source never stalls the sweep. */
export async function reconcileSubscription(sub: typeof ytSubscriptions.$inferSelect): Promise<number> {
  let inserted = 0
  try {
    if (sub.kind === 'playlist') {
      // innertubePlaylist returns the first browse page (up to ~100 items, no deep
      // continuation) — still far past RSS's 15, so it closes the realistic gap.
      const pl = await innertubePlaylist(sub.externalId, MAX_VIDEOS_PER_TAB, 8000)
      const fresh = await upsertSubscriptionVideos(sub, pl.videos.map(v => toUpsert(v)))
      inserted += fresh.length
    } else {
      for (const tab of CHANNEL_TABS) {
        try {
          inserted += await reconcileChannelTab(sub, tab)
        } catch (err) {
          logger.warn(`[youtube] reconcile ${tab} tab failed for "${sub.title}": ${err}`)
        }
      }
    }
  } catch (err) {
    logger.warn(`[youtube] reconcile failed for "${sub.title}": ${err}`)
  }

  await db.update(ytSubscriptions)
    .set({ lastReconciledAt: new Date() })
    .where(eq(ytSubscriptions.id, sub.id))

  if (inserted > 0) logger.info(`[youtube] reconcile recovered ${inserted} missed video(s) for "${sub.title}"`)
  return inserted
}

// ── Scheduler ──────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null
let _running = false

async function runDueReconciles(): Promise<void> {
  if (_running) return
  _running = true
  try {
    const cutoff = new Date(Date.now() - RECONCILE_INTERVAL_MS)
    const due = await db.select().from(ytSubscriptions)
      .where(or(isNull(ytSubscriptions.lastReconciledAt), lt(ytSubscriptions.lastReconciledAt, cutoff)))
    // Serialize: a full scan is much heavier than an RSS fetch, and YouTube rate-limits
    // aggressive indexing. One subscription at a time, paced by the 6-hour cadence.
    for (const sub of due) {
      await reconcileSubscription(sub)
    }
  } catch (err) {
    logger.warn(`[youtube] reconcile sweep error: ${err}`)
  } finally {
    _running = false
  }
}

/** Start the periodic back-catalog reconcile. Runs an initial sweep shortly after boot (to
 *  catch up anything missed while the server was down), then every CHECK_INTERVAL_MS. */
export function startYoutubeReconcile(): void {
  if (_timer) return
  // Delay the first sweep so it doesn't pile onto boot — and let the RSS poller grab the
  // easy recent items first.
  setTimeout(() => { void runDueReconciles() }, 90_000)
  _timer = setInterval(() => { void runDueReconciles() }, CHECK_INTERVAL_MS)
}
