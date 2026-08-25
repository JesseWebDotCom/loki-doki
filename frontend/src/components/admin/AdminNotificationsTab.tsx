// Admin → Notifications: configure the delivery layer (Telegram bot, email (SMTP),
// web-push status, app URL for deep links, and the delivery log / channel health).
// Backend: routes/adminNotify.ts.

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, RefreshCw, Send, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { SkeletonListRows } from '@/components/shared/SkeletonBlocks'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { AdminAccordion } from '@/components/admin/AdminAccordion'
import { timeAgo } from '@/lib/notifications'
import { cn } from '@/lib/cn'

interface AdminStatus {
  webPush: { vapidReady: boolean; subscriptionCount: number }
  telegram: { configured: boolean; tokenMasked?: string; ok?: boolean; username?: string; error?: string }
  smtp: { configured: boolean; host?: string; port?: number; secure?: boolean; user?: string; from?: string; allowSelfSigned?: boolean; passMasked?: string | null; ok?: boolean; error?: string }
  appUrl: string | null
  health: Record<'push' | 'telegram' | 'email', { ok: boolean; lastError?: string; failStreak: number }>
}

interface DeliveryRow {
  id: string
  user: string
  channel: string
  status: string
  title: string
  error: string | null
  attempts: number
  createdAt: number
}

