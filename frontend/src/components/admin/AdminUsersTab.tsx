import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Brain, Camera, Check, ChevronRight, KeyRound, MessageSquare, Search, Trash2, Users as UsersIcon, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { UserAvatar } from '@/components/shared/UserAvatar'
import { CONTENT_DIALS, type ContentDialValues } from '@/components/shared/contentDials'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { AdminAccordion } from '@/components/admin/AdminAccordion'
import { ContentProfilesManager } from '@/components/admin/ContentProfilesManager'

// ── Types ─────────────────────────────────────────────────────────────────────

interface UserRow {
  id: string
  firstName: string
  lastName: string
  nickname: string
  birthdate: string
  role: 'admin' | 'user'
  avatarUrl: string | null
  dicebearStyle: string | null
  dicebearSeed: string | null
  dicebearConfig: string | null
  hasPin: boolean
  createdAt: string
}

interface UserSummary extends UserRow {
  memories: number
  entities: number
  episodes: number
}

interface MemoryRow {
  id: string
  text: string
  category: string
  tier: string
  status: string
  importance: number
  pinned: boolean
  entityId: string | null
  createdAt: string
}

interface EntityRow {
  id: string
  name: string
  kind: string
  aliases: string
  importance: number
}

interface EpisodeRow {
  id: string
  summary: string
  messageCount: number
  createdAt: string
}

interface Scope {
  characterId: string | null
  characterName: string | null
  memories: MemoryRow[]
  entities: EntityRow[]
  episodes: EpisodeRow[]
}

interface UserDetail {
  user: { id: string; firstName: string; nickname: string }
  scopes: Scope[]
}

// ── API ───────────────────────────────────────────────────────────────────────

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: 'include', ...options })
    if (!r.ok) return null
    return await r.json() as T
  } catch {
    return null
  }
}

async function fetchUsers(): Promise<UserRow[]> {
  return (await apiFetch<UserRow[]>('/api/users')) ?? []
}

async function fetchMemorySummaries(): Promise<Record<string, { memories: number; entities: number; episodes: number }>> {
  const data = await apiFetch<Array<{ id: string; memories: number; entities: number; episodes: number }>>('/api/admin/memory')
  if (!data) return {}
  return Object.fromEntries(data.map((u) => [u.id, { memories: u.memories, entities: u.entities, episodes: u.episodes }]))
}

async function fetchUserDetail(userId: string): Promise<UserDetail | null> {
  return apiFetch<UserDetail>(`/api/admin/memory/${userId}`)
}

async function clearUserMemory(userId: string): Promise<void> {
  await apiFetch(`/api/admin/memory/${userId}`, { method: 'DELETE' })
}

async function clearScopeMemory(userId: string, characterId: string | null): Promise<void> {
  await apiFetch(`/api/admin/memory/${userId}/scope`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId }),
  })
}

async function deleteMemory(userId: string, memoryId: string): Promise<void> {
  await apiFetch(`/api/admin/memory/${userId}/memory/${memoryId}`, { method: 'DELETE' })
}

async function updateUser(userId: string, body: { firstName?: string; lastName?: string; nickname?: string }): Promise<void> {
  await apiFetch(`/api/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function setPin(userId: string, pin: string): Promise<void> {
  await apiFetch(`/api/users/${userId}/pin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
}

async function removePin(userId: string): Promise<void> {
  await apiFetch(`/api/users/${userId}/pin`, { method: 'DELETE' })
}

async function clearUserConversations(userId: string): Promise<void> {
  await apiFetch(`/api/users/${userId}/conversations`, { method: 'DELETE' })
}

async function uploadAvatar(userId: string, file: File): Promise<string | null> {
  const form = new FormData()
  form.append('file', file)
  const res = await apiFetch<{ avatarUrl: string }>(`/api/users/${userId}/avatar`, { method: 'PUT', body: form })
  return res?.avatarUrl ?? null
}

async function deleteAvatar(userId: string): Promise<void> {
  await apiFetch(`/api/users/${userId}/avatar`, { method: 'DELETE' })
}

// ── Protections + interaction style types + API ───────────────────────────────

interface UserProtections {
  blockProfanity: boolean
  blockUncensoredLlm: boolean
  blockAdultLoras: boolean
  blockAdultImages: boolean
  blockSensitiveTopics: boolean
}

interface InteractionStyle {
  language: 'simple' | 'conversational' | 'technical'
  depth: 'brief' | 'balanced' | 'thorough'
}

interface ProtectionsData {
  protections: UserProtections
  interactionStyle: InteractionStyle
}

async function fetchProtections(userId: string): Promise<ProtectionsData | null> {
  return apiFetch<ProtectionsData>(`/api/users/${userId}/protections`)
}

async function saveProtections(
  userId: string,
  protections: Partial<UserProtections>,
  interactionStyle?: Partial<InteractionStyle>,
): Promise<boolean> {
  const r = await fetch(`/api/users/${userId}/protections`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protections, interactionStyle }),
  })
  return r.ok
}

