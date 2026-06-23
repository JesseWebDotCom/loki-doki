// Frigate companion-announce engine. Mounted once near the app root (mirrors
// TimeAlarmProvider): polls for pending camera announcements and, for each one it
// can claim, speaks the line through the active companion. The server-side claim
// means only the first open client voices a given event, so multiple tabs don't
// double-speak. Purely a side-effect provider — it renders its children untouched.

import { useEffect, useRef } from 'react'
import { useAuth } from '@/context/AuthContext'
import { speak } from '@/lib/voice/voicePlaybackStore'
import { getActiveCompanionId } from '@/hooks/useActiveCompanion'
import { listPendingAnnouncements, claimAnnouncement } from '@/lib/frigate/api'

const POLL_MS = 6000

export function FrigateAnnounceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const attempting = useRef<Set<string>>(new Set())  // ids this client is mid-claim on

  useEffect(() => {
    if (!userId) return
    let cancelled = false

    const tick = async () => {
      if (document.visibilityState !== 'visible') return
      let items
      try { items = await listPendingAnnouncements() } catch { return }
      if (cancelled) return

      for (const item of items) {
        if (attempting.current.has(item.id)) continue
        attempting.current.add(item.id)
        // Claim server-side; only speak if we won (another client may have taken it).
        claimAnnouncement(item.id)
          .then((won) => {
            if (!won || cancelled || !item.title) return
            void speak({ text: item.title, characterId: getActiveCompanionId() }).catch(() => { /* TTS best-effort */ })
          })
          .catch(() => { /* let the next tick retry */ attempting.current.delete(item.id) })
      }
      // Bound the dedup set.
      if (attempting.current.size > 200) {
        attempting.current = new Set([...attempting.current].slice(-100))
      }
    }

    const poll = window.setInterval(() => { void tick() }, POLL_MS)
    return () => { cancelled = true; window.clearInterval(poll) }
  }, [userId])

  return <>{children}</>
}
