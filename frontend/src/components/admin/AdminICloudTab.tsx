// Admin → Integrations → Apple iCloud. Connect each family member's Apple Account
// with an app-specific password (ASP): what powers iCloud Calendar (and later Mail)
// features. Mirrors AdminMonitoringTab conventions. The ASP is write-only: it is
// never displayed back, and Apple revokes ASPs whenever the member changes their
// main Apple password, so every connected card carries a Reconnect path.

import { useEffect, useState } from 'react'
import { Calendar, Cloud, ExternalLink, FolderSync, Mail, Plug, RefreshCw, Trash2, Wifi } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import {
  listICloudAccounts, connectICloudAccount, probeICloudAccount,
  reconnectICloudAccount, disconnectICloudAccount,
  listICloudCalendars, setICloudCalendarEnabled, syncICloudAccount,
  type ICloudAccount, type ICloudCalendar, type ICloudProbeStatus,
} from '@/lib/icloud/api'

interface MemberRow { id: string; nickname: string; role: 'admin' | 'user' }

function StatusPill({ label, icon: Icon, status }: { label: string; icon: typeof Calendar; status: ICloudProbeStatus }) {
  const style = status === 'ok' ? 'bg-success/10 text-success'
    : status === 'auth_error' || status === 'error' ? 'bg-destructive/10 text-destructive'
    : 'bg-muted text-muted-foreground'
  const suffix = status === 'ok' ? '' : status === 'auth_error' ? ': reconnect' : status === 'error' ? ': unreachable' : ': not tested'
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs', style)}>
      <Icon className="h-3 w-3" />{label}{suffix}
    </span>
  )
}

