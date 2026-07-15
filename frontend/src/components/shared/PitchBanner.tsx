// A compact gradient "try this feature" pitch banner (icon + title + blurb + CTA)
// with a persistent dismiss X. Dismissal is stored per user in user_preferences
// under `prefKey`, so it sticks across visits and devices. The X follows the
// DismissableCard affordance: hover-revealed on pointer devices, always visible
// on touch. Hidden while preferences are still loading so a dismissed banner
// never flashes in on first paint.

import { useCallback, type ComponentType, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'

function useBannerDismissed(prefKey: string) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const prefsQuery = useUserPreferences()
  const loading = prefsQuery.data === undefined && !prefsQuery.isError
  const dismissed = loading || (prefsQuery.data ?? {})[prefKey] === true

  const dismiss = useCallback(() => {
    const userId = user?.id
    if (!userId) return
    patchUserPreferencesCache(queryClient, userId, { [prefKey]: true })
    fetch(`/api/users/${userId}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [prefKey]: true }),
    })
  }, [user?.id, queryClient, prefKey])

  return { dismissed, dismiss }
}

export function PitchBanner({ prefKey, icon: Icon, title, description, gradient, action }: {
  prefKey: string
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
  gradient?: string
  action: ReactNode
}) {
  const { dismissed, dismiss } = useBannerDismissed(prefKey)
  if (dismissed) return null

  return (
    <Card
      variant="gradient"
      style={gradient ? { background: gradient } : undefined}
      className="group/banner relative flex flex-col gap-4 p-6 sm:flex-row sm:items-center"
    >
      <div className="flex size-11 shrink-0 items-center justify-center rounded-control bg-white/15">
        <Icon className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-lg font-extrabold tracking-tight">{title}</p>
        <p className="mt-0.5 text-sm text-white/80">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
      {/* design-ok(hand-styled-button): icon-only dismiss X over gradient art, same affordance as DismissableCard */}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="absolute right-2 top-2 rounded-full p-1.5 text-white/70 opacity-0 transition-opacity hover:bg-white/15 hover:text-white focus-visible:opacity-100 group-hover/banner:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <X className="size-4" />
      </button>
    </Card>
  )
}
