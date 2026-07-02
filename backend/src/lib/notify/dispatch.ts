// Delivery dispatcher: takes an already-persisted notification and fans it out to each
// recipient's channels according to their routing matrix (pref 'notifications.delivery').
// Instant sends retry in-memory (the bell row is already the durable record); digest and
// quiet-hours-deferred items get notification_deliveries rows so they survive restarts
// (flushed by lib/notify/scheduler.ts).

import { and, eq, gt, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { notificationChannels, notificationDeliveries, userPreferences } from '@/db/schema'
import { adminUserIds, hasPushSubscription } from '@/lib/push'
import { getAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'
import {
  CHANNELS, DEFAULT_MATRIX, categoryOf,
  type Channel, type DeliveryMode, type NotifCategory, type NotifPriority, type NotifType,
} from '@/lib/notify/categories'
import { sendWebPush } from '@/lib/notify/adapters/webPush'
import { sendTelegramNotification } from '@/lib/notify/adapters/telegram'
import { sendEmailNotification } from '@/lib/notify/adapters/email'

export interface OutboundMessage {
  title: string
  body?: string
  url?: string
  priority: NotifPriority
}

export interface DispatchInput {
  id: string
  type: NotifType
  userId: string | null // null = admin-targeted (fans out to every admin)
  priority: NotifPriority
  title: string
  body?: string
  url?: string
}

const RETRY_DELAYS_MS = [0, 10_000, 60_000]

export const APP_URL_SETTING_KEY = 'notify.app_url'

/** Optional absolute base URL (e.g. http://loki.local:3000) admins can set so Telegram
 *  and email messages carry clickable deep links. Push doesn't need it (same-origin). */
export async function getAppUrl(): Promise<string | null> {
  const raw = await getAppSetting(APP_URL_SETTING_KEY)
  const url = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
  return url || null
}

// ── Per-user routing prefs ─────────────────────────────────────────────────────

type Matrix = Record<NotifCategory, Record<Channel, DeliveryMode>>

interface QuietHours { enabled: boolean; start: string; end: string }

async function loadPrefs(userId: string, keys: string[]): Promise<Record<string, unknown>> {
  const rows = await db
    .select({ key: userPreferences.key, value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), inArray(userPreferences.key, keys)))
  const out: Record<string, unknown> = {}
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value) } catch { /* malformed pref → default */ }
  }
  return out
}

export function mergeMatrix(sparse: unknown): Matrix {
  const merged = structuredClone(DEFAULT_MATRIX) as Matrix
  if (!sparse || typeof sparse !== 'object') return merged
  for (const [cat, row] of Object.entries(sparse as Record<string, unknown>)) {
    if (!(cat in merged) || !row || typeof row !== 'object') continue
    for (const [channel, mode] of Object.entries(row as Record<string, unknown>)) {
      if (CHANNELS.includes(channel as Channel) && (mode === 'off' || mode === 'instant' || mode === 'digest')) {
        merged[cat as NotifCategory][channel as Channel] = mode
      }
    }
  }
  return merged
}

function parseHm(s: unknown, fallback: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof s === 'string' ? s : fallback)
  if (!m) return 0
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]))
}

/** Quiet hours use the home server's local clock (household appliance — labeled in UI). */
export function inQuietHours(quiet: unknown, now = new Date()): boolean {
  const q = (quiet ?? {}) as Partial<QuietHours>
  if (!q.enabled) return false
  const start = parseHm(q.start, '22:00')
  const end = parseHm(q.end, '07:00')
  const mins = now.getHours() * 60 + now.getMinutes()
  // Window may wrap midnight (22:00 → 07:00).
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end
}

// ── Channel endpoints ──────────────────────────────────────────────────────────

interface Endpoints {
  push: boolean
  telegram: string | null // chat id
  email: string | null
}

