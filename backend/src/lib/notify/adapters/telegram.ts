// Telegram delivery adapter — formats an outbound notification as a plain-text bot
// message. The heavy lifting (chunking, 429 retry, token cache) lives in the shared
// client at lib/telegram/api.ts, which the two-way bridge also uses.

import { sendTelegramMessage } from '@/lib/telegram/api'
import type { OutboundMessage } from '@/lib/notify/dispatch'

function formatMessage(msg: OutboundMessage, appUrl: string | null): string {
  const lines = [msg.title]
  if (msg.body) lines.push(msg.body)
  if (msg.url && appUrl) lines.push(`${appUrl}${msg.url.startsWith('/') ? msg.url : `/${msg.url}`}`)
  return lines.join('\n')
}

export async function sendTelegramNotification(chatId: string, msg: OutboundMessage, appUrl: string | null): Promise<void> {
  const sent = await sendTelegramMessage(chatId, formatMessage(msg, appUrl))
  if (sent === null) throw new Error('telegram send failed or bot not configured')
}

/** Plain-text send used for digests and link confirmations. */
export async function sendTelegramText(chatId: string, text: string): Promise<void> {
  const sent = await sendTelegramMessage(chatId, text)
  if (sent === null) throw new Error('telegram send failed or bot not configured')
}
