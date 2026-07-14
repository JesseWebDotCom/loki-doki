import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { MapPin, LocateFixed, ShieldCheck } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useUserLocation } from '@/hooks/useUserLocation'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'
import { BrandMark } from '@/components/shared/BrandMark'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

// One-time location capture, shown once per account (admin or not) right after login/boot when
// no location is set yet. Storing it here means weather, the clock/world-time, local news, the
// daily briefing, and movie showtimes all personalize automatically. Skippable: a "prompted"
// flag keeps it from reappearing after a skip.
export function LocationOnboarding() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const prefs = useUserPreferences()
  const { location, status, error, detect, setManual } = useUserLocation()
  const [query, setQuery] = useState('')

  const onboarded = prefs.data?.['user.locationOnboarded'] === true
  const busy = status === 'detecting'

  const skip = async () => {
    if (!user?.id) return
    patchUserPreferencesCache(qc, user.id, { 'user.locationOnboarded': true })
    await fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'user.locationOnboarded': true }),
    }).catch(() => {})
  }

  // Preferences still loading: hold rather than flash the prompt (localStorage cache usually
  // makes this instant on repeat loads).
  if (prefs.isLoading && prefs.data === undefined) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Spinner size="lg" />
      </div>
    )
  }

  // Location already set, or the user already skipped: straight into the app.
  if (location || onboarded) return <Outlet />

  const save = () => {
    const q = query.trim()
    if (q) void setManual(q)
  }

  return (
    <div className="relative flex h-screen items-center justify-center overflow-hidden bg-background px-6">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-20 top-1/4 size-[600px] rounded-full bg-brand/10 blur-[150px]" />
        <div className="absolute bottom-0 right-0 size-[500px] rounded-full bg-brand/6 blur-[140px]" />
      </div>

      <div className="relative z-10 w-full max-w-md space-y-6">
        <div className="text-center">
          <BrandMark glow className="mx-auto size-12" />
          {/* design-ok(raw-h1-in-pages): full-screen onboarding step, mirrors SetupWizard/WelcomeWizard */}
          <h1 className="text-title mt-4">Where are you?</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            Set your location to personalize weather, the clock, local news, and movie showtimes. A ZIP code or city name is all it takes.
          </p>
        </div>

        <div className="space-y-3 rounded-card border border-border bg-card/60 p-5">
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              placeholder="ZIP code or city"
              className="h-11 pl-9 text-base"
              autoComplete="postal-code"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="button" size="xl" className="w-full" onClick={save} disabled={busy || !query.trim()}>
            {busy ? <Spinner className="text-current" /> : 'Continue'}
          </Button>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
          </div>

          <Button type="button" variant="secondary" className="w-full" onClick={() => void detect()} disabled={busy}>
            <LocateFixed className="size-4" /> Use my current location
          </Button>
        </div>

        <div className="flex items-center justify-between px-1">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 text-brand" /> Stays on your server
          </span>
          <button type="button" onClick={() => void skip()} className="text-xs text-muted-foreground hover:text-foreground">
            Skip for now
          </button>
        </div>
      </div>
    </div>
  )
}
