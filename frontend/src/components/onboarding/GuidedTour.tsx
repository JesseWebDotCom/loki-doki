import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Home, Sparkles, LayoutGrid, ShieldCheck, type LucideIcon } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'

const TOUR_PREF = 'onboarding.tour.completed'

interface TourStep {
  Icon: LucideIcon
  title: string
  body: string
}

// Concept-first: teach WHAT this is and WHY it is private, not merely where the buttons are.
const STEPS: TourStep[] = [
  {
    Icon: Home,
    title: 'Welcome to Loki Doki',
    body: 'This is your family’s private AI hub. It runs on your own hardware at home, so nothing your family says, asks, or creates ever leaves the house. No cloud accounts, no subscriptions.',
  },
  {
    Icon: Sparkles,
    title: 'Your companion',
    body: 'Chat, ask questions, create images, and more with a companion that remembers your family and runs entirely on your own machine. Say your wake word or tap it to start.',
  },
  {
    Icon: LayoutGrid,
    title: 'Everything in one place',
    body: 'Music, videos, books, maps, news, and home control all live in the App Store. Install what your household wants and arrange it on your home screen.',
  },
  {
    Icon: ShieldCheck,
    title: 'Safe for everyone',
    body: 'Each person gets their own profile with a content ceiling. Kids stay safe by default, and grown-ups can unlock more. You are always in control.',
  },
]

/** One-time, per-user concept tour (#12). Shown on the home screen the first time, gated on a
 *  per-user preference so it never repeats. Call resetGuidedTour to replay it from settings. */
export function GuidedTour() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  const queryClient = useQueryClient()
  const { data: completed, isSuccess } = useUserPreferences((p) => p[TOUR_PREF] === true)
  const [step, setStep] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  // Only on the home screen, only once prefs have loaded and the tour is not yet completed.
  const open = !!user && pathname === '/' && isSuccess && completed !== true && !dismissed

  function finish() {
    setDismissed(true)
    if (!user) return
    fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [TOUR_PREF]: true }),
    }).catch(() => {})
    patchUserPreferencesCache(queryClient, user.id, { [TOUR_PREF]: true })
  }

  const s = STEPS[step]!
  const isLast = step === STEPS.length - 1

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) finish() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="mb-2 flex size-12 items-center justify-center rounded-card bg-brand/10 text-brand">
            <s.Icon className="size-6" />
          </div>
          <DialogTitle>{s.title}</DialogTitle>
          <DialogDescription className="leading-relaxed">{s.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={cnDot(i === step)}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setStep((n) => n - 1)}>Back</Button>
            )}
            {!isLast && (
              <Button variant="ghost" size="sm" onClick={finish}>Skip</Button>
            )}
            <Button size="sm" onClick={() => (isLast ? finish() : setStep((n) => n + 1))}>
              {isLast ? 'Get started' : 'Next'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function cnDot(active: boolean): string {
  return active
    ? 'size-1.5 rounded-full bg-brand'
    : 'size-1.5 rounded-full bg-foreground/20'
}

/** Replay the tour (e.g. from a settings button): clears the completed flag. */
export function resetGuidedTour(queryClient: ReturnType<typeof useQueryClient>, userId: string): void {
  fetch(`/api/users/${userId}/preferences`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [TOUR_PREF]: false }),
  }).catch(() => {})
  patchUserPreferencesCache(queryClient, userId, { [TOUR_PREF]: false })
}
