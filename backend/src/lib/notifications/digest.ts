// Notification intelligence: collapse a burst of unread notifications into one
// natural-language digest line for the bell dropdown. Opt-in per user. Safety and
// monitoring alerts (cameras, service/resource down) are deliberately NEVER fed to
// the model or summarized: they pass through verbatim in the normal list, so a
// summary can never soften or mangle an alert the family needs to read exactly
// (the Apple notification-summary / BBC-headline lesson). The result is cached per
// user keyed by the current unread-id set, so it recomputes only when that set
// changes and never runs on the notification-insert hot path.

import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { categoryOf, deriveMessage, type NotifType } from '@/lib/notify/categories'

// Categories whose contents are safety-relevant and must be shown verbatim.
const VERBATIM_CATEGORIES = new Set(['camera', 'monitoring', 'watchers'])

export interface DigestItem {
  type: NotifType
  payload: Record<string, unknown>
}

export interface NotificationDigest {
  digest: string | null
  model: string | null
  /** How many unread notifications the digest actually covers (excludes verbatim/safety). */
  summarizedCount: number
  /** How many unread notifications were held back as verbatim safety alerts. */
  verbatimCount: number
}

function isSummarizable(type: NotifType): boolean {
  return !VERBATIM_CATEGORIES.has(categoryOf(type))
}

/** One short line to feed the model per notification. */
function lineFor(item: DigestItem): string {
  const { title, body } = deriveMessage(item.type, item.payload)
  return body ? `${title}: ${body}` : title
}

interface CacheEntry { key: string; value: NotificationDigest }
const cache = new Map<string, CacheEntry>()

export function invalidateDigest(userId: string): void {
  cache.delete(userId)
}

/**
 * Build (or return a cached) digest for a user's current unread notifications.
 * `unread` must already be visibility- and mute-filtered by the caller.
 */
export async function buildNotificationDigest(
  userId: string,
  unread: { id: string; type: NotifType; payload: Record<string, unknown> }[],
): Promise<NotificationDigest> {
  const summarizable = unread.filter((n) => isSummarizable(n.type))
  const verbatimCount = unread.length - summarizable.length

  // Cache key is the sorted set of unread ids we would summarize. Any add/read/delete
  // changes it, so a stale digest is never shown.
  const key = summarizable.map((n) => n.id).sort().join(',')
  const hit = cache.get(userId)
  if (hit && hit.key === key) return hit.value

  // Nothing worth summarizing (0 or 1 mundane item reads fine on its own).
  if (summarizable.length < 2) {
    const value: NotificationDigest = { digest: null, model: null, summarizedCount: summarizable.length, verbatimCount }
    cache.set(userId, { key, value })
    return value
  }

  const lines = summarizable.slice(0, 20).map((n) => `- ${lineFor(n)}`).join('\n')
  const system =
    'You write a single short digest line summarizing a list of app notifications for a family home hub. ' +
    'One sentence, plain and warm, no more than about 20 words. Group similar items ("2 downloads finished"). ' +
    'Do not invent details, do not list every item, do not use em dashes. Return only the sentence.'

  let digest: string | null = null
  let model: string | null = null
  try {
    model = await getModel()
    const res = await ollamaChat(
      model,
      [
        { role: 'system', content: system },
        { role: 'user', content: `Notifications:\n${lines}` },
      ],
      [],
      { temperature: 0.3, num_predict: 96 },
    )
    digest = (res.message?.content ?? '').trim().replace(/^["']|["']$/g, '') || null
  } catch {
    digest = null
  }

  const value: NotificationDigest = { digest, model, summarizedCount: summarizable.length, verbatimCount }
  cache.set(userId, { key, value })
  return value
}
