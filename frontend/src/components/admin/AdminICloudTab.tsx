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
import { AiGeneratedBadge } from '@/components/shared/AiGeneratedBadge'
import {
  listICloudAccounts, connectICloudAccount, probeICloudAccount,
  reconnectICloudAccount, disconnectICloudAccount,
  listICloudCalendars, setICloudCalendarEnabled, syncICloudAccount,
  getICloudMailStatus, getICloudMailVerdicts,
  type ICloudAccount, type ICloudCalendar, type ICloudMailAccountStatus,
  type ICloudMailVerdicts, type ICloudProbeStatus,
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

function AccountCard({ account, calendars, mail, onChanged }: {
  account: ICloudAccount
  calendars: ICloudCalendar[]
  mail: ICloudMailAccountStatus | null
  onChanged: () => void
}) {
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
      {mail && (
        <div className="flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
          <Mail className="h-3.5 w-3.5" />
          {mail.watcherConnected
            ? <span>Mail watcher connected. {mail.messagesIndexed} message{mail.messagesIndexed === 1 ? '' : 's'} indexed (headers only, no bodies stored).</span>
            : <span>Mail watcher not connected{mail.watcherError ? `: ${mail.watcherError}` : ''}.</span>}
        </div>
      )}
    </div>
  )
}

const BUCKET_STYLE: Record<'ignore' | 'notify' | 'respond', string> = {
  ignore: 'bg-muted text-muted-foreground',
  notify: 'bg-info/10 text-info',
  respond: 'bg-success/10 text-success',
}

function TriagePanel() {
  const [data, setData] = useState<ICloudMailVerdicts | null | undefined>(undefined)

  useEffect(() => {
    getICloudMailVerdicts().then(setData).catch(() => setData(null))
  }, [])

  if (data === undefined || data === null) return null   // gated off or loading

  const totals = new Map<string, number>()
  for (const a of data.aggregates) {
    totals.set(a.bucket, (totals.get(a.bucket) ?? 0) + a.n)
    totals.set(`m:${a.method}`, (totals.get(`m:${a.method}`) ?? 0) + a.n)
  }
  const total = (totals.get('ignore') ?? 0) + (totals.get('notify') ?? 0) + (totals.get('respond') ?? 0)
  const heuristicShare = total ? Math.round(((totals.get('m:heuristic') ?? 0) / total) * 100) : 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Mail triage (dry run)</CardTitle>
            <CardDescription>
              Verdicts are recorded but never move or delete mail. Tune here before any actions ship.
            </CardDescription>
          </div>
          <AiGeneratedBadge label="Judged locally" title="Uncertain messages are classified by the local model; most resolve by rules alone." />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2 text-xs">
          {(['notify', 'respond', 'ignore'] as const).map((b) => (
            <span key={b} className={cn('rounded-full px-2.5 py-1', BUCKET_STYLE[b])}>
              {b}: {totals.get(b) ?? 0}
            </span>
          ))}
          <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
            {heuristicShare}% decided without the LLM
          </span>
        </div>
        {data.own.length === 0 ? (
          <p className="text-sm text-muted-foreground">No verdicts on your own mail yet.</p>
        ) : (
          <div className="space-y-2">
            <Label>Your recent verdicts</Label>
            <div className="space-y-1.5">
              {data.own.slice(0, 12).map((v) => (
                <div key={v.id} className="flex items-center gap-2 text-xs">
                  <span className={cn('shrink-0 rounded-full px-2 py-0.5', BUCKET_STYLE[v.bucket])}>{v.bucket}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground/80">
                    {v.subject ?? 'No subject'}
                    <span className="text-muted-foreground"> from {v.fromName ?? 'unknown'}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground/70" title={v.reason}>
                    {v.method === 'llm' ? 'AI' : 'rule'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function VipEditor({ member }: { member: MemberRow }) {
  const [vips, setVips] = useState<string[] | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    fetch(`/api/users/${member.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((prefs: Record<string, unknown>) => {
        const v = prefs['icloud-mail.vip']
        setVips(Array.isArray(v) ? v.map(String) : [])
      })
      .catch(() => setVips([]))
  }, [member.id])

  async function save(next: string[]) {
    setVips(next)
    await fetch(`/api/users/${member.id}/preferences`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'icloud-mail.vip': next }),
    }).catch(() => toast.error('Could not save VIP list'))
  }

  if (vips === null) return null

  return (
    <div className="space-y-2 border-t pt-3">
      <Label>VIP senders</Label>
      <p className="text-xs text-muted-foreground">
        Mail from these addresses (or @domains) is always flagged for {member.nickname}.
      </p>
      {vips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {vips.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs">
              {v}
              <button onClick={() => void save(vips.filter((x) => x !== v))}
                className="text-muted-foreground hover:text-foreground">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input value={draft} placeholder="coach@example.com or @school.org" className="w-64"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              void save([...new Set([...vips, draft.trim().toLowerCase()])])
              setDraft('')
            }
          }} />
        <Button variant="outline" size="sm" disabled={!draft.trim()}
          onClick={() => { void save([...new Set([...vips, draft.trim().toLowerCase()])]); setDraft('') }}>
          Add
        </Button>
      </div>
    </div>
  )
}

export function AdminICloudTab() {
  const [members, setMembers] = useState<MemberRow[] | null>(null)
  const [accounts, setAccounts] = useState<ICloudAccount[] | null>(null)
  const [calendars, setCalendars] = useState<ICloudCalendar[]>([])
  const [mailStatus, setMailStatus] = useState<ICloudMailAccountStatus[] | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)   // member id with open form

  useEffect(() => { void load() }, [])
  async function load() {
    try {
      const [users, accts, cals, mail] = await Promise.all([
        fetch('/api/users', { credentials: 'include' }).then((r) => r.json() as Promise<MemberRow[]>),
        listICloudAccounts(),
        listICloudCalendars().catch(() => []),
        getICloudMailStatus().catch(() => null),
      ])
      setMembers(users)
      setAccounts(accts)
      setCalendars(cals)
      setMailStatus(mail)
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
                  ? (
                    <>
                      <AccountCard account={account} calendars={calendars.filter((c) => c.accountId === account.id)}
                        mail={mailStatus?.find((s) => s.accountId === account.id) ?? null} onChanged={load} />
                      {mailStatus !== null && <VipEditor member={m} />}
                    </>
                  )
                  : <ConnectForm member={m} onDone={() => { setConnecting(null); void load() }} />}
              </CardContent>
            )}
          </Card>
        )
      })}

      {mailStatus !== null && <TriagePanel />}
    </div>
  )
}
