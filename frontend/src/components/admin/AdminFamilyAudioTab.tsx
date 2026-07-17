import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Hourglass, ListMusic, MoonStar, Music2, Podcast, Radio as RadioIcon,
  Search, ShieldCheck, ShieldX, Sparkles, Trash2, Volume2,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { cardVariants } from '@/components/ui/card'
import { ToggleRow } from '@/components/shared/ToggleRow'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { toast } from '@/lib/toast'

// Admin > Family Audio: per-profile kids/family audio controls. Allowlist-only mode +
// entries, blocklist, daily time budget, quiet hours, volume cap, and the weekly parent
// digests. Backend: routes/adminFamilyAudio.ts; enforcement: lib/family/audioPolicy.ts.

type EntryKind = 'artist' | 'station' | 'playlist' | 'podcastShow'
type EntryList = 'allow' | 'block'

interface FamilySettings {
  allowlistOnly: boolean
  dailyAudioMinutes: number | null
  quietHoursStart: string | null
  quietHoursEnd: string | null
  maxVolumePercent: number | null
}

interface FamilyUserRow {
  id: string
  name: string
  role: 'admin' | 'user'
  avatarUrl: string | null
  settings: FamilySettings
  allowCount: number
  blockCount: number
}

interface FamilyEntry {
  id: string
  list: EntryList
  kind: EntryKind
  ref: string
  label: string
}

interface FamilyUserDetail {
  settings: FamilySettings
  entries: FamilyEntry[]
  usage: { todayMinutes: number; weekMinutes: number }
}

interface EntryOption { ref: string; altRef?: string | null; label: string; sublabel?: string | null }

interface ChildDigest {
  userId: string
  name: string
  totalMinutes: number
  musicMinutes: number
  podcastMinutes: number
  dailyBudgetMinutes: number | null
  daysNearBudget: number
  topArtists: Array<{ name: string; plays: number }>
  topShows: Array<{ name: string; episodes: number }>
  blockedAttempts: number
  blockedLabels: string[]
}

interface Digest {
  id: string
  weekStart: string
  summary: string | null
  payload: { weekStart?: string; weekEnd?: string; children?: ChildDigest[] }
}

const KIND_META: Record<EntryKind, { label: string; Icon: typeof Music2 }> = {
  artist: { label: 'Artist', Icon: Music2 },
  station: { label: 'Station', Icon: RadioIcon },
  playlist: { label: 'Playlist', Icon: ListMusic },
  podcastShow: { label: 'Podcast', Icon: Podcast },
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' })
  if (!r.ok) throw new Error(`${url} failed (${r.status})`)
  return r.json() as Promise<T>
}

async function sendJson(url: string, method: string, body?: unknown): Promise<void> {
  const r = await fetch(url, {
    method, credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!r.ok) {
    const data = await r.json().catch(() => ({} as { error?: string }))
    throw new Error((data as { error?: string }).error ?? `Request failed (${r.status})`)
  }
}

export function AdminFamilyAudioTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-family-audio-users'],
    queryFn: () => getJson<{ users: FamilyUserRow[] }>('/api/admin/family-audio/users'),
  })
  const users = data?.users ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = users.find(u => u.id === selectedId) ?? users.find(u => u.role !== 'admin') ?? users[0]

  return (
    <div className="space-y-8 p-5">
      <div>
        <h2 className="text-lg font-bold tracking-tight">Family audio</h2>
        <p className="text-sm text-muted-foreground">
          Per-profile listening guardrails for music and podcasts: approved-only mode, blocked
          artists and shows, daily time budgets, quiet hours, and a volume cap.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <>
          {/* Profile picker */}
          <div className="flex flex-wrap gap-2">
            {users.map(u => (
              <button
                key={u.id}
                onClick={() => setSelectedId(u.id)}
                className={cn(
                  'flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold transition',
                  selected?.id === u.id
                    ? 'border-brand bg-brand text-brand-foreground'
                    : 'border-border/60 bg-card hover:border-brand/40',
                )}
              >
                {u.name}
                {u.settings.allowlistOnly && <ShieldCheck className="size-3.5" />}
              </button>
            ))}
          </div>

          {selected && <ProfilePanel key={selected.id} user={selected} />}

          <DigestPanel />
        </>
      )}
    </div>
  )
}

