// Family Year in Review: the private Wrapped. Trakt's Year in Review and Letterboxd's
// stats page are the most screenshot-shared things those products ship, and YouTube built
// Recap in 2025 because people asked for years. Ours is the household version, computed
// from data we already keep, and it never leaves the server.
//
// Two scopes: one person's own recap, and the household's (every member folded together,
// plus per-person highlights). Nothing here profiles anyone: it's arithmetic over the
// watch history the apps already write.

import { and, desc, eq, gte } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { users, videoItems, videoWatchState, ytVideos, ytWatchState } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { logger } from '@/lib/logger'

export interface RecapPerson {
  userId: string
  name: string
  minutes: number
  videoCount: number
  topCreator: string | null
  /** Their most-watched creator's share of their viewing, 0-1 (the "on repeat" signal). */
  topCreatorShare: number
}

export interface Recap {
  scope: 'me' | 'household'
  year: number
  totalMinutes: number
  videoCount: number
  topCreators: Array<{ name: string; count: number }>
  /** Watch minutes per month, Jan-Dec, for the shape-of-the-year strip. */
  byMonth: number[]
  busiestDay: { day: string; minutes: number } | null
  /** Longest run of consecutive days with any watching. */
  longestStreak: number
  people: RecapPerson[]
  /** Creators watched by more than one person: the household's shared taste. */
  sharedCreators: string[]
  note: string | null
}

function yearBounds(year: number): { start: Date; startKey: string } {
  return { start: new Date(year, 0, 1), startKey: `${year}-01-01` }
}

interface WatchRow { title: string; creator: string | null; at: number }

async function watchedIn(userId: string, start: Date): Promise<WatchRow[]> {
  const yt = await db.select({
    title: ytVideos.title, author: ytVideos.author, updatedAt: ytWatchState.updatedAt,
  })
    .from(ytWatchState)
    .leftJoin(ytVideos, eq(ytVideos.videoId, ytWatchState.videoId))
    .where(and(eq(ytWatchState.userId, userId), gte(ytWatchState.updatedAt, start)))
    .orderBy(desc(ytWatchState.updatedAt))
    .limit(2000)
  const hub = await db.select({
    title: videoItems.title, creatorName: videoItems.creatorName, updatedAt: videoWatchState.updatedAt,
  })
    .from(videoWatchState)
    .leftJoin(videoItems, and(eq(videoItems.source, videoWatchState.source), eq(videoItems.externalId, videoWatchState.videoId)))
    .where(and(eq(videoWatchState.userId, userId), gte(videoWatchState.updatedAt, start)))
    .orderBy(desc(videoWatchState.updatedAt))
    .limit(2000)
  return [
    ...yt.filter((r) => r.title).map((r) => ({ title: r.title!, creator: r.author, at: r.updatedAt?.getTime() ?? 0 })),
    ...hub.filter((r) => r.title).map((r) => ({ title: r.title!, creator: r.creatorName, at: r.updatedAt?.getTime() ?? 0 })),
  ]
}

/** Daily watch minutes for a user within the year, from the heartbeat meter. */
function dailyMinutes(userId: string, startKey: string): Array<{ day: string; minutes: number }> {
  try {
    const rows = db.all<{ day: string; seconds: number }>(sql`
      SELECT day, seconds FROM video_watch_time WHERE user_id = ${userId} AND day >= ${startKey} ORDER BY day
    `)
    return rows.map((r) => ({ day: r.day, minutes: Math.round(r.seconds / 60) }))
  } catch {
    return []   // table not created yet on a fresh install
  }
}

function countCreators(rows: WatchRow[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    if (!r.creator) continue
    m.set(r.creator, (m.get(r.creator) ?? 0) + 1)
  }
  return m
}

/** Longest run of consecutive calendar days with any watch time. */
function longestStreak(days: Array<{ day: string; minutes: number }>): number {
  const active = days.filter((d) => d.minutes > 0).map((d) => d.day).sort()
  let best = 0, run = 0
  let prev: number | null = null
  for (const day of active) {
    const t = Date.parse(`${day}T00:00:00`)
    if (prev != null && t - prev === 86_400_000) run += 1
    else run = 1
    prev = t
    if (run > best) best = run
  }
  return best
}

