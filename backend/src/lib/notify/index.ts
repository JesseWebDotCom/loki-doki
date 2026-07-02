// emitNotification — the ONLY sanctioned way to create a notification. One call gives
// you: the in-app bell row, the pod overlay bridge, and delivery-layer fan-out
// (push/telegram/email per the recipient's routing matrix). Never throws: notification
// failure must never break the feature that emitted it.

import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { notifications } from '@/db/schema'
import { notifyPod } from '@/lib/pod/notifyPod'
import { logger } from '@/lib/logger'
import { defaultPriorityFor, deriveMessage, type NotifPriority, type NotifType } from '@/lib/notify/categories'
import { dispatchNotification } from '@/lib/notify/dispatch'

export type { NotifType, NotifPriority }

export interface EmitInput {
  type: NotifType
  /** Target user; null/omitted = admin-targeted (visible to all admins, delivered to each). */
  userId?: string | null
  payload?: Record<string, unknown>
  /** Defaults to the per-type default (frigate → urgent, install_request → info, …). */
  priority?: NotifPriority
  /** Channel-facing message; derived from type+payload when omitted. */
  title?: string
  body?: string
  /** In-app deep link path (e.g. '/bookmarks/read/abc') — kept relative; adapters
   *  absolutize with the notify.app_url setting where needed. */
  url?: string
  /** Idempotency: skip entirely when an UNREAD row with the same key exists. */
  dedupeKey?: string
}

/** Returns the new notification id, or null when deduped/failed. */
export async function emitNotification(input: EmitInput): Promise<string | null> {
  try {
    const payload = input.payload ?? {}
    const userId = input.userId ?? null

    if (input.dedupeKey) {
      const [existing] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.dedupeKey, input.dedupeKey), isNull(notifications.readAt)))
        .limit(1)
      if (existing) return null
    }

    const id = crypto.randomUUID()
    const priority = input.priority ?? defaultPriorityFor(input.type)
    const derived = deriveMessage(input.type, payload)
    const title = input.title ?? derived.title
    const body = input.body ?? derived.body
    const url = input.url ?? derived.url

    await db.insert(notifications).values({
      id,
      userId,
      type: input.type,
      payload: JSON.stringify(payload),
      priority,
      dedupeKey: input.dedupeKey ?? null,
      createdAt: new Date(),
    })

    // Pod overlay for user-targeted rows (admin broadcasts stay in the bell).
    notifyPod(userId, input.type, payload)

    // Delivery fan-out runs detached — the caller never waits on SMTP/Telegram.
    void dispatchNotification({ id, type: input.type, userId, priority, title, body, url })
      .catch((err) => logger.warn(`[notify] dispatch error: ${err}`))

    return id
  } catch (err) {
    logger.warn(`[notify] emit failed (${input.type}): ${err}`)
    return null
  }
}
