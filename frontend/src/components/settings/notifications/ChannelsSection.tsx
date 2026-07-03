// "Where you get notified" — one row per delivery channel: push on this device,
// Telegram (link/unlink + test), and email (verify-code flow + test).

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Mail, MonitorSmartphone, Send } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useAuth } from '@/context/AuthContext'
import { getPushSubscription, pushSupported, subscribeToPush, unsubscribeFromPush } from '@/lib/push'
import type { ChannelStatus } from '@/lib/notifications'
import { TelegramLinkDialog } from './TelegramLinkDialog'

const TG_CHARACTER_KEY = 'telegram.character_id'

/** Which companion answers when you chat with the bot (null = plain assistant). */
function TelegramCompanionPicker() {
  const { user } = useAuth()
  const [companions, setCompanions] = useState<{ id: string; name: string }[]>([])
  const [value, setValue] = useState<string>('')

  useEffect(() => {
    if (!user?.id) return
    fetch('/api/companions', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { companions?: { id: string; name: string }[] } | null) => {
        if (data?.companions) setCompanions(data.companions.map((c) => ({ id: c.id, name: c.name })))
      })
      .catch(() => {})
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        const saved = data?.[TG_CHARACTER_KEY]
        if (typeof saved === 'string') setValue(saved)
      })
      .catch(() => {})
  }, [user?.id])

  const change = (next: string) => {
    setValue(next)
    if (!user?.id) return
    void fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [TG_CHARACTER_KEY]: next || null }),
    })
  }

  if (!companions.length) return null
  return (
    <div className="mt-1.5 flex items-center gap-2 pl-8">
      <span className="text-[11px] text-muted-foreground">Answers as</span>
      <select
        value={value}
        onChange={(e) => change(e.target.value)}
        className="h-7 rounded-control border border-border/60 bg-transparent px-1.5 text-xs text-foreground"
      >
        <option value="">Assistant (no character)</option>
        {companions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </div>
  )
}

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

function ChannelRow({ icon, title, status, children }: {
  icon: React.ReactNode
  title: string
  status: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-4 rounded-control px-3 py-3 hover:bg-muted/40 transition-colors">
      <div className="text-muted-foreground shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <div className="text-xs text-muted-foreground">{status}</div>
      </div>
      {children}
    </div>
  )
}

async function testChannel(channel: 'push' | 'telegram' | 'email'): Promise<void> {
  const res = await fetch('/api/notify/test', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel }),
  })
  const data = await res.json() as { error?: string }
  if (!res.ok) throw new Error(data.error ?? 'Test failed')
}

