// Notification scheduler — 60s tick that:
//   (a) flushes 'deferred' deliveries for users whose quiet hours have ended,
//   (b) flushes 'digest' deliveries once per day at each user's digest time,
//   (c) sends registered daily reports (morning report registers itself in Phase 4),
//   (d) prunes the delivery log to the newest ~1000 terminal rows.
// Double-send guards are date-stamped user prefs, not memory — restarts are safe.

import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { notificationChannels, notificationDeliveries, userPreferences, users } from '@/db/schema'
import { logger } from '@/lib/logger'
import { CHANNELS, type Channel, type NotifPriority } from '@/lib/notify/categories'
import { getAppUrl, inQuietHours, sendToChannel, type OutboundMessage } from '@/lib/notify/dispatch'
import { hasPushSubscription } from '@/lib/push'
import { sendTelegramText } from '@/lib/notify/adapters/telegram'
import { sendEmailRaw } from '@/lib/notify/adapters/email'
import { sendWebPush } from '@/lib/notify/adapters/webPush'

const TICK_MS = 60_000
const LOG_KEEP = 1000

let started = false

// ── Daily report providers (morning report registers here in Phase 4) ─────────

export interface DailyReport {
  subject: string
  text: string
  html?: string
}

export interface DailyReportProvider {
  id: string
  /** Pref key holding {enabled, time:'HH:MM', channels?: Channel[]}. */
  prefKey: string
  defaultTime: string
  collect: (userId: string) => Promise<DailyReport | null>
}

const reportProviders: DailyReportProvider[] = []

export function registerDailyReportProvider(p: DailyReportProvider): void {
  if (!reportProviders.some((x) => x.id === p.id)) reportProviders.push(p)
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function todayStamp(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function pastTimeToday(hm: string, now = new Date()): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm)
  if (!m) return false
  const mins = Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]))
  return now.getHours() * 60 + now.getMinutes() >= mins
}

async function prefFor(userId: string, key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)))
    .limit(1)
  if (!row) return null
  try { return JSON.parse(row.value) } catch { return null }
}

async function setPref(userId: string, key: string, value: unknown): Promise<void> {
  const now = new Date()
  await db
    .insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId, key, value: JSON.stringify(value), updatedAt: now })
    .onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.key],
      set: { value: JSON.stringify(value), updatedAt: now },
    })
}

async function endpointsFor(userId: string): Promise<{ push: boolean; telegram: string | null; email: string | null }> {
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.verified, true)))
  return {
    push: await hasPushSubscription(userId),
    telegram: rows.find((r) => r.kind === 'telegram')?.address ?? null,
    email: rows.find((r) => r.kind === 'email')?.address ?? null,
  }
}

// ── (a) Deferred flush ─────────────────────────────────────────────────────────

async function flushDeferred(): Promise<void> {
  const rows = await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.status, 'deferred'))
    .limit(200)
  if (!rows.length) return

  const byUser = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = byUser.get(r.userId) ?? []
    list.push(r)
    byUser.set(r.userId, list)
  }

  for (const [userId, items] of byUser) {
    const quiet = await prefFor(userId, 'notifications.quiet')
    if (inQuietHours(quiet)) continue // still inside the window
    const endpoints = await endpointsFor(userId)
    for (const item of items) {
      const msg: OutboundMessage = { title: item.title, body: item.body ?? undefined, url: item.url ?? undefined, priority: 'normal' as NotifPriority }
      try {
        await sendToChannel(item.channel as Channel, endpoints, userId, msg)
        await db.update(notificationDeliveries)
          .set({ status: 'sent', sentAt: new Date(), attempts: item.attempts + 1 })
          .where(eq(notificationDeliveries.id, item.id))
      } catch (err) {
        await db.update(notificationDeliveries)
          .set({ status: 'failed', error: err instanceof Error ? err.message : String(err), attempts: item.attempts + 1 })
          .where(eq(notificationDeliveries.id, item.id))
      }
    }
  }
}

// ── (b) Digest flush ───────────────────────────────────────────────────────────

function digestText(items: { title: string; body: string | null }[]): string {
  const lines = items.slice(0, 25).map((i) => `• ${i.title}${i.body ? ` — ${i.body}` : ''}`)
  if (items.length > 25) lines.push(`…and ${items.length - 25} more`)
  return lines.join('\n')
}

function digestHtml(items: { title: string; body: string | null; url: string | null }[], appUrl: string | null): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const li = items.map((i) => {
    const link = i.url && appUrl ? `${appUrl}${i.url.startsWith('/') ? i.url : `/${i.url}`}` : null
    const title = link ? `<a href="${esc(link)}">${esc(i.title)}</a>` : esc(i.title)
    return `<li style="margin:0 0 6px">${title}${i.body ? ` — ${esc(i.body)}` : ''}</li>`
  })
  return `<ul style="padding-left:18px;margin:0">${li.join('')}</ul>`
}

