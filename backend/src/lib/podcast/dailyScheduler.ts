// Daily AI-podcast scheduler. The upload-driven automation (youtube/automation.ts) only
// fires on fresh videos; this adds the missing TIME-based trigger: any non-RSS show with
// autoGenerate on and a schedule_json of { cadence: 'daily', hour } gets one episode
// enqueued per local day once the hour has passed. Mirrors the notify scheduler's
// stamp-first idempotency (lastRunDay is written before enqueueing, so a bad job can
// never loop all day).

import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { podcastShows, podcastEpisodes, downloadJobs, users } from '@/db/schema'
import { logger } from '@/lib/logger'
import type { ShowSchedule } from './types'

const TICK_MS = 5 * 60_000

let started = false

function todayStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

function parseSchedule(raw: string | null): ShowSchedule | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as ShowSchedule
    if (s && s.cadence === 'daily' && typeof s.hour === 'number') return s
    return null
  } catch {
    return null
  }
}

/** Insert the pending episode + podcast-generate job, exactly like POST /shows/:id/generate. */
async function enqueueEpisode(show: { id: string; name: string; ownerUserId: string }): Promise<void> {
  const [userRow] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, show.ownerUserId))
  const now = new Date()
  const episodeId = crypto.randomUUID()
  const title = `${show.name}: ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`

  await db.insert(podcastEpisodes).values({ id: episodeId, showId: show.id, title, status: 'pending', createdAt: now })
  await db.insert(downloadJobs).values({
    id: crypto.randomUUID(),
    type: 'podcast-generate',
    refId: JSON.stringify({ showId: show.id, episodeId, userId: show.ownerUserId, userFirstName: userRow?.firstName ?? 'user' }),
    domain: 'podcast',
    sizeClass: 'small',
    label: `Podcast: ${show.name}`,
    status: 'pending',
    priority: 50,
    attempts: 0,
    maxAttempts: 3,
    variantKey: null,
    lastError: null,
    nextEligibleAt: null,
    progress: null,
    createdAt: now,
    updatedAt: now,
  })
}

async function tick(): Promise<void> {
  const now = new Date()
  const stamp = todayStamp(now)

  const shows = await db.select({
    id: podcastShows.id,
    name: podcastShows.name,
    ownerUserId: podcastShows.ownerUserId,
    scheduleJson: podcastShows.scheduleJson,
    source: podcastShows.source,
  }).from(podcastShows).where(eq(podcastShows.autoGenerate, true))

  for (const show of shows) {
    if (show.source === 'rss') continue // RSS shows get episodes from their feed
    const schedule = parseSchedule(show.scheduleJson)
    if (!schedule) continue // upload-driven automation only (no time schedule)
    if (schedule.lastRunDay === stamp) continue
    if (now.getHours() < Math.max(0, Math.min(23, schedule.hour))) continue

    // Something already generating (or a manual run today) means skip, not double up.
    const [latest] = await db.select({ status: podcastEpisodes.status, createdAt: podcastEpisodes.createdAt })
      .from(podcastEpisodes)
      .where(eq(podcastEpisodes.showId, show.id))
      .orderBy(desc(podcastEpisodes.createdAt))
      .limit(1)
    const busy = latest && (latest.status === 'pending' || latest.status === 'generating')
    const ranToday = latest && todayStamp(latest.createdAt) === stamp

    // Stamp FIRST so a failing enqueue can't re-fire every tick all day.
    await db.update(podcastShows)
      .set({ scheduleJson: JSON.stringify({ ...schedule, lastRunDay: stamp }) })
      .where(and(eq(podcastShows.id, show.id), eq(podcastShows.autoGenerate, true)))
    if (busy || ranToday) continue

    try {
      await enqueueEpisode(show)
      logger.info(`[podcast] daily schedule enqueued episode for "${show.name}"`)
    } catch (err) {
      logger.warn(`[podcast] daily schedule enqueue failed for "${show.name}": ${err}`)
    }
  }
}

export function startPodcastDailyScheduler(): void {
  if (started) return
  started = true
  logger.info('[podcast] daily scheduler started')
  setInterval(() => {
    void tick().catch((err) => logger.warn(`[podcast] daily scheduler error: ${err}`))
  }, TICK_MS)
}
