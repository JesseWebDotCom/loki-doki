// /api/notify — user-facing delivery-channel management: the settings matrix metadata,
// channel status, Telegram link codes, email verification, and test sends.
// Admin-side configuration (bot token, SMTP) lives in routes/adminNotify.ts.

import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { notificationChannels, pushSubscriptions } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { CATEGORY_META, CHANNELS, DEFAULT_MATRIX } from '@/lib/notify/categories'
import { createLinkCode } from '@/lib/notify/telegramLink'
import { getBotInfo, getBotToken } from '@/lib/telegram/api'
import { getSmtpConfig, sendEmailRaw } from '@/lib/notify/adapters/email'
import { sendToChannel } from '@/lib/notify/dispatch'
import { hasPushSubscription } from '@/lib/push'
import { sendTelegramText } from '@/lib/notify/adapters/telegram'
import type { AppEnv } from '@/types'

const notifyChannels = new Hono<AppEnv>()

// Cache the bot username (getMe) — it only changes when the admin swaps tokens.
let botUsernameCache: { username: string | null; at: number } | null = null
async function botUsername(): Promise<string | null> {
  if (botUsernameCache && Date.now() - botUsernameCache.at < 60_000) return botUsernameCache.username
  const info = await getBotInfo()
  botUsernameCache = { username: info.ok ? (info.username ?? null) : null, at: Date.now() }
  return botUsernameCache.username
}

// ── GET /api/notify/meta ───────────────────────────────────────────────────────
// Drives the settings "What to send where" matrix; single source of truth is backend.

notifyChannels.get('/meta', requireAuth, async (c) => {
  return c.json({
    categories: CATEGORY_META,
    channels: CHANNELS,
    defaults: DEFAULT_MATRIX,
  })
})

// ── GET /api/notify/channels ───────────────────────────────────────────────────

notifyChannels.get('/channels', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.userId, user.id))
  const tg = rows.find((r) => r.kind === 'telegram')
  const email = rows.find((r) => r.kind === 'email')
  const subs = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, user.id))

  return c.json({
    push: { subscriptions: subs.length },
    telegram: tg?.verified ? { linked: true, label: tg.label ?? null } : null,
    telegramAvailable: !!(await getBotToken()),
    email: email ? { address: email.address, verified: email.verified } : null,
    emailAvailable: !!(await getSmtpConfig()),
  })
})

// ── POST /api/notify/channels/telegram/link-code ──────────────────────────────

notifyChannels.post('/channels/telegram/link-code', requireAuth, async (c) => {
  const user = c.get('user')
  if (!(await getBotToken())) return c.json({ error: 'Telegram bot not configured' }, 409)
  const { code, expiresAt } = createLinkCode(user.id)
  const username = await botUsername()
  return c.json({
    code,
    expiresAt,
    deepLink: username ? `https://t.me/${username}?start=${code}` : null,
    botUsername: username,
  })
})

notifyChannels.delete('/channels/telegram', requireAuth, async (c) => {
  const user = c.get('user')
  await db.delete(notificationChannels)
    .where(and(eq(notificationChannels.userId, user.id), eq(notificationChannels.kind, 'telegram')))
  return c.json({ ok: true })
})

// ── Email channel: set address → 6-digit code emailed → verify ────────────────

notifyChannels.put('/channels/email', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json() as { address?: string }
  const address = (body.address ?? '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return c.json({ error: 'invalid email address' }, 400)
  if (!(await getSmtpConfig())) return c.json({ error: 'Email is not set up on this server yet — ask your admin' }, 409)

  const code = String(Math.floor(100000 + Math.random() * 900000))
  const now = new Date()
  await db
    .insert(notificationChannels)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      kind: 'email',
      address,
      verified: false,
      verifyCode: code,
      verifyExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [notificationChannels.userId, notificationChannels.kind],
      set: { address, verified: false, verifyCode: code, verifyExpiresAt: new Date(now.getTime() + 15 * 60 * 1000) },
    })

  try {
    await sendEmailRaw(
      address,
      'Confirm your notification email',
      `<p>Your verification code is:</p><p style="font-size:24px;letter-spacing:4px"><strong>${code}</strong></p><p>It expires in 15 minutes.</p>`,
      `Your verification code is ${code}. It expires in 15 minutes.`,
    )
  } catch (err) {
    return c.json({ error: `Couldn't send the verification email: ${err instanceof Error ? err.message : err}` }, 502)
  }
  return c.json({ ok: true })
})

notifyChannels.post('/channels/email/verify', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json() as { code?: string }
  const [row] = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.userId, user.id), eq(notificationChannels.kind, 'email')))
    .limit(1)
  if (!row || !row.verifyCode) return c.json({ error: 'no pending verification' }, 400)
  if (row.verifyExpiresAt && row.verifyExpiresAt.getTime() < Date.now()) return c.json({ error: 'code expired — save your address again' }, 400)
  if ((body.code ?? '').trim() !== row.verifyCode) return c.json({ error: 'wrong code' }, 400)
  await db.update(notificationChannels)
    .set({ verified: true, verifyCode: null, verifyExpiresAt: null })
    .where(eq(notificationChannels.id, row.id))
  return c.json({ ok: true })
})

notifyChannels.delete('/channels/email', requireAuth, async (c) => {
  const user = c.get('user')
  await db.delete(notificationChannels)
    .where(and(eq(notificationChannels.userId, user.id), eq(notificationChannels.kind, 'email')))
  return c.json({ ok: true })
})

// ── POST /api/notify/test { channel } ─────────────────────────────────────────

notifyChannels.post('/test', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json() as { channel?: 'push' | 'telegram' | 'email' }
  const channel = body.channel
  if (!channel || !CHANNELS.includes(channel)) return c.json({ error: 'unknown channel' }, 400)

  const rows = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.userId, user.id), eq(notificationChannels.verified, true)))
  const endpoints = {
    push: await hasPushSubscription(user.id),
    telegram: rows.find((r) => r.kind === 'telegram')?.address ?? null,
    email: rows.find((r) => r.kind === 'email')?.address ?? null,
  }
  try {
    if (channel === 'telegram' && endpoints.telegram) {
      await sendTelegramText(endpoints.telegram, `Test message from your home server — you're all set, ${user.firstName}. 🎉`)
    } else {
      await sendToChannel(channel, endpoints, user.id, {
        title: 'Test notification',
        body: `You're all set, ${user.firstName} 🎉`,
        url: '/',
        priority: 'normal',
      })
    }
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
  }
})

export { notifyChannels }
