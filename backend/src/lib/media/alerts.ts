// Media alerts sweep: twice a day, walk every user's Shows/Movies watchlist and notify
// (via the standard notification pipeline) when:
//   1. a tracked show has a new episode airing today or tomorrow ("Severance returns Tuesday"),
//   2. a watchlist title is leaving one of its streaming services within a week
//      (JustWatch `availableTo`, added in the detail-lookup expansion).
// Dedupe keys make the sweep idempotent — re-running never re-notifies an unread alert.

import { isNull } from 'drizzle-orm'
import { db } from '@/db'
import { mediaWatchlist } from '@/db/schema'
import { getNextEpisode } from '@/lib/shows/tvmaze'
import { lookupTitle } from '@/lib/titles/streaming'
import { emitNotification } from '@/lib/notify'

const SWEEP_EVERY_MS = 12 * 60 * 60 * 1000
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000 // stay out of the boot path
const LEAVING_WINDOW_DAYS = 7

function daysUntil(iso: string): number | null {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.floor((t - Date.now()) / 86_400_000)
}

async function sweepOnce(): Promise<void> {
  const rows = await db
    .select({
      userId: mediaWatchlist.userId,
      mediaType: mediaWatchlist.mediaType,
      refId: mediaWatchlist.refId,
      title: mediaWatchlist.title,
    })
    .from(mediaWatchlist)
    .where(isNull(mediaWatchlist.deletedAt))

  for (const row of rows) {
    try {
      // 1. Show returns — tracked shows with an episode airing in the next 2 days.
      if (row.mediaType === 'show') {
        const id = Number(row.refId)
        if (Number.isInteger(id) && id > 0) {
          const ep = await getNextEpisode(id)
          if (ep?.airdate) {
            const days = daysUntil(`${ep.airdate}T23:59:59`)
            if (days != null && days >= 0 && days <= 1) {
              const when = days === 0 ? 'today' : 'tomorrow'
              const epLabel = ep.season != null && ep.number != null ? `S${ep.season}E${ep.number}` : 'a new episode'
              await emitNotification({
                type: 'media_alert',
                userId: row.userId,
                title: `${row.title} is back ${when}`,
                body: `${epLabel}${ep.name ? ` "${ep.name}"` : ''} airs ${when}${ep.airtime ? ` at ${ep.airtime}` : ''}${ep.show.network ? ` on ${ep.show.network}` : ''}.`,
                url: `/shows/${row.refId}`,
                dedupeKey: `showreturn:${row.userId}:${row.refId}:${ep.airdate}`,
              })
            }
          }
        }
      }

      // 2. Leaving soon — any watchlist title whose streaming offer expires within a week.
      const lookup = await lookupTitle(row.title, row.mediaType === 'show' ? 'SHOW' : 'MOVIE')
      if (lookup?.found) {
        for (const p of lookup.providers) {
          if (!p.availableTo || p.offerType !== 'FLATRATE') continue
          const days = daysUntil(p.availableTo)
          if (days == null || days < 0 || days > LEAVING_WINDOW_DAYS) continue
          const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`
          await emitNotification({
            type: 'media_alert',
            userId: row.userId,
            title: `${row.title} is leaving ${p.name}`,
            body: `It leaves ${p.name} ${when}. Watch it before it goes.`,
            url: row.mediaType === 'show' ? `/shows/${row.refId}` : `/movies/${encodeURIComponent(row.refId)}`,
            dedupeKey: `leaving:${row.userId}:${row.mediaType}:${row.refId}:${p.name}:${p.availableTo}`,
          })
        }
      }
    } catch {
      // One bad title never kills the sweep.
    }
  }
}

/** Start the twice-daily media alerts sweep (show returns + leaving-soon). */
export function startMediaAlertsSweep(): void {
  setTimeout(() => { void sweepOnce().catch(() => {}) }, FIRST_RUN_DELAY_MS)
  setInterval(() => { void sweepOnce().catch(() => {}) }, SWEEP_EVERY_MS)
}