// ── Confirm button (requires two clicks) ─────────────────────────────────────

function ConfirmButton({ label, onConfirm, className }: {
  label: string
  onConfirm: () => Promise<void>
  className?: string
}) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'loading'>('idle')

  async function handleClick() {
    if (step === 'idle') { setStep('confirm'); return }
    setStep('loading')
    await onConfirm()
    setStep('idle')
  }

  return (
    <Button
      size="sm"
      variant={step === 'confirm' ? 'destructive' : 'outline'}
      className={cn('h-7 text-xs', className)}
      disabled={step === 'loading'}
      onClick={handleClick}
      onBlur={() => setStep((s) => s === 'confirm' ? 'idle' : s)}
    >
      {step === 'loading'
        ? <Spinner size="sm" className="h-3 w-3 text-current" />
        : step === 'confirm' ? 'Confirm?' : label}
    </Button>
  )
}

// ── Tier / status chips ───────────────────────────────────────────────────────

const TIER_STYLE: Record<string, string> = {
  durable:  'bg-success/10 text-success',
  episodic: 'bg-info/10 text-info',
}

const STATUS_STYLE: Record<string, string> = {
  superseded: 'bg-warning/10 text-warning',
  archived:   'bg-muted text-muted-foreground',
}

// ── Scope section (collapsed by default) ─────────────────────────────────────

