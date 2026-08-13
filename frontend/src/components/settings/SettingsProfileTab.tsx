import { useRef, useState, useEffect } from 'react'
import { Camera, Check, Circle, KeyRound } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import { DicebearAvatarPicker } from '@/components/shared/DicebearAvatarPicker'
import { randomSeed } from '@/components/companion/styleSchemas'
import { usePresenceStatus } from '@/hooks/usePresenceStatus'
import { STATUS_PRESETS } from '@/lib/presence'

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: 'include', ...options })
    if (!r.ok) return null
    return await r.json() as T
  } catch {
    return null
  }
}

async function updateUser(userId: string, body: Record<string, unknown>) {
  await apiFetch(`/api/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function setPin(userId: string, pin: string) {
  await apiFetch(`/api/users/${userId}/pin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
}

async function removePin(userId: string) {
  await apiFetch(`/api/users/${userId}/pin`, { method: 'DELETE' })
}

async function uploadAvatar(userId: string, file: File): Promise<string | null> {
  const form = new FormData()
  form.append('file', file)
  const res = await apiFetch<{ avatarUrl: string }>(`/api/users/${userId}/avatar`, { method: 'PUT', body: form })
  return res?.avatarUrl ?? null
}

async function deleteAvatar(userId: string) {
  await apiFetch(`/api/users/${userId}/avatar`, { method: 'DELETE' })
}

// ── Profile tab ───────────────────────────────────────────────────────────────

type AvatarMode = 'photo' | 'avatar'

export function SettingsProfileTab() {
  const { user, refetch } = useAuth()

  const [firstName, setFirstName] = useState(user?.firstName ?? '')
  const [lastName, setLastName]   = useState(user?.lastName ?? '')
  const [nickname, setNickname]   = useState(user?.nickname ?? '')
  const [saving, setSaving]       = useState(false)
  const [saved, setSaved]         = useState(false)

  const [pinMode, setPinMode]     = useState<'idle' | 'setting'>('idle')
  const [pinInput, setPinInput]   = useState('')
  const [pinError, setPinError]   = useState('')
  const [pinSaving, setPinSaving] = useState(false)

  const [uploading, setUploading]       = useState(false)
  const [avatarMode, setAvatarMode]     = useState<AvatarMode>(
    user?.dicebearStyle && !user?.avatarUrl ? 'avatar' : 'photo',
  )
  const [dicebearStyle, setDicebearStyle] = useState(user?.dicebearStyle ?? 'avataaars')
  const [dicebearSeed, setDicebearSeed]   = useState(user?.dicebearSeed ?? randomSeed())
  const [dicebearConfig, setDicebearConfig] = useState<Record<string, unknown>>(user?.dicebearConfig ?? {})
  const [avatarSaving, setAvatarSaving] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)

  if (!user) return null

  const dirty = firstName !== user.firstName || lastName !== user.lastName || nickname !== user.nickname

  async function handleSave() {
    setSaving(true)
    await updateUser(user!.id, { firstName, lastName, nickname })
    await refetch()
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleSetPin() {
    if (!/^\d{4,6}$/.test(pinInput)) { setPinError('4–6 digits required'); return }
    setPinSaving(true)
    await setPin(user!.id, pinInput)
    await refetch()
    setPinMode('idle')
    setPinInput('')
    setPinSaving(false)
  }

  async function handleRemovePin() {
    await removePin(user!.id)
    await refetch()
  }

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    await uploadAvatar(user!.id, file)
    await refetch()
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handlePhotoRemove() {
    await deleteAvatar(user!.id)
    await refetch()
  }

  async function handleSaveAvatar() {
    setAvatarSaving(true)
    // Upload a photo clears dicebear; saving dicebear clears photo.
    if (user!.avatarUrl) await deleteAvatar(user!.id)
    await updateUser(user!.id, {
      dicebearStyle,
      dicebearSeed,
      dicebearConfig: JSON.stringify(dicebearConfig),
    })
    await refetch()
    setAvatarSaving(false)
  }

  async function handleClearAvatar() {
    await updateUser(user!.id, { dicebearStyle: null, dicebearSeed: null, dicebearConfig: null })
    await refetch()
  }

  const hasAvatar = !!(user.avatarUrl || (user.dicebearStyle && user.dicebearSeed))

  return (
    <div className="p-4 space-y-5">

      {/* ── Profile ── */}
      <div>

        {/* Fields */}
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-overline text-muted-foreground">First name</label>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-overline text-muted-foreground">Last name</label>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} className="h-8 text-sm" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-overline text-muted-foreground">Nickname</label>
            <Input value={nickname} onChange={(e) => setNickname(e.target.value)} className="h-8 text-sm" />
          </div>
          <div className="flex items-center justify-between pt-0.5">
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0', user.role === 'admin' ? 'border-warning/40 text-warning' : '')}
            >
              {user.role}
            </Badge>
            {dirty && (
              <Button size="sm" onClick={handleSave} disabled={saving} className="h-7 text-xs">
                {saving
                  ? <Spinner size="sm" className="text-current" />
                  : saved
                    ? <><Check className="h-3 w-3 mr-1" />Saved</>
                    : 'Save'}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Separator />

      {/* ── Status ── */}
      <StatusSection userId={user.id} />

      <Separator />

      {/* ── Avatar picker ── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">Profile picture</p>
          <div className="ml-auto flex rounded-control border border-border overflow-hidden text-[11px]">
            {(['photo', 'avatar'] as AvatarMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setAvatarMode(mode)}
                className={cn(
                  'px-3 py-1 capitalize transition-colors',
                  avatarMode === mode
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {avatarMode === 'photo' ? (
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading
                ? <Spinner size="sm" className="text-current" />
                : <Camera className="h-3.5 w-3.5" />}
              {user.avatarUrl ? 'Change photo' : 'Upload photo'}
            </Button>
            {user.avatarUrl && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-destructive hover:text-destructive"
                onClick={handlePhotoRemove}
              >
                Remove
              </Button>
            )}
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} />
          </div>
        ) : (
          <div className="space-y-4">
            <DicebearAvatarPicker
              style={dicebearStyle}
              seed={dicebearSeed}
              config={dicebearConfig}
              onChange={(s, seed, cfg) => { setDicebearStyle(s); setDicebearSeed(seed); setDicebearConfig(cfg) }}
            />
            <div className="flex items-center justify-end gap-2">
              {hasAvatar && (
                <Button size="sm" variant="ghost" className="h-8 text-xs text-destructive hover:text-destructive" onClick={handleClearAvatar}>
                  Remove
                </Button>
              )}
              <Button size="sm" className="h-8 text-xs" onClick={handleSaveAvatar} disabled={avatarSaving}>
                {avatarSaving ? <Spinner size="sm" className="text-current" /> : 'Apply avatar'}
              </Button>
            </div>
          </div>
        )}
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
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={handleRemovePin}
              >
                Remove
              </Button>
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
                {pinSaving ? <Spinner size="sm" className="text-current" /> : 'Save'}
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs"
                onClick={() => { setPinMode('idle'); setPinInput(''); setPinError('') }}>
                Cancel
              </Button>
            </div>
            {pinError && <p className="text-xs text-destructive">{pinError}</p>}
          </div>
        )}
      </div>

      <Separator />

      {/* ── Interaction style ── */}
      <InteractionStyleSection userId={user.id} />

      <Separator />

      {/* ── Custom instructions ── */}
      <CustomInstructionsSection userId={user.id} />

    </div>
  )
}

// User-authored standing instructions, injected into every chat turn's system
// prompt ("always use metric", "call me Cap", "keep advice practical"). The
// complement of the auto-derived memory profile: this one the user writes.
function CustomInstructionsSection({ userId }: { userId: string }) {
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch(`/api/users/${userId}/preferences`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((prefs: Record<string, unknown> | null) => {
        if (typeof prefs?.['chat.custom_instructions'] === 'string') {
          setText(prefs['chat.custom_instructions'])
        }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [userId])

  async function save() {
    setSaving(true)
    try {
      await fetch(`/api/users/${userId}/preferences`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'chat.custom_instructions': text.trim().slice(0, 1500) }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Custom instructions</p>
        {saving && <Spinner size="sm" />}
        {saved && <Check className="h-3 w-3 text-success" />}
      </div>
      <p className="text-xs text-muted-foreground">
        Anything your companion should always keep in mind: how to address you, standing
        preferences, things to always or never do. Applies to every chat.
      </p>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (loaded) void save() }}
        placeholder={'Examples:\nAlways use metric units.\nKeep recipes vegetarian.\nWhen I ask for code, give the code first and explain after.'}
        rows={4}
        maxLength={1500}
        className="resize-y"
      />
    </div>
  )
}

// ── Status ─────────────────────────────────────────────────────────────────

function StatusSection({ userId }: { userId: string }) {
  const { current, setStatus, busy } = usePresenceStatus(userId)
  const currentPreset = STATUS_PRESETS.find((p) => p.state === current)

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-muted">
          <Circle
            className="h-3.5 w-3.5 fill-current"
            style={{ color: currentPreset?.color ?? 'var(--muted-foreground)' }}
          />
        </div>
        <div>
          <p className="text-sm font-medium leading-none">Status</p>
          <p className="mt-1 text-xs text-muted-foreground">{currentPreset ? currentPreset.label : 'Not set'}</p>
        </div>
      </div>
      <div className="ml-[37px] flex flex-wrap gap-1.5">
        {STATUS_PRESETS.map((p) => (
          <button
            key={p.state}
            type="button"
            disabled={busy}
            onClick={() => setStatus(current === p.state ? null : p.state)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-60',
              current === p.state
                ? 'border-transparent text-white'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
            style={current === p.state ? { backgroundColor: p.color } : undefined}
          >
            <Circle className="size-2 shrink-0 fill-current" style={{ color: current === p.state ? undefined : p.color }} />
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Interaction style (self-service) ──────────────────────────────────────────

type Language = 'simple' | 'conversational' | 'technical'
type Depth = 'brief' | 'balanced' | 'thorough'

interface InteractionStyle {
  language: Language
  depth: Depth
}

function StyleSegmented<T extends string>({
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

function InteractionStyleSection({ userId }: { userId: string }) {
  const [style, setStyle] = useState<InteractionStyle>({ language: 'conversational', depth: 'balanced' })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch(`/api/users/${userId}/preferences`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((prefs: Record<string, unknown> | null) => {
        if (prefs?.interaction_style) {
          setStyle(prefs.interaction_style as InteractionStyle)
        }
      })
      .catch(() => {})
  }, [userId])

  async function save(patch: Partial<InteractionStyle>) {
    const next = { ...style, ...patch }
    setStyle(next)
    setSaving(true)
    try {
      await fetch(`/api/users/${userId}/preferences`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interaction_style: next }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Interaction style</p>
        {saving && <Spinner size="sm" />}
        {saved && <Check className="h-3 w-3 text-success" />}
      </div>

      <div className="space-y-1.5">
        <p className="text-overline text-muted-foreground">Language</p>
        <StyleSegmented
          options={[
            { value: 'simple', label: 'Simple & clear' },
            { value: 'conversational', label: 'Conversational' },
            { value: 'technical', label: 'Technical' },
          ]}
          value={style.language}
          onChange={(v) => save({ language: v })}
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-overline text-muted-foreground">Response depth</p>
        <StyleSegmented
          options={[
            { value: 'brief', label: 'Brief-first' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'thorough', label: 'Thorough' },
          ]}
          value={style.depth}
          onChange={(v) => save({ depth: v })}
        />
      </div>
    </div>
  )
}
