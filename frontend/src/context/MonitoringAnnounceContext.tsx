// Monitoring companion-announce engine. Mounted once near the app root (mirrors
// FrigateAnnounceProvider): polls for pending service-alert lines and, for each one
// it can claim, speaks it through the active companion. The server-side claim means
// only the first open client voices a given alert, so tabs don't double-speak.
// Purely a side-effect provider - renders its children untouched.

import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { speak } from '@/lib/voice/voicePlaybackStore'
import { shouldSpeakProactively, isDockHudSurface } from '@/lib/voice/dockYield'
import { getActiveCompanionId } from '@/hooks/useActiveCompanion'
import {
  getMonitoringStatus, listPendingMonitoringAnnouncements, claimMonitoringAnnouncement,
  type MonitoringAnnouncement,
} from '@/lib/monitoring/api'

const POLL_MS = 6000

export function MonitoringAnnounceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const attempting = useRef<Set<string>>(new Set())  // ids this client is mid-claim on

  // Only poll once monitoring is set up - otherwise this is a single request, no 6s loop.
  const { data: status } = useQuery({
    queryKey: ['monitoring', 'status'],
    queryFn: getMonitoringStatus,
    enabled: !!userId,
    staleTime: 5 * 60_000,
  })
  const monitoringOn = !!status?.enabled

  useEffect(() => {
    if (!userId || !monitoringOn) return
    let cancelled = false

    const tick = async () => {
      // A tab yielded to MaiPai Desktop (and the dock's main window) must not claim -
      // the dock's HUD is the machine's announcer. The HUD itself polls even while
      // its window is hidden (visibilityState is 'hidden' but it must still speak).
      if (!shouldSpeakProactively()) return
      if (document.visibilityState !== 'visible' && !isDockHudSurface()) return
      let items: MonitoringAnnouncement[]
      try { items = await listPendingMonitoringAnnouncements() } catch { return }
      if (cancelled) return

      const toTry = items.filter((item) => !attempting.current.has(item.id))
      if (!toTry.length) return
      toTry.forEach((item) => attempting.current.add(item.id))

      const results = await Promise.allSettled(toTry.map((item) => claimMonitoringAnnouncement(item.id)))
      if (cancelled) return

      const won = toTry.filter((_, i) => {
        const r = results[i]
        return r?.status === 'fulfilled' && (r as PromiseFulfilledResult<boolean>).value
      })

      const text = won.map((w) => w.text).filter(Boolean).join(' ')
      if (text) void speak({ text, characterId: getActiveCompanionId() }).catch(() => { /* TTS best-effort */ })

      if (attempting.current.size > 200) {
        attempting.current = new Set([...attempting.current].slice(-100))
      }
    }

    const poll = window.setInterval(() => { void tick() }, POLL_MS)
    return () => { cancelled = true; window.clearInterval(poll) }
  }, [userId, monitoringOn])

  return <>{children}</>
}