async function endpointsFor(userId: string): Promise<Endpoints> {
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

// ── Delivery log ───────────────────────────────────────────────────────────────

async function logDelivery(row: {
  notificationId: string | null
  userId: string
  channel: Channel
  status: 'sent' | 'failed' | 'digest' | 'deferred'
  msg: OutboundMessage
  error?: string
  attempts?: number
}): Promise<void> {
  await db.insert(notificationDeliveries).values({
    id: crypto.randomUUID(),
    notificationId: row.notificationId,
    userId: row.userId,
    channel: row.channel,
    status: row.status,
    title: row.msg.title,
    body: row.msg.body ?? null,
    url: row.msg.url ?? null,
    error: row.error ?? null,
    attempts: row.attempts ?? 0,
    createdAt: new Date(),
    sentAt: row.status === 'sent' ? new Date() : null,
  }).catch((err) => logger.warn(`[notify] delivery log insert failed: ${err}`))
}

// ── Send with retry ────────────────────────────────────────────────────────────

export async function sendToChannel(channel: Channel, endpoint: Endpoints, userId: string, msg: OutboundMessage): Promise<void> {
  const appUrl = await getAppUrl()
  switch (channel) {
    case 'push': return sendWebPush(userId, msg)
    case 'telegram':
      if (!endpoint.telegram) throw new Error('no telegram channel')
      return sendTelegramNotification(endpoint.telegram, msg, appUrl)
    case 'email':
      if (!endpoint.email) throw new Error('no email channel')
      return sendEmailNotification(endpoint.email, msg, appUrl)
  }
}

async function sendWithRetry(
  channel: Channel,
  endpoints: Endpoints,
  userId: string,
  notificationId: string | null,
  msg: OutboundMessage,
): Promise<void> {
  let lastError = ''
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt] ?? 0
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    try {
      await sendToChannel(channel, endpoints, userId, msg)
      await logDelivery({ notificationId, userId, channel, status: 'sent', msg, attempts: attempt + 1 })
      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  logger.warn(`[notify] ${channel} delivery failed for user ${userId}: ${lastError}`)
  await logDelivery({ notificationId, userId, channel, status: 'failed', msg, error: lastError, attempts: RETRY_DELAYS_MS.length })
}

// ── Main dispatch ──────────────────────────────────────────────────────────────

export async function dispatchNotification(n: DispatchInput): Promise<void> {
  const recipients = n.userId ? [n.userId] : await adminUserIds()
  if (!recipients.length) return

  const category = categoryOf(n.type)
  const msg: OutboundMessage = { title: n.title, body: n.body, url: n.url, priority: n.priority }

  await Promise.all(recipients.map(async (userId) => {
    try {
      const prefs = await loadPrefs(userId, ['notifications.delivery', 'notifications.quiet'])
      const matrix = mergeMatrix(prefs['notifications.delivery'])
      const endpoints = await endpointsFor(userId)
      const quiet = inQuietHours(prefs['notifications.quiet'])

      for (const channel of CHANNELS) {
        const usable = channel === 'push' ? endpoints.push : channel === 'telegram' ? !!endpoints.telegram : !!endpoints.email
        if (!usable) continue
        const mode = matrix[category][channel]
        if (mode === 'off') continue
        if (mode === 'digest') {
          await logDelivery({ notificationId: n.id, userId, channel, status: 'digest', msg })
          continue
        }
        if (quiet && n.priority !== 'urgent') {
          await logDelivery({ notificationId: n.id, userId, channel, status: 'deferred', msg })
          continue
        }
        // Instant sends run detached so one slow channel never blocks the others.
        void sendWithRetry(channel, endpoints, userId, n.id, msg)
      }
    } catch (err) {
      logger.warn(`[notify] dispatch failed for user ${userId}: ${err}`)
    }
  }))
}

// ── Channel health (admin panel) ───────────────────────────────────────────────

export interface ChannelHealth { ok: boolean; lastError?: string; failStreak: number }

/** Derived from the last 24h of delivery attempts: a channel is unhealthy when its most
 *  recent attempts are an unbroken failure streak. */
export async function channelHealth(): Promise<Record<Channel, ChannelHealth>> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const rows = await db
    .select()
    .from(notificationDeliveries)
    .where(and(gt(notificationDeliveries.createdAt, since), inArray(notificationDeliveries.status, ['sent', 'failed'])))

  const out = {} as Record<Channel, ChannelHealth>
  for (const channel of CHANNELS) {
    const attempts = rows
      .filter((r) => r.channel === channel)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    let failStreak = 0
    let lastError: string | undefined
    for (const a of attempts) {
      if (a.status !== 'failed') break
      failStreak++
      lastError ??= a.error ?? undefined
    }
    out[channel] = { ok: failStreak === 0, lastError, failStreak }
  }
  return out
}