function StatusChip({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
      ok ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
    )}>
      {ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
      {ok ? okText : badText}
    </span>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

export function AdminNotificationsTab({ openSignal }: { openSignal?: string }) {
  void openSignal // anchors handle scroll; sections are always open
  const [status, setStatus] = useState<AdminStatus | null>(null)
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([])

  const load = useCallback(() => {
    fetch('/api/admin/notify/status', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<AdminStatus>) : null))
      .then((data) => { if (data) setStatus(data) })
      .catch(() => {})
    fetch('/api/admin/notify/deliveries?limit=100', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<{ deliveries: DeliveryRow[] }>) : null))
      .then((data) => { if (data) setDeliveries(data.deliveries) })
      .catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  // ── Telegram ──
  const [token, setToken] = useState('')
  const [tgBusy, setTgBusy] = useState(false)
  const [confirmTgRemove, setConfirmTgRemove] = useState(false)

  const saveToken = async () => {
    setTgBusy(true)
    try {
      const res = await fetch('/api/admin/notify/telegram', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: token }),
      })
      const data = await res.json() as { error?: string; botUsername?: string }
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      toast.success(`Connected as @${data.botUsername}`)
      setToken('')
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setTgBusy(false)
    }
  }

  const removeToken = useCallback(async () => {
    await fetch('/api/admin/notify/telegram', { method: 'DELETE', credentials: 'include' })
    toast.success('Telegram bot removed')
    load()
  }, [load])

  // ── SMTP ──
  const [smtpForm, setSmtpForm] = useState({ host: '', port: '587', secure: false, user: '', pass: '', from: '', allowSelfSigned: false })
  const [smtpLoaded, setSmtpLoaded] = useState(false)
  const [smtpBusy, setSmtpBusy] = useState(false)
  const [testTo, setTestTo] = useState('')

  useEffect(() => {
    if (!status || smtpLoaded) return
    if (status.smtp.configured) {
      setSmtpForm({
        host: status.smtp.host ?? '',
        port: String(status.smtp.port ?? 587),
        secure: !!status.smtp.secure,
        user: status.smtp.user ?? '',
        pass: status.smtp.passMasked ?? '',
        from: status.smtp.from ?? '',
        allowSelfSigned: !!status.smtp.allowSelfSigned,
      })
    }
    setSmtpLoaded(true)
  }, [status, smtpLoaded])

  const saveSmtp = async () => {
    setSmtpBusy(true)
    try {
      const res = await fetch('/api/admin/notify/smtp', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...smtpForm, port: Number(smtpForm.port) }),
      })
      const data = await res.json() as { error?: string; verify?: { ok: boolean; error?: string } }
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      if (data.verify?.ok) toast.success('SMTP saved and verified')
      else toast.warning(`Saved, but verification failed: ${data.verify?.error ?? 'unknown error'}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSmtpBusy(false)
    }
  }

  const sendTestEmail = async () => {
    try {
      const res = await fetch('/api/admin/notify/smtp/test', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testTo }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Send failed')
      toast.success(`Test email sent to ${testTo}`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // ── App URL ──
  const [appUrl, setAppUrl] = useState('')
  const [appUrlLoaded, setAppUrlLoaded] = useState(false)
  useEffect(() => {
    if (status && !appUrlLoaded) { setAppUrl(status.appUrl ?? ''); setAppUrlLoaded(true) }
  }, [status, appUrlLoaded])

  const saveAppUrl = async () => {
    const res = await fetch('/api/admin/notify/app-url', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appUrl }),
    })
    const data = await res.json() as { error?: string }
    if (!res.ok) toast.error(data.error ?? 'Save failed')
    else toast.success('App URL saved')
  }

  if (!status) {
    return <SkeletonListRows count={4} className="p-5" />
  }

  return (
    <div className="space-y-3 p-5">
      {/* Telegram bot */}
      <AdminAccordion id="telegram" title="Telegram Bot"
        description="A household bot that delivers notifications and lets users chat with their companion from Telegram.">
        <div className="space-y-4">
          {status.telegram.configured ? (
            <div className="flex items-center gap-3">
              <StatusChip
                ok={!!status.telegram.ok}
                okText={`Connected as @${status.telegram.username}`}
                badText={`Token error: ${status.telegram.error ?? 'unreachable'}`}
              />
              <span className="text-xs text-muted-foreground">Token {status.telegram.tokenMasked}</span>
              <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => setConfirmTgRemove(true)}>
                Remove
              </Button>
            </div>
          ) : (
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>In Telegram, message <span className="font-medium text-foreground">@BotFather</span></li>
              <li>Send <code className="rounded bg-muted px-1">/newbot</code> and pick a name (e.g. "Our House Bot")</li>
              <li>Copy the token BotFather gives you and paste it below</li>
            </ol>
          )}
          <div className="flex items-center gap-2">
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={status.telegram.configured ? 'Paste a new token to replace' : '123456789:ABC…'}
              className="h-9 max-w-md font-mono text-sm"
            />
            <Button size="sm" disabled={tgBusy || !token.trim()} onClick={() => void saveToken()}>
              {tgBusy ? <Spinner size="sm" className="text-current" /> : 'Save & verify'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Once connected, each user links their own account in Settings → Notifications. The bot only answers linked users.
          </p>
        </div>
      </AdminAccordion>

      {/* Email / SMTP */}
      <AdminAccordion id="email" title="Email (SMTP)"
        description="Send notifications and daily summaries by email using any SMTP account (Gmail or iCloud app password, or a local relay).">
        <div className="space-y-4">
          {status.smtp.configured && (
            <StatusChip
              ok={!!status.smtp.ok}
              okText="Connected"
              badText={`Connection failed: ${status.smtp.error ?? 'unknown'}`}
            />
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="SMTP host"><Input value={smtpForm.host} onChange={(e) => setSmtpForm({ ...smtpForm, host: e.target.value })} placeholder="smtp.gmail.com" className="h-9 text-sm" /></Field>
            <Field label="Port"><Input value={smtpForm.port} onChange={(e) => setSmtpForm({ ...smtpForm, port: e.target.value })} placeholder="587" inputMode="numeric" className="h-9 text-sm" /></Field>
            <Field label="Username"><Input value={smtpForm.user} onChange={(e) => setSmtpForm({ ...smtpForm, user: e.target.value })} placeholder="you@gmail.com" className="h-9 text-sm" /></Field>
            <Field label="Password"><Input value={smtpForm.pass} onChange={(e) => setSmtpForm({ ...smtpForm, pass: e.target.value })} type="password" placeholder="app password" className="h-9 text-sm" /></Field>
            <Field label='"From" address'><Input value={smtpForm.from} onChange={(e) => setSmtpForm({ ...smtpForm, from: e.target.value })} placeholder="MaiPai <you@example.com>" className="h-9 text-sm" /></Field>
            <div className="flex items-end gap-6 pb-1">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={smtpForm.secure} onCheckedChange={(v) => setSmtpForm({ ...smtpForm, secure: v })} /> Implicit TLS (port 465)
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={smtpForm.allowSelfSigned} onCheckedChange={(v) => setSmtpForm({ ...smtpForm, allowSelfSigned: v })} /> Allow self-signed
              </label>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Gmail/iCloud need an <span className="font-medium">app password</span> (not your normal password). Create one in your account's security settings. Port 587 with TLS off here (STARTTLS) is the usual choice.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={smtpBusy || !smtpForm.host || !smtpForm.from} onClick={() => void saveSmtp()}>
              {smtpBusy ? <Spinner size="sm" className="text-current" /> : 'Save & verify'}
            </Button>
            {status.smtp.configured && (
              <div className="flex items-center gap-2">
                <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="send a test to…" type="email" className="h-8 w-52 text-sm" />
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" disabled={!testTo.includes('@')} onClick={() => void sendTestEmail()}>
                  <Send className="size-3" /> Test
                </Button>
              </div>
            )}
          </div>
        </div>
      </AdminAccordion>

      {/* Web push */}
      <AdminAccordion id="web-push" title="Web Push"
        description="Browser/device notifications. Nothing to configure: users enable it per-device in their own Settings.">
        <div className="flex flex-wrap items-center gap-3">
          <StatusChip ok={status.webPush.vapidReady} okText="Keys ready" badText="Keys missing" />
          <span className="text-sm text-muted-foreground">
            {status.webPush.subscriptionCount} device{status.webPush.subscriptionCount === 1 ? '' : 's'} subscribed across the household
          </span>
        </div>
        <div className="mt-4 flex items-end gap-2">
          <Field label="App URL (used to make links in Telegram/email messages clickable)">
            <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="http://maipai.local:3000" className="h-9 w-72 text-sm" />
          </Field>
          <Button variant="outline" size="sm" className="h-9" onClick={() => void saveAppUrl()}>Save</Button>
        </div>
      </AdminAccordion>

      {/* Health + delivery log */}
      <AdminAccordion id="log" title="Health & Delivery Log"
        description="Recent delivery attempts across every channel: the first place to look when someone says a notification never arrived.">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {(['push', 'telegram', 'email'] as const).map((ch) => {
            const h = status.health[ch]
            return (
              <StatusChip
                key={ch}
                ok={h.ok}
                okText={`${ch} ok`}
                badText={`${ch}: ${h.failStreak} failure${h.failStreak === 1 ? '' : 's'}${h.lastError ? ` - ${h.lastError.slice(0, 60)}` : ''}`}
              />
            )
          })}
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs ml-auto" onClick={load}>
            <RefreshCw className="size-3" /> Refresh
          </Button>
        </div>

        {deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deliveries yet. They'll appear here once a notification is sent to a connected channel.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border/50">
                  <th className="py-1.5 pr-3 font-medium">When</th>
                  <th className="py-1.5 pr-3 font-medium">User</th>
                  <th className="py-1.5 pr-3 font-medium">Channel</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 pr-3 font-medium">Notification</th>
                  <th className="py-1.5 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b border-border/30">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{timeAgo(d.createdAt)}</td>
                    <td className="py-1.5 pr-3">{d.user}</td>
                    <td className="py-1.5 pr-3">{d.channel}</td>
                    <td className={cn('py-1.5 pr-3 font-medium', d.status === 'sent' ? 'text-success' : 'text-destructive')}>{d.status}</td>
                    <td className="py-1.5 pr-3 max-w-64 truncate">{d.title}</td>
                    <td className="py-1.5 max-w-72 truncate text-muted-foreground">{d.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminAccordion>

      <ConfirmDialog
        open={confirmTgRemove}
        onOpenChange={setConfirmTgRemove}
        title="Remove the Telegram bot?"
        description="Users will stop getting Telegram notifications and the companion bridge goes offline until a new token is saved."
        confirmLabel="Remove"
        destructive
        onConfirm={() => void removeToken()}
      />
    </div>
  )
}