export function ChannelsSection({ channels, onRefresh }: {
  channels: ChannelStatus | null
  onRefresh: () => void
}) {
  // Push (this device)
  const supported = pushSupported()
  const [subscribed, setSubscribed] = useState(false)
  const [checking, setChecking] = useState(true)
  const [pushBusy, setPushBusy] = useState(false)

  useEffect(() => {
    if (!supported) { setChecking(false); return }
    getPushSubscription().then((s) => setSubscribed(!!s)).finally(() => setChecking(false))
  }, [supported])

  const togglePush = async (enabled: boolean) => {
    setPushBusy(true)
    try {
      if (enabled) { await subscribeToPush(); setSubscribed(true); toast.success('Notifications enabled on this device') }
      else { await unsubscribeFromPush(); setSubscribed(false); toast.success('Notifications disabled on this device') }
      onRefresh()
    } catch (e) {
      toast.error((e as Error).message || 'Could not update notifications')
    } finally {
      setPushBusy(false)
    }
  }

  // Telegram
  const [linkOpen, setLinkOpen] = useState(false)
  const [confirmUnlink, setConfirmUnlink] = useState(false)

  const unlinkTelegram = useCallback(async () => {
    await fetch('/api/notify/channels/telegram', { method: 'DELETE', credentials: 'include' })
    toast.success('Telegram unlinked')
    onRefresh()
  }, [onRefresh])

  // Email
  const [emailInput, setEmailInput] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [confirmRemoveEmail, setConfirmRemoveEmail] = useState(false)

  const saveEmail = async () => {
    setEmailBusy(true)
    try {
      const res = await fetch('/api/notify/channels/email', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: emailInput }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Could not save the address')
      toast.success('Check your inbox for a 6-digit code')
      onRefresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setEmailBusy(false)
    }
  }

  const verifyEmail = async () => {
    setEmailBusy(true)
    try {
      const res = await fetch('/api/notify/channels/email/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeInput }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Verification failed')
      toast.success('Email verified 🎉')
      setCodeInput('')
      onRefresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setEmailBusy(false)
    }
  }

  const removeEmail = useCallback(async () => {
    await fetch('/api/notify/channels/email', { method: 'DELETE', credentials: 'include' })
    toast.success('Email removed')
    onRefresh()
  }, [onRefresh])

  const runTest = (channel: 'push' | 'telegram' | 'email') => {
    void testChannel(channel)
      .then(() => toast.success('Test sent, check the channel'))
      .catch((e: Error) => toast.error(e.message))
  }

  const tg = channels?.telegram
  const email = channels?.email

  return (
    <section>
      <p className="text-sm font-medium mb-1">Where you get notified</p>
      <p className="text-xs text-muted-foreground mb-4">
        Connect the places notifications should reach you. What gets sent where is up to you, below.
      </p>
      <div className="space-y-1">
        {/* This device (web push) */}
        <ChannelRow
          icon={<MonitorSmartphone className="size-4" />}
          title="This device"
          status={
            !supported
              ? (isIOS()
                ? 'On iPhone or iPad, add this app to your Home Screen first (Share → Add to Home Screen), then come back here.'
                : 'Not supported in this browser')
              : checking ? 'Checking…'
              : subscribed ? 'Enabled, notifications arrive even when the app is closed'
              : 'Off'
          }
        >
          {subscribed && (
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => runTest('push')}>
              <Send className="size-3" /> Test
            </Button>
          )}
          {checking || pushBusy
            ? <Spinner />
            : <Switch checked={subscribed} disabled={!supported} onCheckedChange={(v) => void togglePush(v)} />}
        </ChannelRow>

        {/* Telegram */}
        <div>
          <ChannelRow
            icon={<Send className="size-4" />}
            title="Telegram"
            status={
              !channels ? 'Loading…'
              : tg?.linked ? <>Linked{tg.label ? <> as <span className="font-medium text-foreground">{tg.label}</span></> : ''}, you can also chat with your companion there</>
              : channels.telegramAvailable ? 'Get notifications and chat with your companion from anywhere'
              : 'Not available yet, ask your admin to set up the Telegram bot'
            }
          >
            {tg?.linked ? (
              <>
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => runTest('telegram')}>
                  <Send className="size-3" /> Test
                </Button>
                <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => setConfirmUnlink(true)}>
                  Unlink
                </Button>
              </>
            ) : channels?.telegramAvailable ? (
              <Button size="sm" className="h-7 text-xs" onClick={() => setLinkOpen(true)}>Link Telegram</Button>
            ) : null}
          </ChannelRow>
          {tg?.linked && <TelegramCompanionPicker />}
        </div>

        {/* Email */}
        <ChannelRow
          icon={<Mail className="size-4" />}
          title="Email"
          status={
            !channels ? 'Loading…'
            : email?.verified ? <span className="font-medium text-foreground">{email.address}</span>
            : email ? `Code sent to ${email.address}, enter it here to confirm`
            : channels.emailAvailable ? 'Good for daily summaries and reports'
            : 'Not available yet, ask your admin to set up email (SMTP)'
          }
        >
          {email?.verified ? (
            <>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => runTest('email')}>
                <Send className="size-3" /> Test
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => setConfirmRemoveEmail(true)}>
                Remove
              </Button>
            </>
          ) : email ? (
            <div className="flex items-center gap-2">
              <Input
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="6-digit code"
                inputMode="numeric"
                className="h-8 w-28 text-sm"
              />
              <Button size="sm" className="h-8 text-xs" disabled={emailBusy || codeInput.trim().length !== 6} onClick={() => void verifyEmail()}>
                {emailBusy ? <Spinner size="sm" className="text-current" /> : 'Verify'}
              </Button>
            </div>
          ) : channels?.emailAvailable ? (
            <div className="flex items-center gap-2">
              <Input
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="you@example.com"
                type="email"
                className="h-8 w-44 text-sm"
              />
              <Button size="sm" className="h-8 text-xs" disabled={emailBusy || !emailInput.includes('@')} onClick={() => void saveEmail()}>
                {emailBusy ? <Spinner size="sm" className="text-current" /> : 'Save'}
              </Button>
            </div>
          ) : null}
        </ChannelRow>
      </div>

      <TelegramLinkDialog open={linkOpen} onOpenChange={setLinkOpen} onLinked={onRefresh} />
      <ConfirmDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title="Unlink Telegram?"
        description="You'll stop getting notifications there and the bot will no longer answer you."
        confirmLabel="Unlink"
        destructive
        onConfirm={() => void unlinkTelegram()}
      />
      <ConfirmDialog
        open={confirmRemoveEmail}
        onOpenChange={setConfirmRemoveEmail}
        title="Remove email?"
        description="You'll stop getting notifications and summaries at this address."
        confirmLabel="Remove"
        destructive
        onConfirm={() => void removeEmail()}
      />
    </section>
  )
}
