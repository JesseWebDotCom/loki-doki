// Email delivery adapter — nodemailer SMTP with credentials from app_settings
// 'notify.smtp' (configured in Admin → Notifications). There is no free email API;
// the household admin brings their own SMTP (Gmail/iCloud app password, or a relay).

import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { getAppSetting } from '@/lib/settings'
import type { OutboundMessage } from '@/lib/notify/dispatch'

export const SMTP_SETTING_KEY = 'notify.smtp'

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean // true = implicit TLS (465); false = STARTTLS/plain (587/25)
  user: string
  pass: string
  from: string
  // For self-signed local relays; surfaced as an "advanced" toggle in admin.
  allowSelfSigned?: boolean
}

export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const raw = (await getAppSetting(SMTP_SETTING_KEY)) as Partial<SmtpConfig> | null
  if (!raw?.host || !raw?.from) return null
  return {
    host: raw.host,
    port: Number(raw.port) || 587,
    secure: !!raw.secure,
    user: raw.user ?? '',
    pass: raw.pass ?? '',
    from: raw.from,
    allowSelfSigned: !!raw.allowSelfSigned,
  }
}

// Transporter is cheap to build but caches its pool; rebuild when config changes by
// keying on the serialized config.
let cached: { key: string; transporter: Transporter } | null = null

async function getTransporter(): Promise<{ transporter: Transporter; from: string } | null> {
  const cfg = await getSmtpConfig()
  if (!cfg) return null
  const key = JSON.stringify(cfg)
  if (!cached || cached.key !== key) {
    cached = {
      key,
      transporter: nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
        ...(cfg.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
      }),
    }
  }
  return { transporter: cached.transporter, from: cfg.from }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Send a raw subject/html email (digests, verification codes, tests). Throws on failure. */
export async function sendEmailRaw(to: string, subject: string, html: string, text?: string): Promise<void> {
  const t = await getTransporter()
  if (!t) throw new Error('SMTP not configured')
  await t.transporter.sendMail({ from: t.from, to, subject, html, text: text ?? html.replace(/<[^>]+>/g, ' ') })
}

/** Format + send a single notification. */
export async function sendEmailNotification(to: string, msg: OutboundMessage, appUrl: string | null): Promise<void> {
  const link = msg.url && appUrl ? `${appUrl}${msg.url.startsWith('/') ? msg.url : `/${msg.url}`}` : null
  const html = [
    `<p style="font-size:16px;margin:0 0 8px"><strong>${escapeHtml(msg.title)}</strong></p>`,
    msg.body ? `<p style="margin:0 0 8px">${escapeHtml(msg.body)}</p>` : '',
    link ? `<p style="margin:0"><a href="${escapeHtml(link)}">Open</a></p>` : '',
  ].join('')
  await sendEmailRaw(to, msg.title, html, [msg.title, msg.body, link].filter(Boolean).join('\n'))
}

/** transporter.verify() — used by the admin panel Save button and status probe. */
export async function verifySmtp(): Promise<{ ok: boolean; error?: string }> {
  try {
    const t = await getTransporter()
    if (!t) return { ok: false, error: 'not configured' }
    await t.transporter.verify()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