export async function buildRecap(userId: string, year: number, scope: 'me' | 'household'): Promise<Recap> {
  const { start, startKey } = yearBounds(year)
  const family = await db.select({ id: users.id, nickname: users.nickname, firstName: users.firstName }).from(users)
  const members = scope === 'household' ? family : family.filter((u) => u.id === userId)

  const people: RecapPerson[] = []
  const allRows: WatchRow[] = []
  const perCreatorUsers = new Map<string, Set<string>>()
  const dayTotals = new Map<string, number>()

  for (const m of members) {
    const rows = await watchedIn(m.id, start)
    allRows.push(...rows)
    const creators = countCreators(rows)
    for (const name of creators.keys()) {
      const set = perCreatorUsers.get(name) ?? new Set<string>()
      set.add(m.id)
      perCreatorUsers.set(name, set)
    }
    const days = dailyMinutes(m.id, startKey)
    for (const d of days) dayTotals.set(d.day, (dayTotals.get(d.day) ?? 0) + d.minutes)
    const minutes = days.reduce((a, b) => a + b.minutes, 0)
    const top = Array.from(creators.entries()).sort((a, b) => b[1] - a[1])[0]
    people.push({
      userId: m.id,
      name: m.nickname || m.firstName || 'Someone',
      minutes,
      videoCount: rows.length,
      topCreator: top?.[0] ?? null,
      topCreatorShare: top && rows.length ? top[1] / rows.length : 0,
    })
  }

  const days = Array.from(dayTotals.entries()).map(([day, minutes]) => ({ day, minutes })).sort((a, b) => a.day.localeCompare(b.day))
  const byMonth = Array(12).fill(0) as number[]
  for (const d of days) {
    const month = Number(d.day.slice(5, 7)) - 1
    if (month >= 0 && month < 12) byMonth[month] += d.minutes
  }
  const busiest = days.reduce<{ day: string; minutes: number } | null>((best, d) => (!best || d.minutes > best.minutes ? d : best), null)
  const creatorCounts = countCreators(allRows)

  const recap: Recap = {
    scope, year,
    totalMinutes: days.reduce((a, b) => a + b.minutes, 0),
    videoCount: allRows.length,
    topCreators: Array.from(creatorCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
    byMonth,
    busiestDay: busiest && busiest.minutes > 0 ? busiest : null,
    longestStreak: longestStreak(days),
    people: people.sort((a, b) => b.minutes - a.minutes),
    sharedCreators: scope === 'household'
      ? Array.from(perCreatorUsers.entries()).filter(([, set]) => set.size > 1).map(([name]) => name).slice(0, 8)
      : [],
    note: null,
  }
  recap.note = await recapNote(recap)
  return recap
}

/** A short warm summary from the local model; null on any failure (the cards stand alone). */
async function recapNote(r: Recap): Promise<string | null> {
  if (r.videoCount === 0) return null
  try {
    const model = await getModel()
    const hours = Math.floor(r.totalMinutes / 60)
    const facts = [
      `scope: ${r.scope === 'household' ? 'the whole household' : 'one person'}`,
      `year: ${r.year}`,
      `watch time: ${hours}h ${r.totalMinutes % 60}m across ${r.videoCount} videos`,
      r.topCreators.length ? `top creators: ${r.topCreators.slice(0, 5).map((c) => `${c.name} (${c.count})`).join(', ')}` : '',
      r.longestStreak > 1 ? `longest daily streak: ${r.longestStreak} days` : '',
      r.sharedCreators.length ? `watched by more than one person: ${r.sharedCreators.slice(0, 5).join(', ')}` : '',
      r.people.length > 1 ? `per person: ${r.people.map((p) => `${p.name} ${Math.round(p.minutes / 60)}h`).join(', ')}` : '',
    ].filter(Boolean).join('\n')
    const res = await ollamaChat(
      model,
      [
        {
          role: 'system',
          content:
            "You write a family's year-in-review blurb about their video watching, as their home hub. " +
            'Two or three warm, specific sentences: the shape of the year, what they clearly loved, anything sweet about what they share. ' +
            'Celebratory but never gushing, no judgment about screen time, no greeting, no emojis. Reply with ONLY the blurb.',
        },
        { role: 'user', content: facts },
      ],
      undefined,
      { temperature: 0.6, num_predict: 180 },
      undefined,
      12_000,
    )
    const text = res.message.content?.trim().replace(/\s+/g, ' ')
    if (!text || text.length < 20 || text.length > 700) return null
    return text
  } catch (e) {
    logger.debug(`[videos/recap] note failed: ${e}`)
    return null
  }
}
