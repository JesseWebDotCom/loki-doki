import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { cn } from '@/lib/cn'
import { Spinner } from '@/components/ui/spinner'
import { PinPad } from '@/components/shared/PinPad'
import { UserAvatar } from '@/components/shared/UserAvatar'
import { BrandMark } from '@/components/shared/BrandMark'

interface Profile {
  id: string
  firstName: string
  lastName: string
  nickname: string
  avatarUrl: string | null
  dicebearStyle?: string | null
  dicebearSeed?: string | null
  dicebearConfig?: string | null
  hasPin: boolean
}

function Avatar({ profile, size = 'lg' }: { profile: Profile; size?: 'lg' | 'sm' }) {
  const dim = size === 'lg' ? 'size-24 rounded-card' : 'size-14 rounded-card'
  const px = size === 'lg' ? 96 : 56
  return <UserAvatar user={profile} size={px} className={cn(dim)} />
}

// ── PIN entry (uses shared PinPad in verify mode) ────────────────────────────

interface PinEntryProps {
  profile: Profile
  onSuccess: () => void
  onBack: () => void
}

function PinEntry({ profile, onSuccess, onBack }: PinEntryProps) {
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)
  const [locked, setLocked]   = useState(0) // seconds remaining

  useEffect(() => {
    if (locked <= 0) return
    const t = setInterval(() => setLocked((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [locked])

  async function handleComplete(pin: string) {
    if (loading || locked > 0) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: profile.id, pin }),
      })
      if (res.ok) { onSuccess(); return }
      const body = await res.json() as { error: string; retryAfter?: number; attemptsLeft?: number }
      if (res.status === 429) {
        setLocked(body.retryAfter ?? 30)
        setError(`Too many attempts. Try again in ${body.retryAfter ?? 30}s.`)
      } else {
        const left = body.attemptsLeft
        setError(left !== undefined ? `Wrong PIN. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Wrong PIN.')
      }
    } catch {
      setError('Could not verify PIN.')
    } finally {
      setLoading(false)
    }
  }

  const subtitle = locked > 0 ? `Locked: try again in ${locked}s` : undefined

  return (
    <div className="flex flex-col items-center">
      <Avatar profile={profile} size="sm" />
      <p className="mt-3 text-base font-semibold">{profile.nickname}</p>
      <PinPad
        mode="verify"
        onComplete={handleComplete}
        error={error}
        loading={loading || locked > 0}
        onBack={onBack}
        subtitle={subtitle}
      />
    </div>
  )
}

// ── PIN setup (recovery for an admin account stuck with no PIN on record) ────

interface PinSetupProps {
  profile: Profile
  onSuccess: () => void
  onBack: () => void
}

function PinSetup({ profile, onSuccess, onBack }: PinSetupProps) {
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)

  async function handleComplete(pin: string) {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: profile.id, pin }),
      })
      if (res.ok) { onSuccess(); return }
      const body = await res.json().catch(() => null) as { error?: string } | null
      setError(body?.error ?? 'Could not set PIN.')
    } catch {
      setError('Could not set PIN.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-center">
      <Avatar profile={profile} size="sm" />
      <p className="mt-3 text-base font-semibold">{profile.nickname}</p>
      <p className="mt-1 max-w-[220px] text-center text-xs text-muted-foreground">
        This admin account has no PIN set, which is required to log in. Set one now to continue.
      </p>
      <PinPad
        mode="set"
        onComplete={handleComplete}
        error={error}
        loading={loading}
        onBack={onBack}
      />
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ProfilePickerPage() {
  const { refetch } = useAuth()
  const navigate = useNavigate()
  const [profiles, setProfiles]     = useState<Profile[]>([])
  const [loading, setLoading]       = useState(true)
  const [selected, setSelected]     = useState<Profile | null>(null)
  const [needsPinSetup, setNeedsPinSetup] = useState<Profile | null>(null)
  const [selecting, setSelecting]   = useState(false)
  const [selectError, setSelectError] = useState('')

  useEffect(() => {
    fetch('/api/auth/profiles')
      .then((r) => r.json())
      .then((data) => { setProfiles(data as Profile[]); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  async function selectProfile(profile: Profile) {
    if (profile.hasPin) {
      setSelected(profile)
      return
    }
    setSelecting(true)
    setSelectError('')
    try {
      const res = await fetch('/api/auth/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: profile.id }),
      })
      if (res.ok) {
        await refetch()
        navigate('/', { replace: true })
        return
      }
      const body = await res.json().catch(() => null) as { error?: string; needsPinSetup?: boolean } | null
      if (body?.needsPinSetup) {
        setNeedsPinSetup(profile)
      } else {
        setSelectError(body?.error ?? 'Could not log in.')
      }
    } catch {
      setSelectError('Could not log in.')
    } finally {
      setSelecting(false)
    }
  }

  async function handlePinSuccess() {
    await refetch()
    navigate('/', { replace: true })
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background">
      {/* Ambient glow */}
      {/* design-ok(raw-overlay): full-screen login flow ambient backdrop, pointer-events-none decoration */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-1/4 top-1/3 size-[500px] rounded-full bg-brand/8 blur-[140px]" />
        <div className="absolute right-1/4 bottom-1/3 size-[400px] rounded-full bg-info/8 blur-[120px]" />
      </div>

      <div className="relative z-10 flex flex-col items-center px-6 py-12">
        {/* Brand lockup: the glowing logo + wordmark + tagline from boot/setup */}
        <div className="mb-10 flex flex-col items-center">
          <BrandMark glow className="size-16" />
          <h2 className="mt-3 text-display">Loki Doki</h2>
          <p className="mt-1 text-xs text-muted-foreground">Your private AI home hub</p>
        </div>

        {needsPinSetup ? (
          <PinSetup
            profile={needsPinSetup}
            onSuccess={handlePinSuccess}
            onBack={() => setNeedsPinSetup(null)}
          />
        ) : selected ? (
          <PinEntry
            profile={selected}
            onSuccess={handlePinSuccess}
            onBack={() => setSelected(null)}
          />
        ) : (
          <>
            <h2 className="text-title">Who's there?</h2>
            <p className="mt-1 text-sm text-muted-foreground">Choose your profile to continue</p>

            {loading ? (
              <div className="mt-16">
                <Spinner size="lg" />
              </div>
            ) : (
              <div className="mt-12 flex flex-wrap justify-center gap-6">
                {profiles.map((profile) => (
                  <button
                    key={profile.id}
                    onClick={() => selectProfile(profile)}
                    disabled={selecting}
                    className="group flex flex-col items-center gap-3 rounded-card transition-opacity disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="relative transition-transform duration-150 group-hover:scale-105 group-active:scale-95">
                      <Avatar profile={profile} />
                      {profile.hasPin && (
                        <div className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full bg-card border border-border text-[10px]">
                          🔒
                        </div>
                      )}
                    </div>
                    <span className="text-sm font-medium text-foreground/80 group-hover:text-foreground transition-colors">
                      {profile.nickname}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {selectError && (
              <p className="mt-6 max-w-[260px] text-center text-xs text-destructive animate-in fade-in">
                {selectError}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