function ScopeSection({ scope, userId, onChanged }: {
  scope: Scope
  userId: string
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const label = scope.characterName ?? 'User-global'
  const total = scope.memories.length + scope.entities.length + scope.episodes.length

  return (
    <div className="rounded-control border">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-1.5 text-left text-sm"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className="font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">
            {scope.memories.length}m · {scope.entities.length}e · {scope.episodes.length}ep
          </span>
        </button>
        {total > 0 && (
          <ConfirmButton
            label="Clear"
            onConfirm={async () => { await clearScopeMemory(userId, scope.characterId); onChanged() }}
          />
        )}
      </div>

      {open && total > 0 && (
        <div className="border-t divide-y">
          {/* Memories */}
          {scope.memories.length > 0 && (
            <div className="p-3 space-y-1">
              <p className="mb-2 text-overline text-muted-foreground">
                Memories
              </p>
              {scope.memories.map((m) => (
                <div key={m.id} className="flex items-start gap-2 rounded px-1.5 py-1 hover:bg-muted/40">
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="text-sm leading-snug">{m.text}</p>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">{m.category}</Badge>
                      <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', TIER_STYLE[m.tier])}>
                        {m.tier}
                      </Badge>
                      {m.status !== 'active' && (
                        <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', STATUS_STYLE[m.status])}>
                          {m.status}
                        </Badge>
                      )}
                      <span className="text-[10px] text-muted-foreground self-center">imp {m.importance}</span>
                    </div>
                  </div>
                  <button
                    onClick={async () => { await deleteMemory(userId, m.id); onChanged() }}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Entities */}
          {scope.entities.length > 0 && (
            <div className="p-3 space-y-1">
              <p className="mb-2 text-overline text-muted-foreground">
                Entities
              </p>
              {scope.entities.map((e) => {
                let aliases: string[] = []
                try { aliases = JSON.parse(e.aliases) as string[] } catch { /* */ }
                return (
                  <div key={e.id} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/40">
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">{e.kind}</Badge>
                    <span className="text-sm font-medium">{e.name}</span>
                    {aliases.length > 0 && (
                      <span className="text-xs text-muted-foreground truncate">
                        aka {aliases.slice(0, 3).join(', ')}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground shrink-0">imp {e.importance}</span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Episodes */}
          {scope.episodes.length > 0 && (
            <div className="p-3 space-y-1.5">
              <p className="mb-2 text-overline text-muted-foreground">
                Episodes
              </p>
              {scope.episodes.map((ep) => (
                <p key={ep.id} className="rounded bg-muted/30 px-2.5 py-2 text-sm text-muted-foreground leading-snug">
                  {ep.summary}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Expanded user detail (memory section) ─────────────────────────────────────

function UserMemoryDetail({ userId, onMemoryChange }: {
  userId: string
  onMemoryChange: () => void
}) {
  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    setDetail(await fetchUserDetail(userId))
    setLoading(false)
  }

  useEffect(() => { load() }, [userId])

  async function handleClearAll() {
    await clearUserMemory(userId)
    toast.success('Memory cleared')
    onMemoryChange()
    await load()
  }

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="h-4 w-4" />
      </div>
    )
  }

  if (!detail) return null

  const total = detail.scopes.reduce((n, s) => n + s.memories.length + s.entities.length + s.episodes.length, 0)

  return (
    <div className="px-4 pb-4 pt-2 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Brain className="h-3.5 w-3.5" />
          <span>
            {detail.scopes.reduce((n, s) => n + s.memories.length, 0)} memories ·{' '}
            {detail.scopes.reduce((n, s) => n + s.entities.length, 0)} entities ·{' '}
            {detail.scopes.reduce((n, s) => n + s.episodes.length, 0)} episodes
          </span>
        </div>
        {total > 0 && (
          <ConfirmButton
            label="Clear all memory"
            onConfirm={handleClearAll}
            className="text-destructive border-destructive/30 hover:bg-destructive/10"
          />
        )}
      </div>

      {total === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No memories stored.</p>
      ) : (
        <div className="space-y-2">
          {detail.scopes.map((scope) => (
            <ScopeSection
              key={scope.characterId ?? '__global__'}
              scope={scope}
              userId={userId}
              onChanged={() => { load(); onMemoryChange() }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── General tab ───────────────────────────────────────────────────────────────

function UserGeneralTab({ user, onUpdate }: {
  user: UserSummary
  onUpdate: (updates: Partial<UserSummary>) => void
}) {
  const [firstName, setFirstName] = useState(user.firstName)
  const [lastName, setLastName]   = useState(user.lastName)
  const [nickname, setNickname]   = useState(user.nickname)
  const [saving, setSaving]       = useState(false)
  const [saved, setSaved]         = useState(false)

  const [pinMode, setPinMode]     = useState<'idle' | 'setting'>('idle')
  const [pinInput, setPinInput]   = useState('')
  const [pinError, setPinError]   = useState('')
  const [pinSaving, setPinSaving] = useState(false)

  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const dirty = firstName !== user.firstName || lastName !== user.lastName || nickname !== user.nickname

  async function handleSave() {
    setSaving(true)
    await updateUser(user.id, { firstName, lastName, nickname })
    onUpdate({ firstName, lastName, nickname })
    setSaving(false)
    setSaved(true)
    toast.success('Profile updated')
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleSetPin() {
    if (!/^\d{4,6}$/.test(pinInput)) { setPinError('4–6 digits required'); return }
    setPinSaving(true)
    await setPin(user.id, pinInput)
    onUpdate({ hasPin: true })
    setPinMode('idle')
    setPinInput('')
    setPinSaving(false)
    toast.success('PIN set')
  }

  async function handleRemovePin() {
    await removePin(user.id)
    onUpdate({ hasPin: false })
    toast.success('PIN removed')
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    await uploadAvatar(user.id, file)
    onUpdate({ avatarUrl: `/api/users/${user.id}/avatar?t=${Date.now()}`, dicebearStyle: null, dicebearSeed: null, dicebearConfig: null })
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleAvatarRemove() {
    await deleteAvatar(user.id)
    onUpdate({ avatarUrl: null })
  }

  return (
    <div className="p-4 space-y-5">

      {/* ── Profile ── */}
      <div className="flex gap-4 items-start">

        {/* Avatar */}
        <div className="shrink-0">
          <div className="relative group">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="relative block h-[72px] w-[72px] overflow-hidden rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Change photo"
            >
              <UserAvatar user={user} className="h-[72px] w-[72px] rounded-card text-xl" />
              <div className="absolute inset-0 flex items-center justify-center rounded-card bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
                {uploading
                  ? <Spinner className="h-5 w-5 text-white" />
                  : <Camera className="h-5 w-5 text-white" />}
              </div>
            </button>
            {user.avatarUrl && !uploading && (
              <Button
                type="button"
                variant="outline"
                onClick={handleAvatarRemove}
                className="absolute -right-1.5 -top-1.5 h-5 w-5 p-0 shadow-sm text-muted-foreground hover:border-destructive hover:text-destructive"
                title="Remove photo"
                aria-label="Remove photo"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
        </div>

        {/* Fields */}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">First name</label>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Last name</label>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} className="h-8 text-sm" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Nickname</label>
            <Input value={nickname} onChange={(e) => setNickname(e.target.value)} className="h-8 text-sm" />
          </div>
          <div className="flex items-center justify-between pt-0.5">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', user.role === 'admin' ? 'border-warning/40 text-warning' : '')}
              >
                {user.role}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Joined {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '-'}
              </span>
            </div>
            {dirty && (
              <Button size="sm" onClick={handleSave} disabled={saving} className="h-7 text-xs">
                {saving
                  ? <Spinner size="sm" className="h-3 w-3 text-current" />
                  : saved
                    ? <><Check className="h-3 w-3 mr-1" />Saved</>
                    : 'Save'}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Separator />

      {/* ── PIN lock ── */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-muted">
              <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium leading-none">PIN lock</p>
              <p className="mt-1 text-xs text-muted-foreground">{user.hasPin ? 'PIN is set' : 'No PIN set'}</p>
            </div>
          </div>
          <div className="flex gap-1.5">
            {user.hasPin && (
              <ConfirmButton
                label="Remove"
                onConfirm={handleRemovePin}
                className="text-destructive border-destructive/30 hover:bg-destructive/10"
              />
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => { setPinMode((m) => m === 'idle' ? 'setting' : 'idle'); setPinInput(''); setPinError('') }}
            >
              {user.hasPin ? 'Change' : 'Set PIN'}
            </Button>
          </div>
        </div>
        {pinMode === 'setting' && (
          <div className="ml-[37px] space-y-1.5">
            <div className="flex gap-2">
              <Input
                type="password"
                inputMode="numeric"
                placeholder="4–6 digits"
                value={pinInput}
                onChange={(e) => { setPinInput(e.target.value); setPinError('') }}
                maxLength={6}
                className="h-8 text-sm w-32"
                onKeyDown={(e) => e.key === 'Enter' && handleSetPin()}
                autoFocus
              />
              <Button size="sm" className="h-8 text-xs" onClick={handleSetPin} disabled={pinSaving}>
                {pinSaving ? <Spinner size="sm" className="h-3 w-3 text-current" /> : 'Save'}
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => { setPinMode('idle'); setPinInput(''); setPinError('') }}>
                Cancel
              </Button>
            </div>
            {pinError && <p className="text-xs text-destructive">{pinError}</p>}
          </div>
        )}
      </div>

      <Separator />

      {/* ── Clear chats ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-muted">
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium leading-none">Clear all chats</p>
            <p className="mt-1 text-xs text-muted-foreground">Permanently deletes all conversations</p>
          </div>
        </div>
        <ConfirmButton
          label="Clear"
          onConfirm={async () => { await clearUserConversations(user.id); toast.success('Conversations cleared') }}
          className="text-destructive border-destructive/30 hover:bg-destructive/10"
        />
      </div>

    </div>
  )
}

// ── Per-user content profile assignment ───────────────────────────────────────

interface ProfileOption { slug: string; name: string; description: string; dials: ContentDialValues }

function UserContentCeiling({ userId }: { userId: string }) {
  const [profiles, setProfiles] = useState<ProfileOption[]>([])
  const [assigned, setAssigned] = useState<string | null>(null)
  const [pending, setPending] = useState<ProfileOption | null>(null)  // awaiting 100%-open confirmation

  useEffect(() => {
    void Promise.all([
      apiFetch<{ profiles: ProfileOption[] }>(`/api/admin/content/profiles`),
      apiFetch<{ slug: string }>(`/api/admin/content/users/${userId}/profile`),
    ]).then(([p, a]) => { setProfiles(p?.profiles ?? []); setAssigned(a?.slug ?? null) })
  }, [userId])

  async function commit(slug: string) {
    const prev = assigned
    setAssigned(slug)
    const r = await fetch(`/api/admin/content/users/${userId}/profile`, {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    })
    if (r.ok) toast.success('Profile assigned')
    else { setAssigned(prev); toast.error('Failed to assign profile') }
  }

  function choose(slug: string) {
    if (slug === assigned) return
    const profile = profiles.find((p) => p.slug === slug)
    const open100 = profile ? CONTENT_DIALS.filter((d) => profile.dials[d.key] === 'unrestricted') : []
    // Any profile with one or more fully-open categories → confirm first.
    if (open100.length > 0) { setPending(profile!); return }
    void commit(slug)
  }

  const pendingOpen = pending ? CONTENT_DIALS.filter((d) => pending.dials[d.key] === 'unrestricted').map((d) => d.label) : []

  return (
    <div className="rounded-card border border-border/50 bg-card/50 p-3 space-y-2">
      <div>
        <p className="text-sm font-medium leading-tight">Content profile</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Sets this user's ceiling across every category. New accounts start on the default profile.
          A companion can never exceed the user's profile.
        </p>
      </div>
      <select
        value={assigned ?? ''}
        onChange={(e) => choose(e.target.value)}
        className="w-full rounded-control border border-border/60 bg-background px-3 py-1.5 text-sm outline-none focus:border-brand/60"
      >
        {assigned === null && <option value="" disabled>Loading…</option>}
        {profiles.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
      </select>
      {assigned && (() => {
        const p = profiles.find((x) => x.slug === assigned)
        return p?.description ? <p className="text-xs text-muted-foreground">{p.description}</p> : null
      })()}

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => { if (!o) setPending(null) }}
        title={`Assign "${pending?.name}": fully unrestricted categories`}
        description={`This profile sets these categories to 100% (no limit): ${pendingOpen.join(', ')}. The user and their companions will be able to discuss these topics without restriction. Only sexual content involving minors and mass-casualty weapons remain blocked. Continue?`}
        confirmLabel="Assign anyway"
        onConfirm={() => { if (pending) void commit(pending.slug); setPending(null) }}
      />
    </div>
  )
}

// ── Per-user video allowlist (approved-only mode) ─────────────────────────────

interface AllowlistEntry { id: string; source: string; kind: 'creator' | 'video'; externalId: string; title: string | null; thumbnailUrl: string | null }
interface AllowlistCandidate { source: string; externalId: string; title: string; thumbnailUrl: string | null }

function UserVideoAllowlist({ userId }: { userId: string }) {
  const [enabled, setEnabled] = useState(false)
  const [entries, setEntries] = useState<AllowlistEntry[]>([])
  const [candidates, setCandidates] = useState<AllowlistCandidate[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    void Promise.all([
      apiFetch<{ enabled: boolean; entries: AllowlistEntry[] }>(`/api/admin/content/users/${userId}/video-allowlist`),
      apiFetch<{ candidates: AllowlistCandidate[] }>(`/api/admin/content/video-allowlist/candidates`),
    ]).then(([a, c]) => {
      setEnabled(a?.enabled === true)
      setEntries(a?.entries ?? [])
      setCandidates(c?.candidates ?? [])
    }).finally(() => setLoading(false))
  }, [userId])

  async function toggle(on: boolean) {
    const prev = enabled
    setEnabled(on)
    const r = await apiFetch<{ ok: boolean }>(`/api/admin/content/users/${userId}/video-allowlist`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }),
    })
    if (r?.ok) toast.success(on ? 'Approved-only videos on' : 'Approved-only videos off')
    else { setEnabled(prev); toast.error('Failed to save') }
  }

  async function approve(cand: AllowlistCandidate) {
    const r = await apiFetch<{ ok: boolean; entries: AllowlistEntry[] }>(`/api/admin/content/users/${userId}/video-allowlist/entries`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: cand.source, kind: 'creator', externalId: cand.externalId, title: cand.title, thumbnailUrl: cand.thumbnailUrl }),
    })
    if (r?.ok) setEntries(r.entries)
    else toast.error('Failed to approve')
  }

  async function remove(entryId: string) {
    const prev = entries
    setEntries(entries.filter((e) => e.id !== entryId))
    const r = await apiFetch<{ ok: boolean }>(`/api/admin/content/users/${userId}/video-allowlist/entries/${entryId}`, { method: 'DELETE' })
    if (!r?.ok) { setEntries(prev); toast.error('Failed to remove') }
  }

  const approvedKeys = new Set(entries.map((e) => `${e.source}:${e.externalId.toLowerCase()}`))
  const remaining = candidates.filter((c) => !approvedKeys.has(`${c.source}:${c.externalId.toLowerCase()}`))

  return (
    <div className="rounded-card border border-border/50 bg-card/50 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium leading-tight">Approved videos only</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            The strictest video setting: this person sees only creators you approve below.
            No search, no suggestions, no browsing beyond the approved list.
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={(v) => void toggle(v)} disabled={loading} />
      </div>

      {enabled && (
        <>
          {entries.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {entries.map((e) => (
                <span key={e.id} className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 py-1 pl-2.5 pr-1 text-xs">
                  <span className="max-w-40 truncate">{e.title || e.externalId}</span>
                  <span className="text-[10px] uppercase text-muted-foreground">{e.source}</span>
                  <button onClick={() => void remove(e.id)} aria-label={`Remove ${e.title || e.externalId}`}
                    className="grid size-4 place-items-center rounded-full hover:bg-foreground/10">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-warning">Nothing approved yet: they will see an empty Videos app until you approve creators below.</p>
          )}
          <select
            value=""
            onChange={(e) => {
              const cand = remaining.find((r) => `${r.source}:${r.externalId}` === e.target.value)
              if (cand) void approve(cand)
            }}
            className="w-full rounded-control border border-border/60 bg-background px-3 py-1.5 text-sm outline-none focus:border-brand/60"
          >
            <option value="" disabled>Approve a creator the household follows…</option>
            {remaining.map((r) => (
              <option key={`${r.source}:${r.externalId}`} value={`${r.source}:${r.externalId}`}>
                {r.title} ({r.source})
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  )
}

// ── Protections tab ───────────────────────────────────────────────────────────

function UserProtectionsTab({ userId }: { userId: string }) {
  const [data, setData] = useState<ProtectionsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [uncensoredWarning, setUncensoredWarning] = useState(false)

  useEffect(() => {
    fetchProtections(userId).then((d) => { setData(d); setLoading(false) })
  }, [userId])

  async function toggle(key: keyof UserProtections, value: boolean) {
    if (!data) return
    if (key === 'blockUncensoredLlm' && !value) {
      setUncensoredWarning(true)
      return
    }
    applyToggle(key, value)
  }

  async function applyToggle(key: keyof UserProtections, value: boolean) {
    if (!data) return
    const next = { ...data.protections, [key]: value }
    setData((d) => d ? { ...d, protections: next } : d)
    setSaving(true)
    const ok = await saveProtections(userId, next)
    setSaving(false)
    setSaved(true)
    if (ok) toast.success('Protection updated'); else toast.error('Failed to save')
    setTimeout(() => setSaved(false), 1500)
  }

  if (loading) {
    return <div className="flex justify-center py-8"><Spinner /></div>
  }

  if (!data) {
    return <p className="p-4 text-sm text-destructive">Failed to load protections.</p>
  }

  const p = data.protections

  const protectionItems: { key: keyof UserProtections; label: string; description: string }[] = [
    { key: 'blockProfanity',      label: 'Block profanity',       description: 'Masks profanity in AI responses (prompt + output filter).' },
    { key: 'blockUncensoredLlm',  label: 'Block uncensored LLM',  description: 'Prevents this user from using uncensored AI models.' },
    { key: 'blockAdultLoras',     label: 'Block adult LoRAs',     description: 'Revokes and prevents adult LoRA grants for this user.' },
    { key: 'blockAdultImages',    label: 'Block adult images',    description: 'Hides adult-flagged generated images for this user.' },
    { key: 'blockSensitiveTopics', label: 'Block sensitive topics', description: 'Instructs the AI to avoid violence, drugs, and adult themes.' },
  ]

  return (
    <div className="p-4 space-y-3">
      {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
      {saved && <p className="text-xs text-success">Saved</p>}

      <UserContentCeiling userId={userId} />
      <UserVideoAllowlist userId={userId} />

      {protectionItems.map(({ key, label, description }) => (
        <div key={key} className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium leading-tight">{label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          </div>
          <Switch checked={p[key]} onCheckedChange={(v) => toggle(key, v)} className="shrink-0 mt-0.5" />
        </div>
      ))}

      {/* Confirmation modal for disabling uncensored LLM block */}
      <Dialog open={uncensoredWarning} onOpenChange={(o) => { if (!o) setUncensoredWarning(false) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm text-warning">
              <AlertTriangle className="size-4 shrink-0" />
              Enable uncensored LLM?
            </DialogTitle>
            <DialogDescription>
              This removes all content filtering on AI responses for this user. Uncensored models can produce explicit, harmful, or offensive content.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setUncensoredWarning(false)}>Cancel</Button>
            <Button
              size="sm"
              className="bg-warning text-warning-foreground hover:bg-warning/90"
              onClick={() => { setUncensoredWarning(false); applyToggle('blockUncensoredLlm', false) }}
            >
              Allow uncensored
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Style tab ─────────────────────────────────────────────────────────────────

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-control border border-border overflow-hidden text-[11px]">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex-1 px-3 py-1.5 transition-colors',
            value === opt.value
              ? 'bg-foreground text-background font-medium'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function UserStyleTab({ userId }: { userId: string }) {
  const [data, setData] = useState<ProtectionsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetchProtections(userId).then((d) => { setData(d); setLoading(false) })
  }, [userId])

  async function updateStyle(patch: Partial<InteractionStyle>) {
    if (!data) return
    const next = { ...data.interactionStyle, ...patch }
    setData((d) => d ? { ...d, interactionStyle: next } : d)
    setSaving(true)
    const ok = await saveProtections(userId, {}, next)
    setSaving(false)
    setSaved(true)
    if (ok) toast.success('Style updated'); else toast.error('Failed to save')
    setTimeout(() => setSaved(false), 1500)
  }

  if (loading) {
    return <div className="flex justify-center py-8"><Spinner /></div>
  }

  if (!data) {
    return <p className="p-4 text-sm text-destructive">Failed to load style settings.</p>
  }

  const { language, depth } = data.interactionStyle

  return (
    <div className="p-4 space-y-5">
      {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
      {saved && <p className="text-xs text-success">Saved</p>}

      <div className="space-y-2">
        <div>
          <p className="text-sm font-medium">Language</p>
          <p className="text-xs text-muted-foreground mt-0.5">Vocabulary and sentence complexity in AI responses.</p>
        </div>
        <SegmentedControl
          options={[
            { value: 'simple', label: 'Simple & clear' },
            { value: 'conversational', label: 'Conversational' },
            { value: 'technical', label: 'Technical' },
          ]}
          value={language}
          onChange={(v) => updateStyle({ language: v })}
        />
      </div>

      <div className="space-y-2">
        <div>
          <p className="text-sm font-medium">Response depth</p>
          <p className="text-xs text-muted-foreground mt-0.5">How detailed AI responses are by default.</p>
        </div>
        <SegmentedControl
          options={[
            { value: 'brief', label: 'Brief-first' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'thorough', label: 'Thorough' },
          ]}
          value={depth}
          onChange={(v) => updateStyle({ depth: v })}
        />
      </div>

      <p className="text-xs text-muted-foreground">Users can adjust their own interaction style in Settings.</p>
    </div>
  )
}

// ── User row ──────────────────────────────────────────────────────────────────

type UserTab = 'general' | 'memory' | 'protections' | 'style'

const USER_TABS: { id: UserTab; label: string }[] = [
  { id: 'general',     label: 'General'     },
  { id: 'memory',      label: 'Memory'      },
  { id: 'protections', label: 'Protections' },
  { id: 'style',       label: 'Style'       },
]

function UserListRow({ user, selected, onSelect, onMemoryChange, onUserUpdate }: {
  user: UserSummary
  selected: boolean
  onSelect: (id: string, checked: boolean) => void
  onMemoryChange: () => void
  onUserUpdate: (id: string, updates: Partial<UserSummary>) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<UserTab>('general')
  const hasMemory = user.memories + user.entities + user.episodes > 0

  return (
    <div className="rounded-control border">
      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* Checkbox */}
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onSelect(user.id, e.target.checked)}
          className="h-4 w-4 rounded border-border accent-primary"
        />

        <UserAvatar user={user} className="h-7 w-7 text-[10px]" />

        {/* Name + role */}
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{user.firstName} {user.lastName}</span>
          {user.nickname !== user.firstName && (
            <span className="ml-1.5 text-xs text-muted-foreground">"{user.nickname}"</span>
          )}
        </div>

        <Badge
          variant="outline"
          className={cn('text-[10px] px-1.5 shrink-0', user.role === 'admin' ? 'border-warning/40 text-warning' : '')}
        >
          {user.role}
        </Badge>

        {/* Memory count */}
        {hasMemory && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {user.memories}m
          </span>
        )}

        {/* Expand toggle */}
        <button
          onClick={() => setExpanded((o) => !o)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn('h-4 w-4 transition-transform', expanded && 'rotate-90')} />
        </button>
      </div>

      {expanded && (
        <>
          <Separator />
          {/* Tab bar */}
          <div className="flex border-b px-4">
            {USER_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'px-3 py-2 text-sm transition-colors border-b-2 -mb-px',
                  activeTab === tab.id
                    ? 'border-primary text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {activeTab === 'general'     && <UserGeneralTab user={user} onUpdate={(updates) => onUserUpdate(user.id, updates)} />}
          {activeTab === 'memory'      && <UserMemoryDetail userId={user.id} onMemoryChange={onMemoryChange} />}
          {activeTab === 'protections' && <UserProtectionsTab userId={user.id} />}
          {activeTab === 'style'       && <UserStyleTab userId={user.id} />}
        </>
      )}
    </div>
  )
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export function AdminUsersTab({ openSignal }: { openSignal?: string } = {}) {
  const [users, setUsers] = useState<UserSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkClearing, setBulkClearing] = useState(false)
  const [bulkStep, setBulkStep] = useState<'idle' | 'confirm'>('idle')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: 'name' | 'role' | 'memory'; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' })

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase()
    const rows = term
      ? users.filter((u) => `${u.firstName} ${u.lastName} ${u.nickname}`.toLowerCase().includes(term))
      : users
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      if (sort.key === 'role') return dir * (a.role.localeCompare(b.role) || a.firstName.localeCompare(b.firstName))
      if (sort.key === 'memory') return dir * (a.memories - b.memories)
      return dir * `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`)
    })
  }, [users, q, sort])

  function toggleSort(key: 'name' | 'role' | 'memory') {
    setSort((s) => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })
  }

  async function load() {
    const [userRows, summaries] = await Promise.all([fetchUsers(), fetchMemorySummaries()])
    setUsers(userRows.map((u) => ({
      ...u,
      memories: summaries[u.id]?.memories ?? 0,
      entities: summaries[u.id]?.entities ?? 0,
      episodes: summaries[u.id]?.episodes ?? 0,
    })))
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function handleSelect(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      checked ? next.add(id) : next.delete(id)
      return next
    })
  }

  function handleUserUpdate(id: string, updates: Partial<UserSummary>) {
    setUsers((prev) => prev.map((u) => u.id === id ? { ...u, ...updates } : u))
  }

  function handleSelectAll(checked: boolean) {
    setSelected(checked ? new Set(users.map((u) => u.id)) : new Set())
  }

  async function handleBulkClear() {
    if (bulkStep === 'idle') { setBulkStep('confirm'); return }
    setBulkClearing(true)
    await Promise.all([...selected].map((id) => clearUserMemory(id)))
    setSelected(new Set())
    setBulkStep('idle')
    setBulkClearing(false)
    await load()
  }

  const allSelected = users.length > 0 && selected.size === users.length

  return (
    <div className="space-y-3 p-5">
      <AdminAccordion id="accounts" title="Accounts"
        description="Manage user accounts, memory, protections, and style."
        openSignal={openSignal} defaultOpen>
        <div className="space-y-3">
          {/* Toolbar: search-within + sort */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-control border border-border/60 bg-background px-2.5 py-1.5">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search users…"
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="flex items-center gap-1">
              {([['name', 'Name'], ['role', 'Role'], ['memory', 'Memory']] as const).map(([key, label]) => {
                const active = sort.key === key
                const Arrow = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown
                return (
                  <Button
                    key={key}
                    size="sm"
                    variant={active ? 'secondary' : 'ghost'}
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => toggleSort(key)}
                  >
                    {label}<Arrow className="size-3" />
                  </Button>
                )
              })}
            </div>
          </div>

          {/* Bulk action bar */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => handleSelectAll(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
              title="Select all"
            />
            {selected.size > 0 ? (
              <>
                <span className="text-sm text-muted-foreground">{selected.size} selected</span>
                <Button
                  size="sm"
                  variant={bulkStep === 'confirm' ? 'destructive' : 'outline'}
                  disabled={bulkClearing}
                  onClick={handleBulkClear}
                  onBlur={() => setBulkStep('idle')}
                >
                  {bulkClearing
                    ? <><Spinner size="sm" className="mr-1.5 h-3 w-3" /> Clearing…</>
                    : bulkStep === 'confirm'
                      ? 'Confirm clear?'
                      : `Clear memory (${selected.size})`}
                </Button>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                {q.trim() ? `${visible.length} of ${users.length} users` : `${users.length} users`}
              </span>
            )}
          </div>

          {/* User list */}
          <div className="space-y-2">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 rounded-control border px-3 py-2.5">
                  <Skeleton className="size-7 rounded-full" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="ml-auto h-5 w-12 rounded-full" />
                </div>
              ))
            ) : visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <div className="flex size-12 items-center justify-center rounded-card bg-muted">
                  <UsersIcon className="size-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium">{q.trim() ? 'No matching users' : 'No users yet'}</p>
                <p className="text-xs text-muted-foreground">
                  {q.trim() ? 'Try a different search term.' : 'Users appear here once they sign in.'}
                </p>
              </div>
            ) : (
              visible.map((u) => (
                <UserListRow
                  key={u.id}
                  user={u}
                  selected={selected.has(u.id)}
                  onSelect={handleSelect}
                  onMemoryChange={load}
                  onUserUpdate={handleUserUpdate}
                />
              ))
            )}
          </div>
        </div>
      </AdminAccordion>

      <AdminAccordion id="profiles" title="Content Profiles"
        description="Named per-category content ceilings. Assign one to each user above; new accounts get the default. A companion can never exceed the user's profile."
        openSignal={openSignal} defaultOpen={false}>
        <ContentProfilesManager embedded />
      </AdminAccordion>

    </div>
  )
}