function ConnectForm({ member, onDone }: { member: MemberRow; onDone: () => void }) {
  const [appleId, setAppleId] = useState('')
  const [appPassword, setAppPassword] = useState('')
  const [busy, setBusy] = useState(false)

  async function connect() {
    if (!appleId.trim() || !appPassword.trim()) return
    setBusy(true)
    try {
      const account = await connectICloudAccount({ userId: member.id, appleId, appPassword })
      const ok = account.caldavStatus === 'ok' || account.imapStatus === 'ok'
      if (ok) toast.success(`${member.nickname}'s Apple Account connected`)
      else toast.error(account.lastError || 'Connected, but Apple rejected the credentials. Check the app-specific password')
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Connection failed')
    }
    setBusy(false)
  }

  return (
    <div className="space-y-3 pt-1">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Apple ID</Label>
          <Input value={appleId} placeholder="name@icloud.com" autoComplete="off"
            onChange={(e) => setAppleId(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>App-specific password</Label>
          <Input type="password" value={appPassword} placeholder="xxxx-xxxx-xxxx-xxxx" autoComplete="off"
            onChange={(e) => setAppPassword(e.target.value)} />
        </div>
      </div>
      <Button onClick={connect} disabled={busy || !appleId.trim() || !appPassword.trim()}>
        {busy ? <Spinner className="h-4 w-4" /> : <Plug className="h-4 w-4" />}Connect
      </Button>
    </div>
  )
}

function CalendarList({ calendars, onChanged }: { calendars: ICloudCalendar[]; onChanged: () => void }) {
  async function toggle(cal: ICloudCalendar, enabled: boolean) {
    try { await setICloudCalendarEnabled(cal.id, enabled); onChanged() }
    catch { toast.error('Could not update calendar') }
  }
  if (!calendars.length) return null
  return (
    <div className="space-y-2 border-t pt-3">
      <Label>Calendars</Label>
      <div className="space-y-1.5">
        {calendars.map((cal) => (
          <div key={cal.id} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-sm">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: cal.colorHex ?? 'var(--muted-foreground)' }} />
              <span className="truncate">{cal.name}</span>
            </span>
            <Switch checked={cal.enabled} onCheckedChange={(v) => void toggle(cal, v)} />
          </div>
        ))}
      </div>
    </div>
  )
}

function AccountCard({ account, calendars, onChanged }: { account: ICloudAccount; calendars: ICloudCalendar[]; onChanged: () => void }) {
  const [testing, setTesting] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const needsReconnect = account.caldavStatus === 'auth_error' || account.imapStatus === 'auth_error'

  async function syncNow() {
    setSyncing(true)
    try {
      await syncICloudAccount(account.id)
      toast.success('Calendars synced')
      onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Sync failed') }
    setSyncing(false)
  }

  async function test() {
    setTesting(true)
    try {
      const a = await probeICloudAccount(account.id)
      if (a.caldavStatus === 'ok' && a.imapStatus === 'ok') toast.success('Apple accepted the connection')
      else toast.error(a.lastError || 'Probe failed')
      onChanged()
    } catch { toast.error('Probe failed') }
    setTesting(false)
  }

  async function reconnect() {
    if (!newPassword.trim()) return
    setBusy(true)
    try {
      const a = await reconnectICloudAccount(account.id, newPassword)
      if (a.caldavStatus === 'ok' || a.imapStatus === 'ok') toast.success('Reconnected')
      else toast.error(a.lastError || 'Apple rejected the new password')
      setReconnecting(false); setNewPassword('')
      onChanged()
    } catch { toast.error('Reconnect failed') }
    setBusy(false)
  }

  async function disconnect() {
    if (!confirm(`Disconnect ${account.userNickname}'s Apple Account? Synced data stays until the account is reconnected or cleaned up.`)) return
    try { await disconnectICloudAccount(account.id); toast.success('Disconnected'); onChanged() }
    catch { toast.error('Disconnect failed') }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{account.appleId}</span>
        <StatusPill label="Calendar" icon={Calendar} status={account.caldavStatus} />
        <StatusPill label="Mail" icon={Mail} status={account.imapStatus} />
      </div>
      {account.lastError && (account.caldavStatus !== 'ok' || account.imapStatus !== 'ok') && (
        <p className="text-xs text-destructive">{account.lastError}</p>
      )}
      {needsReconnect && !reconnecting && (
        <p className="text-xs text-muted-foreground">
          Apple revokes all app-specific passwords when the main Apple password changes. Generate a new one and reconnect.
        </p>
      )}
      {reconnecting ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label>New app-specific password</Label>
            <Input type="password" value={newPassword} placeholder="xxxx-xxxx-xxxx-xxxx" autoComplete="off"
              className="w-56" onChange={(e) => setNewPassword(e.target.value)} />
          </div>
          <Button onClick={reconnect} disabled={busy || !newPassword.trim()}>
            {busy ? <Spinner className="h-4 w-4" /> : null}Save
          </Button>
          <Button variant="ghost" onClick={() => { setReconnecting(false); setNewPassword('') }}>Cancel</Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={test} disabled={testing}>
            {testing ? <Spinner className="h-4 w-4" /> : <Wifi className="h-4 w-4" />}Test
          </Button>
          <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing || account.caldavStatus !== 'ok'}>
            {syncing ? <Spinner className="h-4 w-4" /> : <FolderSync className="h-4 w-4" />}Sync now
          </Button>
          <Button variant={needsReconnect ? 'default' : 'outline'} size="sm" onClick={() => setReconnecting(true)}>
            <RefreshCw className="h-4 w-4" />Reconnect
          </Button>
          <Button variant="outline" size="sm" onClick={disconnect}>
            <Trash2 className="h-4 w-4" />Disconnect
          </Button>
        </div>
      )}
      <CalendarList calendars={calendars} onChanged={onChanged} />
    </div>
  )
}

export function AdminICloudTab() {
  const [members, setMembers] = useState<MemberRow[] | null>(null)
  const [accounts, setAccounts] = useState<ICloudAccount[] | null>(null)
  const [calendars, setCalendars] = useState<ICloudCalendar[]>([])
  const [connecting, setConnecting] = useState<string | null>(null)   // member id with open form

  useEffect(() => { void load() }, [])
  async function load() {
    try {
      const [users, accts, cals] = await Promise.all([
        fetch('/api/users', { credentials: 'include' }).then((r) => r.json() as Promise<MemberRow[]>),
        listICloudAccounts(),
        listICloudCalendars().catch(() => []),
      ])
      setMembers(users)
      setAccounts(accts)
      setCalendars(cals)
    } catch { toast.error('Failed to load iCloud accounts') }
  }

  if (!members || !accounts) return <div className="flex justify-center p-12"><Spinner /></div>

  const byUser = new Map(accounts.map((a) => [a.userId, a]))

  return (
    <div className="space-y-6 max-w-3xl">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Cloud className="h-5 w-5" />
            <div>
              <CardTitle>Apple iCloud</CardTitle>
              <CardDescription>
                Connect each member's Apple Account to bring their iCloud calendar (and later mail) into
                Home, briefings, and the companion. Everything syncs to this server and stays local.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Connections use an <strong>app-specific password</strong>, not the member's real Apple password.
            Generate one at{' '}
            <a href="https://account.apple.com/account/manage" target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 underline underline-offset-2">
              account.apple.com <ExternalLink className="h-3 w-3" />
            </a>{' '}
            → Sign-In and Security → App-Specific Passwords (the account needs two-factor authentication, which is standard).
          </p>
          <p>
            Turn on the <strong>iCloud Calendar</strong> and <strong>iCloud Mail</strong> switches in
            Admin → Features to activate what a connection powers.
          </p>
        </CardContent>
      </Card>

      {members.map((m) => {
        const account = byUser.get(m.id)
        return (
          <Card key={m.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{m.nickname}</CardTitle>
                {!account && connecting !== m.id && (
                  <Button variant="outline" size="sm" onClick={() => setConnecting(m.id)}>
                    <Plug className="h-4 w-4" />Connect
                  </Button>
                )}
              </div>
            </CardHeader>
            {(account || connecting === m.id) && (
              <CardContent>
                {account
                  ? <AccountCard account={account} calendars={calendars.filter((c) => c.accountId === account.id)} onChanged={load} />
                  : <ConnectForm member={m} onDone={() => { setConnecting(null); void load() }} />}
              </CardContent>
            )}
          </Card>
        )
      })}
    </div>
  )
}