// ── Per-profile panel ─────────────────────────────────────────────────────────────────

function ProfilePanel({ user }: { user: FamilyUserRow }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['admin-family-audio-user', user.id],
    queryFn: () => getJson<FamilyUserDetail>(`/api/admin/family-audio/users/${user.id}`),
  })

  // Local mirror of the limit fields so typing does not fire a save per keystroke.
  const [budget, setBudget] = useState('')
  const [quietStart, setQuietStart] = useState('')
  const [quietEnd, setQuietEnd] = useState('')
  const [volumeCap, setVolumeCap] = useState('')
  useEffect(() => {
    const s = data?.settings
    if (!s) return
    setBudget(s.dailyAudioMinutes == null ? '' : String(s.dailyAudioMinutes))
    setQuietStart(s.quietHoursStart ?? '')
    setQuietEnd(s.quietHoursEnd ?? '')
    setVolumeCap(s.maxVolumePercent == null ? '' : String(s.maxVolumePercent))
  }, [data?.settings])

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin-family-audio-user', user.id] })
    void qc.invalidateQueries({ queryKey: ['admin-family-audio-users'] })
  }

  const saveSettings = useMutation({
    mutationFn: (patch: Partial<FamilySettings>) => {
      const s = data?.settings
      return sendJson(`/api/admin/family-audio/users/${user.id}/settings`, 'PUT', { ...s, ...patch })
    },
    onSuccess: () => { toast.success('Saved'); invalidate() },
    onError: (err: Error) => toast.error(err.message),
  })

  const removeEntry = useMutation({
    mutationFn: (entryId: string) => sendJson(`/api/admin/family-audio/users/${user.id}/entries/${entryId}`, 'DELETE'),
    onSuccess: () => { toast.success('Removed'); invalidate() },
    onError: (err: Error) => toast.error(err.message),
  })

  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  if (isLoading || !data) return <div className="flex justify-center py-10"><Spinner /></div>

  const saveLimits = () => {
    const n = (v: string) => (v.trim() === '' ? null : Number(v))
    saveSettings.mutate({
      dailyAudioMinutes: n(budget),
      quietHoursStart: quietStart.trim() === '' ? null : quietStart,
      quietHoursEnd: quietEnd.trim() === '' ? null : quietEnd,
      maxVolumePercent: n(volumeCap),
    })
  }

  const allow = data.entries.filter(e => e.list === 'allow')
  const block = data.entries.filter(e => e.list === 'block')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">{user.name}</span>
        <Badge variant="secondary">Today {data.usage.todayMinutes} min</Badge>
        <Badge variant="secondary">This week {data.usage.weekMinutes} min</Badge>
      </div>

      <ToggleRow
        title="Allowlist-only audio"
        description="Only approved artists, stations, playlists, and podcast shows are visible and playable on this profile. Search, suggestions, and discovery rails are limited to the approved list."
        checked={data.settings.allowlistOnly}
        onCheckedChange={() => saveSettings.mutate({ allowlistOnly: !data.settings.allowlistOnly })}
        chip={data.settings.allowlistOnly ? <Badge variant="info">Active</Badge> : undefined}
      />

      {/* Time budget, quiet hours, volume cap */}
      <div className={cn(cardVariants({ variant: 'surface' }), 'space-y-4 p-4')}>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold"><Hourglass className="size-4 text-muted-foreground" />Daily audio minutes</span>
            <Input type="number" min={5} max={1440} value={budget} onChange={e => setBudget(e.target.value)} placeholder="No limit" />
          </label>
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold"><MoonStar className="size-4 text-muted-foreground" />Quiet hours</span>
            <span className="flex items-center gap-2">
              <Input type="time" value={quietStart} onChange={e => setQuietStart(e.target.value)} />
              <span className="text-xs text-muted-foreground">to</span>
              <Input type="time" value={quietEnd} onChange={e => setQuietEnd(e.target.value)} />
            </span>
          </label>
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold"><Volume2 className="size-4 text-muted-foreground" />Volume cap %</span>
            <Input type="number" min={5} max={100} value={volumeCap} onChange={e => setVolumeCap(e.target.value)} placeholder="No cap" />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Leave a field empty to turn that limit off. The budget counts music and podcasts together,
          measured from real playback. Quiet hours may cross midnight (for example 20:30 to 07:00).
        </p>
        <Button size="sm" onClick={saveLimits} disabled={saveSettings.isPending}>Save limits</Button>
      </div>

      {/* Entry lists */}
      <div className="grid gap-4 lg:grid-cols-2">
        <EntryListCard
          title="Allowlist"
          icon={<ShieldCheck className="size-4 text-brand" />}
          empty={data.settings.allowlistOnly
            ? 'Nothing approved yet, so this profile currently sees no audio content. Add artists, stations, playlists, or shows below.'
            : 'Approved items only matter while allowlist-only mode is on.'}
          entries={allow}
          onRemove={setConfirmRemoveId}
        />
        <EntryListCard
          title="Blocklist"
          icon={<ShieldX className="size-4 text-destructive" />}
          empty="Nothing blocked. Blocked artists and shows disappear from search, suggestions, and playback for this profile."
          entries={block}
          onRemove={setConfirmRemoveId}
        />
      </div>

      <AddEntryForm userId={user.id} onAdded={invalidate} />

      <ConfirmDialog
        open={confirmRemoveId !== null}
        onOpenChange={open => !open && setConfirmRemoveId(null)}
        title="Remove this entry?"
        description="The item will no longer be allowed or blocked for this profile."
        confirmLabel="Remove"
        destructive
        onConfirm={() => { if (confirmRemoveId) { removeEntry.mutate(confirmRemoveId); setConfirmRemoveId(null) } }}
      />
    </div>
  )
}

