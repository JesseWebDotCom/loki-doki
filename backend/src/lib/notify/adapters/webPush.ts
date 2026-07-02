// Web Push adapter — thin wrapper over the existing lib/push.ts send side. Throws when
// zero endpoints accepted the push so the dispatcher logs a 'failed' delivery instead of
// silently pretending it landed.

import { sendPushToUser } from '@/lib/push'
import type { OutboundMessage } from '@/lib/notify/dispatch'

export async function sendWebPush(userId: string, msg: OutboundMessage): Promise<void> {
  const { sent } = await sendPushToUser(userId, {
    title: msg.title,
    body: msg.body,
    url: msg.url,
    priority: msg.priority,
  })
  if (sent === 0) throw new Error('no push endpoint accepted the notification')
}