async function flushDigests(): Promise<void> {
  const now = new Date()
  const stamp = todayStamp(now)
  const allUsers = await db.select({ id: users.id }).from(users)

  for (const { id: userId } of allUsers) {
    const time = (await prefFor(userId, 'notifications.digest_time')) ?? '18:00'
    if (typeof time !== 'string' || !pastTimeToday(time, now)) continue
    const last = await prefFor(userId, 'notifications.digest_last')
    if (last === stamp) continue

    const items = await db
      .select()
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.status, 'digest'), eq(notificationDeliveries.userId, userId)))
    // Stamp first — a send failure must not re-fire every tick all day.
    await setPref(userId, 'notifications.digest_last', stamp)
    if (!items.length) continue

    const endpoints = await endpointsFor(userId)
    const appUrl = await getAppUrl()
    const byChannel = new Map<Channel, typeof items>()
    for (const i of items) {
      const list = byChannel.get(i.channel as Channel) ?? []
      list.push(i)
      byChannel.set(i.channel as Channel, list)
    }

    for (const [channel, list] of byChannel) {
      const header = `Daily summary — ${list.length} update${list.length === 1 ? '' : 's'}`
      try {
        if (channel === 'telegram' && endpoints.telegram) {
          await sendTelegramText(endpoints.telegram, `${header}\n\n${digestText(list)}`)
        } else if (channel === 'email' && endpoints.email) {
          await sendEmailRaw(endpoints.email, header, `<p><strong>${header}</strong></p>${digestHtml(list, appUrl)}`, digestText(list))
        } else if (channel === 'push' && endpoints.push) {
          await sendWebPush(userId, { title: header, body: digestText(list.slice(0, 5)), url: '/', priority: 'normal' })
        } else {
          continue
        }
        const ids = list.map((i) => i.id)
        await db.update(notificationDeliveries)
          .set({ status: 'sent', sentAt: new Date() })
          .where(inArray(notificationDeliveries.id, ids))
      } catch (err) {
        logger.warn(`[notify] digest flush failed (${channel}, user ${userId}): ${err}`)
        const ids = list.map((i) => i.id)
        await db.update(notificationDeliveries)
          .set({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
          .where(inArray(notificationDeliveries.id, ids))
      }
    }
  }
}

// ── (c) Daily reports (e.g. morning report) ────────────────────────────────────

async function flushDailyReports(): Promise<void> {
  if (!reportProviders.length) return
  const now = new Date()
  const stamp = todayStamp(now)
  const allUsers = await db.select({ id: users.id }).from(users)

  for (const provider of reportProviders) {
    for (const { id: userId } of allUsers) {
      const cfg = (await prefFor(userId, provider.prefKey)) as { enabled?: boolean; time?: string; channels?: Channel[] } | null
      if (!cfg?.enabled) continue
      if (!pastTimeToday(typeof cfg.time === 'string' ? cfg.time : provider.defaultTime, now)) continue
      const lastKey = `${provider.prefKey}_last`
      if ((await prefFor(userId, lastKey)) === stamp) continue
      await setPref(userId, lastKey, stamp) // stamp first: a bad report never loops

      try {
        const report = await provider.collect(userId)
        if (!report) continue
        const endpoints = await endpointsFor(userId)
        const wanted = Array.isArray(cfg.channels) && cfg.channels.length ? cfg.channels : (['push'] as Channel[])
        for (const channel of wanted) {
          if (!CHANNELS.includes(channel)) continue
          try {
            if (channel === 'telegram' && endpoints.telegram) await sendTelegramText(endpoints.telegram, `${report.subject}\n\n${report.text}`)
            else if (channel === 'email' && endpoints.email) await sendEmailRaw(endpoints.email, report.subject, report.html ?? `<pre>${report.text}</pre>`, report.text)
            else if (channel === 'push' && endpoints.push) await sendWebPush(userId, { title: report.subject, body: report.text.slice(0, 400), url: '/', priority: 'normal' })
          } catch (err) {
            logger.warn(`[notify] daily report send failed (${provider.id}, ${channel}, user ${userId}): ${err}`)
          }
        }
      } catch (err) {
        logger.warn(`[notify] daily report collect failed (${provider.id}, user ${userId}): ${err}`)
      }
    }
  }
}

// ── (d) Prune ──────────────────────────────────────────────────────────────────

async function pruneLog(): Promise<void> {
  // Keep the newest LOG_KEEP terminal rows; queued (digest/deferred) rows are never pruned.
  await db.run(sql`
    DELETE FROM notification_deliveries
    WHERE status IN ('sent','failed')
      AND id NOT IN (
        SELECT id FROM notification_deliveries
        WHERE status IN ('sent','failed')
        ORDER BY created_at DESC
        LIMIT ${LOG_KEEP}
      )
  `)
}

// ── Boot ───────────────────────────────────────────────────────────────────────

export function startNotifyScheduler(): void {
  if (started) return
  started = true
  logger.info('[notify] scheduler started')
  setInterval(() => {
    void (async () => {
      await flushDeferred().catch((err) => logger.warn(`[notify] deferred flush error: ${err}`))
      await flushDigests().catch((err) => logger.warn(`[notify] digest flush error: ${err}`))
      await flushDailyReports().catch((err) => logger.warn(`[notify] daily report error: ${err}`))
      await pruneLog().catch(() => {})
    })()
  }, TICK_MS)
}
