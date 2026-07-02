// One-time Telegram link codes. In-memory on purpose: a link is a 15-minute handshake —
// if the server restarts mid-link the user just generates a fresh code (unlike device
// pairingCode rows, which persist because devices persist).

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { notificationChannels } from '@/db/schema'

const CODE_TTL_MS = 15 * 60 * 1000
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I confusion

const codes = new Map<string, { userId: string; expiresAt: number }>()

function sweep(): void {
  const now = Date.now()
  for (const [code, entry] of codes) if (entry.expiresAt <= now) codes.delete(code)
}

export function createLinkCode(userId: string): { code: string; expiresAt: number } {
  sweep()
  // One live code per user — regenerating invalidates the old one.
  for (const [code, entry] of codes) if (entry.userId === userId) codes.delete(code)
  let code = ''
  for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  const expiresAt = Date.now() + CODE_TTL_MS
  codes.set(code, { userId, expiresAt })
  return { code, expiresAt }
}

/** Redeem a code sent to the bot (`/start CODE`). Upserts the user's telegram channel
 *  row (verified — possession of the code proves the chat belongs to the user). */
export async function redeemLinkCode(
  code: string,
  chatId: number,
  meta: { username?: string; firstName?: string } = {},
): Promise<{ userId: string } | null> {
  sweep()
  const entry = codes.get(code.trim().toUpperCase())
  if (!entry) return null
  codes.delete(code.trim().toUpperCase())

  const now = new Date()
  const label = meta.username ? `@${meta.username}` : (meta.firstName ?? null)
  await db
    .insert(notificationChannels)
    .values({
      id: crypto.randomUUID(),
      userId: entry.userId,
      kind: 'telegram',
      address: String(chatId),
      label,
      verified: true,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [notificationChannels.userId, notificationChannels.kind],
      set: { address: String(chatId), label, verified: true, verifyCode: null, verifyExpiresAt: null },
    })
  return { userId: entry.userId }
}

/** The user linked to a Telegram chat, if any (verified rows only). Used by the bridge
 *  to authenticate every incoming message. */
export async function getLinkedUser(chatId: number): Promise<{ userId: string } | null> {
  const [row] = await db
    .select({ userId: notificationChannels.userId })
    .from(notificationChannels)
    .where(and(
      eq(notificationChannels.kind, 'telegram'),
      eq(notificationChannels.address, String(chatId)),
      eq(notificationChannels.verified, true),
    ))
    .limit(1)
  return row ? { userId: row.userId } : null
}