function EntryListCard({ title, icon, empty, entries, onRemove }: {
  title: string
  icon: React.ReactNode
  empty: string
  entries: FamilyEntry[]
  onRemove: (entryId: string) => void
}) {
  return (
    <div className={cn(cardVariants({ variant: 'surface' }), 'p-4')}>
      <p className="mb-3 flex items-center gap-2 text-sm font-bold">{icon}{title}<span className="font-normal text-muted-foreground">({entries.length})</span></p>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map(e => {
            const { label, Icon } = KIND_META[e.kind]
            return (
              <li key={e.id} className="flex items-center gap-2 rounded-control bg-foreground/4 px-2.5 py-1.5">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{e.label}</span>
                <Badge variant="outline">{label}</Badge>
                <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground hover:text-destructive"
                  onClick={() => onRemove(e.id)} aria-label={`Remove ${e.label}`}>
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ── Add entry (search + add) ──────────────────────────────────────────────────────────

function AddEntryForm({ userId, onAdded }: { userId: string; onAdded: () => void }) {
  const [kind, setKind] = useState<EntryKind>('artist')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350)
    return () => clearTimeout(t)
  }, [query])

  const { data, isFetching } = useQuery({
    queryKey: ['admin-family-audio-options', kind, debounced],
    queryFn: () => getJson<{ options: EntryOption[] }>(
      `/api/admin/family-audio/options?kind=${kind}&q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length > 0 || kind === 'station' || kind === 'playlist',
    staleTime: 60_000,
  })
  const options = data?.options ?? []

  const add = useMutation({
    mutationFn: ({ option, list }: { option: EntryOption; list: EntryList }) =>
      sendJson(`/api/admin/family-audio/users/${userId}/entries`, 'POST', {
        list, kind, ref: option.ref, altRef: option.altRef ?? null, label: option.label,
      }),
    onSuccess: (_d, vars) => { toast.success(`${vars.option.label} ${vars.list === 'allow' ? 'allowed' : 'blocked'}`); onAdded() },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <div className={cn(cardVariants({ variant: 'surface' }), 'space-y-3 p-4')}>
      <p className="text-sm font-bold">Add to allowlist or blocklist</p>
      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(KIND_META) as EntryKind[]).map(k => (
          <button key={k} onClick={() => setKind(k)}
            className={cn(
              'rounded-full px-3 py-1 text-sm font-semibold transition',
              kind === k ? 'bg-brand text-brand-foreground' : 'bg-foreground/8 hover:bg-foreground/15',
            )}>
            {KIND_META[k].label}
          </button>
        ))}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={e => setQuery(e.target.value)} className="pl-9"
          placeholder={kind === 'artist' ? 'Search artists' : kind === 'podcastShow' ? 'Search the library and directory' : `Search ${KIND_META[kind].label.toLowerCase()}s`} />
      </div>
      {isFetching && <p className="text-xs text-muted-foreground">Searching…</p>}
      {options.length > 0 && (
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {options.map(o => (
            <li key={`${o.ref}`} className="flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-foreground/4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{o.label}</p>
                {o.sublabel && <p className="truncate text-xs text-muted-foreground">{o.sublabel}</p>}
              </div>
              <Button size="sm" variant="secondary" disabled={add.isPending}
                onClick={() => add.mutate({ option: o, list: 'allow' })}>Allow</Button>
              <Button size="sm" variant="outline" disabled={add.isPending}
                onClick={() => add.mutate({ option: o, list: 'block' })}>Block</Button>
            </li>
          ))}
        </ul>
      )}
      {!isFetching && debounced && options.length === 0 && (
        <p className="text-sm text-muted-foreground">No matches.</p>
      )}
    </div>
  )
}

// ── Weekly digests ────────────────────────────────────────────────────────────────────

function DigestPanel() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['admin-family-audio-digests'],
    queryFn: () => getJson<{ digests: Digest[] }>('/api/admin/family-audio/digests'),
  })
  const run = useMutation({
    mutationFn: () => sendJson('/api/admin/family-audio/digests/run', 'POST'),
    onSuccess: () => { toast.success('Digest generated'); void qc.invalidateQueries({ queryKey: ['admin-family-audio-digests'] }) },
    onError: (err: Error) => toast.error(err.message),
  })
  const digests = data?.digests ?? []

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <SectionHeader title="Weekly digests" lead="Per-child listening summaries, written every Monday morning." />
        <Button size="sm" variant="outline" onClick={() => run.mutate()} disabled={run.isPending}>
          <Sparkles className="mr-1.5 size-4" />
          {run.isPending ? 'Working…' : 'Generate now'}
        </Button>
      </div>
      {isLoading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : digests.length === 0 ? (
        <div className={cn(cardVariants({ variant: 'dashed' }), 'p-6 text-center text-sm text-muted-foreground')}>
          No digests yet. The first one is written automatically next Monday morning, or generate one now.
        </div>
      ) : (
        <div className="space-y-3">
          {digests.map(d => <DigestCard key={d.id} digest={d} />)}
        </div>
      )}
    </section>
  )
}

function DigestCard({ digest }: { digest: Digest }) {
  const children = (digest.payload.children ?? []).filter(k => k.totalMinutes > 0 || k.blockedAttempts > 0)
  return (
    <div className={cn(cardVariants({ variant: 'surface' }), 'space-y-3 p-4')}>
      <p className="text-sm font-bold">Week of {digest.weekStart}</p>
      {digest.summary && <p className="text-sm text-muted-foreground">{digest.summary}</p>}
      {children.length === 0 ? (
        <p className="text-sm text-muted-foreground">No listening recorded this week.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {children.map(k => (
            <div key={k.userId} className="rounded-card bg-foreground/4 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">{k.name}</p>
                <Badge variant="secondary">{k.totalMinutes} min</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {k.musicMinutes} min music, {k.podcastMinutes} min podcasts
                {k.dailyBudgetMinutes != null && k.daysNearBudget > 0 && ` · near the budget on ${k.daysNearBudget} day${k.daysNearBudget === 1 ? '' : 's'}`}
              </p>
              {k.topArtists.length > 0 && (
                <p className="mt-1.5 truncate text-xs"><span className="font-semibold">Top artists:</span> {k.topArtists.map(a => a.name).join(', ')}</p>
              )}
              {k.topShows.length > 0 && (
                <p className="mt-0.5 truncate text-xs"><span className="font-semibold">Top shows:</span> {k.topShows.map(s => s.name).join(', ')}</p>
              )}
              {k.blockedAttempts > 0 && (
                <p className="mt-0.5 text-xs text-destructive">
                  {k.blockedAttempts} blocked attempt{k.blockedAttempts === 1 ? '' : 's'}
                  {k.blockedLabels.length > 0 && ` (${k.blockedLabels.slice(0, 3).join(', ')})`}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
