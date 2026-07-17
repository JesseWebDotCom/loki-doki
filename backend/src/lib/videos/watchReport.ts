// Weekly parent watch report: what each child actually watched, from data the video
// stack already records (video_watch_time daily seconds + the per-source watch states).
// Two consumers: the admin panel's on-demand report view, and a Sunday-evening digest
// notification to admins with a short companion-written note (best-effort local LLM,
// falls back to plain numbers).

import { and, desc, eq, gte } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { users, ytWatchState, ytVideos, videoWatchState, videoItems } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { emitNotification } from '@/lib/notify'
import { logger } from '@/lib/logger'

export interface WatchReport {
  userId: string
  name: string
  days: number
  totalMinutes: number
  perDay: Array<{ day: string; minutes: number }>
  videoCount: number
  topCreators: Array<{ name: string; count: number }>
  recent: Array<{ title: string; creatorName: string | null; source: string; watchedAt: number; completed: boolean }>
  companionNote: string | null
}

function dayKeyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export async function buildWatchReport(userId: string, days = 7, withNote = true): Promise<WatchReport | null> {
  const [u] = await db.select({ id: users.id, nickname: users.nickname, firstName: users.firstName })
    .from(users).where(eq(users.id, userId)).limit(1)
  if (!u) return null
  const name = u.nickname || u.firstName || 'Someone'
  const since = new Date(Date.now() - days * 86_400_000)
  const fromKey = dayKeyOf(since)

  // Daily minutes from the heartbeat meter (ISO day keys compare lexically).
  let perDay: Array<{ day: string; minutes: number }> = []
  try {
    const rows = db.all<{ day: string; seconds: number }>(sql`
      SELECT day, seconds FROM video_watch_time WHERE user_id = ${userId} AND day >= ${fromKey} ORDER BY day
    `)
    perDay = rows.map((r) => ({ day: r.day, minutes: Math.round(r.seconds / 60) }))
  } catch { /* fresh table */ }
  const totalMinutes = perDay.reduce((a, b) => a + b.minutes, 0)

  // What was watched: YouTube + hub watch states touched inside the window.
  const yt = await db.select({
    title: ytVideos.title, author: ytVideos.author, updatedAt: ytWatchState.updatedAt, completed: ytWatchState.completed,
  })
    .from(ytWatchState)
    .leftJoin(ytVideos, eq(ytVideos.videoId, ytWatchState.videoId))
    .where(and(eq(ytWatchState.userId, userId), gte(ytWatchState.updatedAt, since)))
    .orderBy(desc(ytWatchState.updatedAt))
    .limit(100)
  const hub = await db.select({
    title: videoItems.title, creatorName: videoItems.creatorName, source: videoWatchState.source,
    updatedAt: videoWatchState.updatedAt, completed: videoWatchState.completed,
  })
    .from(videoWatchState)
    .leftJoin(videoItems, and(eq(videoItems.source, videoWatchState.source), eq(videoItems.externalId, videoWatchState.videoId)))
    .where(and(eq(videoWatchState.userId, userId), gte(videoWatchState.updatedAt, since)))
    .orderBy(desc(videoWatchState.updatedAt))
    .limit(100)

  const watched = [
    ...yt.filter((r) => r.title).map((r) => ({
      title: r.title!, creatorName: r.author, source: 'youtube',
      watchedAt: r.updatedAt?.getTime() ?? 0, completed: r.completed,
    })),
    ...hub.filter((r) => r.title).map((r) => ({
      title: r.title!, creatorName: r.creatorName, source: r.source,
      watchedAt: r.updatedAt?.getTime() ?? 0, completed: r.completed,
    })),
  ].sort((a, b) => b.watchedAt - a.watchedAt)

  const creatorCounts = new Map<string, number>()
  for (const w of watched) {
    if (!w.creatorName) continue
    creatorCounts.set(w.creatorName, (creatorCounts.get(w.creatorName) ?? 0) + 1)
  }
  const topCreators = Array.from(creatorCounts.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([n, count]) => ({ name: n, count }))

  const report: WatchReport = {
    userId, name, days, totalMinutes, perDay,
    videoCount: watched.length,
    topCreators,
    recent: watched.slice(0, 25),
    companionNote: null,
  }
  if (withNote && watched.length > 0) report.companionNote = await companionNote(report)
  return report
}

