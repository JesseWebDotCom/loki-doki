// Morning report — a per-user daily summary delivered through the notification
// scheduler's daily-report machinery (lib/notify/scheduler.ts). Pure content provider:
// scheduling, channel fan-out, and double-send guards live in the scheduler.
// Sections are all best-effort; a cold briefing cache degrades to fewer sections
// rather than blocking or erroring.

import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import { db } from '@/db'
import { bookmarks, notifications } from '@/db/schema'
import { DEFAULT_BRIEFING_KEY, ensureBriefingWarm } from '@/lib/briefing/refresh'
import { getCachedBriefing, peekCachedBriefing } from '@/lib/briefing/cache'
import { registerDailyReportProvider, type DailyReport } from '@/lib/notify/scheduler'
import { logger } from '@/lib/logger'

export const MORNING_REPORT_PREF_KEY = 'notifications.morning_report'

interface Section { title: string; lines: string[] }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function formatMorningReport(userId: string): Promise<DailyReport | null> {
  const sections: Section[] = []

  // ── Ambient world/local context from the warm briefing cache (never block on a
  // refresh — kick a warm-up for tomorrow and use whatever exists, stale-tolerant).
  try {
    ensureBriefingWarm(DEFAULT_BRIEFING_KEY)
    const briefing = getCachedBriefing(DEFAULT_BRIEFING_KEY) ?? peekCachedBriefing(DEFAULT_BRIEFING_KEY)
    const p = briefing?.payload
    if (p) {
      if (p.weather) sections.push({ title: 'Weather', lines: [p.weather] })
      if (p.worldNews.length) sections.push({ title: 'Headlines', lines: p.worldNews.slice(0, 4).map((i) => i.title) })
      if (p.localNews.length) sections.push({ title: 'Local', lines: p.localNews.slice(0, 3).map((i) => i.title) })
      if (p.sports.length) sections.push({ title: 'Sports', lines: p.sports.slice(0, 3).map((i) => i.title) })
      if (p.holidays.length) sections.push({ title: 'Today', lines: p.holidays.slice(0, 2).map((i) => i.title) })
    }
  } catch (err) {
    logger.warn(`[morning-report] briefing section failed: ${err}`)
  }

  // ── Overnight watcher alerts (last 24h) ──
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const rows = await db.select().from(notifications)
      .where(and(
        eq(notifications.userId, userId),
        eq(notifications.type, 'watcher_alert'),
        gt(notifications.createdAt, since),
      ))
      .orderBy(desc(notifications.createdAt))
      .limit(6)
    if (rows.length) {
      sections.push({
        title: 'Page watchers',
        lines: rows.map((r) => {
          try { return String((JSON.parse(r.payload) as Record<string, unknown>)['message'] ?? 'A watched page changed') }
          catch { return 'A watched page changed' }
        }),
      })
    }
  } catch { /* skip section */ }

  // ── Reading queue ──
  try {
    const rows = await db.select({ title: bookmarks.title, readingMins: bookmarks.readingMins }).from(bookmarks)
      .where(and(
        or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, userId)),
        eq(bookmarks.type, 'offline'),
        inArray(bookmarks.status, ['unread', 'reading']),
      ))
      .orderBy(desc(bookmarks.createdAt))
    if (rows.length) {
      const top = rows.slice(0, 3).map((r) => `${r.title}${r.readingMins ? ` (${r.readingMins} min)` : ''}`)
      sections.push({
        title: `Reading queue — ${rows.length} article${rows.length === 1 ? '' : 's'}`,
        lines: top,
      })
    }
  } catch { /* skip section */ }

  if (!sections.length) return null

  const text = sections.map((s) => `${s.title}\n${s.lines.map((l) => `• ${l}`).join('\n')}`).join('\n\n')
  const html = sections
    .map((s) => `<p style="margin:12px 0 4px"><strong>${esc(s.title)}</strong></p><ul style="margin:0;padding-left:18px">${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`)
    .join('')
  return { subject: 'Your morning report', text, html }
}

/** Boot hook: plugs the morning report into the notify scheduler's daily-report loop. */
export function registerMorningReport(): void {
  registerDailyReportProvider({
    id: 'morning_report',
    prefKey: MORNING_REPORT_PREF_KEY,
    defaultTime: '07:30',
    collect: formatMorningReport,
  })
}
