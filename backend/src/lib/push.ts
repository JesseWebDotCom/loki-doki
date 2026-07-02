// Web Push (VAPID). Keys are auto-generated once and persisted in app_settings — no
// manual admin step, mirroring how other one-time secrets in this app are provisioned
// (an operator can still override via VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY env vars).
// This is the send side; frontend/src/lib/push.ts is the subscribe side, and public/sw.js
// is what actually shows the notification when a push arrives.

import webpush from 'web-push'
import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { pushSubscriptions, users } from '@/db/schema'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

const VAPID_SETTING_KEY = 'push.vapid_keys'
const VAPID_SUBJECT = 'mailto:admin@localhost' // required by the spec; not actually contacted

interface VapidKeys { publicKey: string; privateKey: string }

let cached: VapidKeys | null = null
let configured = false

async function getVapidKeys(): Promise<VapidKeys> {
  if (cached) return cached

  const envPublic = process.env.VAPID_PUBLIC_KEY
  const envPrivate = process.env.VAPID_PRIVATE_KEY
  if (envPublic && envPrivate) {
    cached = { publicKey: envPublic, privateKey: envPrivate }
    return cached
  }

  const stored = (await getAppSetting(VAPID_SETTING_KEY)) as VapidKeys | null
  if (stored?.publicKey && stored?.privateKey) {
    cached = stored
    return cached
  }

  const generated = webpush.generateVAPIDKeys()
  await setAppSetting(VAPID_SETTING_KEY, generated)
  logger.info('[push] generated new VAPID keypair')
  cached = generated
  return cached
}

async function ensureConfigured(): Promise<VapidKeys> {
  const keys = await getVapidKeys()
  if (!configured) {
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey)
    configured = true
  }
  return keys
}

/** The public key the frontend needs to call pushManager.subscribe(). */
export async function getVapidPublicKey(): Promise<string> {
  return (await ensureConfigured()).publicKey
}

export interface PushPayload {
  title: string
  body?: string
  url?: string // opened on notificationclick
  priority?: 'info' | 'normal' | 'urgent' // sw.js sets requireInteraction for 'urgent'
}

/** Send a push to every subscription owned by `userId`. Dead subscriptions (410/404 —
 *  the browser unsubscribed or the endpoint expired) are pruned automatically.
 *  Returns how many endpoints accepted the push so callers (the notify dispatcher)
 *  can tell "delivered somewhere" from "all endpoints failed". */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<{ sent: number }> {
  return sendPushToUsers([userId], payload)
}

/** Same as sendPushToUser but for several recipients at once (e.g. every admin). */
export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<{ sent: number }> {
  if (!userIds.length) return { sent: 0 }
  await ensureConfigured()

  const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, userIds))
  if (!subs.length) return { sent: 0 }

  const body = JSON.stringify(payload)
  const dead: string[] = []
  let sent = 0

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dhKey, auth: sub.authKey } },
        body,
      )
      sent++
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) dead.push(sub.id)
      else logger.warn(`[push] send failed (${status ?? 'unknown'}): ${(err as Error).message}`)
    }
  }))

  if (dead.length) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, dead))
  return { sent }
}

/** Whether the user has at least one push subscription (dispatcher endpoint check). */
export async function hasPushSubscription(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .limit(1)
  return !!row
}

/** Every admin's user id — the audience for household-wide alerts (camera events today)
 *  until there's a per-user opt-in preference to route this by instead. */
export async function adminUserIds(): Promise<string[]> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'))
  return rows.map((r) => r.id)
}