/** 2-3 warm factual sentences from the local model; null on any failure. */
async function companionNote(r: WatchReport): Promise<string | null> {
  try {
    const model = await getModel()
    const hours = Math.floor(r.totalMinutes / 60)
    const facts = [
      `child: ${r.name}`,
      `window: last ${r.days} days`,
      `total watch time: ${hours ? `${hours}h ` : ''}${r.totalMinutes % 60}m`,
      `videos: ${r.videoCount}`,
      r.topCreators.length ? `top creators: ${r.topCreators.map((c) => `${c.name} (${c.count})`).join(', ')}` : '',
      `recent titles: ${r.recent.slice(0, 15).map((w) => w.title).join(' | ')}`,
    ].filter(Boolean).join('\n')
    const res = await ollamaChat(
      model,
      [
        {
          role: 'system',
          content:
            "You summarize a child's week of video watching for their parent, as the family's home hub. " +
            'Write 2-3 short, warm, factual sentences: what they watched most, how much time overall, and anything notable (a new interest, a binge on one creator). ' +
            'No judgment, no advice unless the numbers are extreme, no greeting, no emojis. Reply with ONLY the summary.',
        },
        { role: 'user', content: facts },
      ],
      undefined,
      { temperature: 0.4, num_predict: 160 },
      undefined,
      12_000,
    )
    const text = res.message.content?.trim().replace(/\s+/g, ' ')
    if (!text || text.length < 20 || text.length > 600) return null
    return text
  } catch (e) {
    logger.debug(`[videos/watchReport] companion note failed: ${e}`)
    return null
  }
}

// ── Weekly digest ────────────────────────────────────────────────────────────────
// Sunday from 5pm local: one 'system' notification to admins per non-admin user who
// watched anything this week, at most once per week (app-setting watermark + dedupe).

const LAST_SENT_KEY = 'videos.watchReport.lastSent'

async function sendWeeklyReports(): Promise<void> {
  const now = new Date()
  if (now.getDay() !== 0 || now.getHours() < 17) return
  const weekKey = dayKeyOf(now)
  const last = await getAppSetting(LAST_SENT_KEY)
  if (last === weekKey) return
  await setAppSetting(LAST_SENT_KEY, weekKey)

  const family = await db.select({ id: users.id, role: users.role }).from(users)
  for (const member of family) {
    if (member.role === 'admin') continue
    try {
      const report = await buildWatchReport(member.id, 7, true)
      if (!report || (report.totalMinutes === 0 && report.videoCount === 0)) continue
      const hours = Math.floor(report.totalMinutes / 60)
      const time = `${hours ? `${hours}h ` : ''}${report.totalMinutes % 60}m`
      const top = report.topCreators[0]?.name
      const message = report.companionNote
        ?? `Watch report: ${report.name} watched ${time} across ${report.videoCount} videos this week${top ? `, mostly ${top}` : ''}.`
      await emitNotification({
        type: 'system',
        userId: null, // admins
        payload: { message, kind: 'watch_report', reportUserId: member.id },
        dedupeKey: `watch-report:${member.id}:${weekKey}`,
      })
    } catch (err) {
      logger.warn(`[videos/watchReport] weekly report failed for ${member.id}: ${String(err)}`)
    }
  }
  logger.info('[videos/watchReport] weekly reports sent')
}

export function startWeeklyWatchReports(): { stop: () => void } {
  const timer = setInterval(() => { void sendWeeklyReports() }, 60 * 60_000)
  // Also check shortly after boot, so a server that was off Sunday evening catches up
  // the moment it comes back during the send window.
  const boot = setTimeout(() => { void sendWeeklyReports() }, 60_000)
  return { stop: () => { clearInterval(timer); clearTimeout(boot) } }
}
