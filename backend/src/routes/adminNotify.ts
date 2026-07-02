// /api/admin/notify — admin configuration for the delivery layer: Telegram bot token,
// SMTP credentials, app URL for deep links, channel health, and the delivery log.
// Secrets are never echoed back in full (masked tail only).

import { Hono } from 'hono'
import { desc, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { notificationDeliveries, pushSubscriptions, users } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { getBotInfo, invalidateBotTokenCache } from '@/lib/telegram/api'
import { SMTP_SETTING_KEY, getSmtpConfig, sendEmailRaw, verifySmtp, type SmtpConfig } from '@/lib/notify/adapters/email'
import { APP_URL_SETTING_KEY, channelHealth } from '@/lib/notify/dispatch'
import { getVapidPublicKey } from '@/lib/push'
import type { AppEnv } from '@/types'

const adminNotify = new Hono<AppEnv>()

const TOKEN_SETTING_KEY = 'telegram.bot_token'

function maskTail(secret: string, keep = 4): string {
  return secret.length <= keep ? '••••' : `••••${secret.slice(-keep)}`
}

// ── GET /api/admin/notify/status ───────────────────────────────────────────────

adminNotify.get('/status', requireAdmin, async (c) => {
  const [token, smtp, appUrlRaw] = await Promise.all([
    getAppSetting(TOKEN_SETTING_KEY),
    getSmtpConfig(),
    getAppSetting(APP_URL_SETTING_KEY),
  ])

  const telegram = typeof token === 'string' && token
    ? { configured: true, tokenMasked: maskTail(token), ...(await getBotInfo()) }
    : { configured: false as const }

  const smtpStatus = smtp
    ? { configured: true, host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, from: smtp.from, allowSelfSigned: !!smtp.allowSelfSigned, passMasked: smtp.pass ? maskTail(smtp.pass) : null, ...(await verifySmtp()) }
    : { configured: false as const }

  const allSubs = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)

  let vapidReady = false
  try { vapidReady = !!(await getVapidPublicKey()) } catch { /* keep false */ }

  return c.json({
    webPush: { vapidReady, subscriptionCount: allSubs.length },
    telegram,
    smtp: smtpStatus,
    appUrl: typeof appUrlRaw === 'string' ? appUrlRaw : null,
    health: await channelHealth(),
  })
})

// ── Telegram bot token ─────────────────────────────────────────────────────────

adminNotify.put('/telegram', requireAdmin, async (c) => {
  const body = await c.req.json() as { botToken?: string }
  const token = (body.botToken ?? '').trim()
  if (!token) return c.json({ error: 'botToken required' }, 400)

  // Validate before saving: getMe with the candidate token.
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json() as Promise<{ ok: boolean; result?: { username?: string }; description?: string }>)
    .catch((err) => ({ ok: false as const, description: String(err) }))
  if (!res.ok) return c.json({ error: `Token rejected by Telegram: ${res.description ?? 'unknown error'}` }, 400)

  await setAppSetting(TOKEN_SETTING_KEY, token)
  invalidateBotTokenCache()
  // Hot-start/restart the two-way bridge without a reboot.
  void import('@/lib/telegram/poller').then((m) => m.restartTelegramPoller()).catch(() => {})
  return c.json({ ok: true, botUsername: res.result?.username ?? null })
})

adminNotify.delete('/telegram', requireAdmin, async (c) => {
  await setAppSetting(TOKEN_SETTING_KEY, null)
  invalidateBotTokenCache()
  void import('@/lib/telegram/poller').then((m) => m.restartTelegramPoller()).catch(() => {})
  return c.json({ ok: true })
})

// ── SMTP ───────────────────────────────────────────────────────────────────────

adminNotify.put('/smtp', requireAdmin, async (c) => {
  const body = await c.req.json() as Partial<SmtpConfig>
  if (!body.host || !body.from) return c.json({ error: 'host and from are required' }, 400)

  // Preserve the stored password when the client sends the masked placeholder back.
  const existing = await getSmtpConfig()
  const pass = body.pass && !body.pass.startsWith('••••') ? body.pass : (existing?.pass ?? '')

  const cfg: SmtpConfig = {
    host: body.host.trim(),
    port: Number(body.port) || 587,
    secure: !!body.secure,
    user: (body.user ?? '').trim(),
    pass,
    from: body.from.trim(),
    allowSelfSigned: !!body.allowSelfSigned,
  }
  await setAppSetting(SMTP_SETTING_KEY, cfg)
  const verify = await verifySmtp()
  return c.json({ ok: true, verify })
})

adminNotify.delete('/smtp', requireAdmin, async (c) => {
  await setAppSetting(SMTP_SETTING_KEY, null)
  return c.json({ ok: true })
})

adminNotify.post('/smtp/test', requireAdmin, async (c) => {
  const body = await c.req.json() as { to?: string }
  const to = (body.to ?? '').trim()
  if (!to) return c.json({ error: 'recipient required' }, 400)
  try {
    await sendEmailRaw(to, 'Test email from your home server', '<p>If you can read this, SMTP is working. 🎉</p>', 'If you can read this, SMTP is working.')
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
  }
})

// ── App URL (absolute deep links for telegram/email) ───────────────────────────

adminNotify.put('/app-url', requireAdmin, async (c) => {
  const body = await c.req.json() as { appUrl?: string }
  const url = (body.appUrl ?? '').trim().replace(/\/+$/, '')
  if (url && !/^https?:\/\//.test(url)) return c.json({ error: 'must start with http:// or https://' }, 400)
  await setAppSetting(APP_URL_SETTING_KEY, url || null)
  return c.json({ ok: true })
})

// ── Delivery log ───────────────────────────────────────────────────────────────

adminNotify.get('/deliveries', requireAdmin, async (c) => {
  const limit = Math.min(500, Number(c.req.query('limit')) || 100)
  const rows = await db
    .select()
    .from(notificationDeliveries)
    .where(inArray(notificationDeliveries.status, ['sent', 'failed']))
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(limit)

  // Resolve user names for display (household-scale: a handful of users).
  const userRows = await db.select({ id: users.id, firstName: users.firstName, nickname: users.nickname }).from(users)
  const names = new Map(userRows.map((u) => [u.id, u.nickname || u.firstName]))

  return c.json({
    deliveries: rows.map((r) => ({
      id: r.id,
      user: names.get(r.userId) ?? r.userId,
      channel: r.channel,
      status: r.status,
      title: r.title,
      error: r.error,
      attempts: r.attempts,
      createdAt: r.createdAt.getTime(),
      sentAt: r.sentAt?.getTime() ?? null,
    })),
  })
})

export { adminNotify }
