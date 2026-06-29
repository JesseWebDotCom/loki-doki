// Frigate companion-announce engine. Mounted once near the app root (mirrors
// TimeAlarmProvider): polls for pending camera announcements and, for each one it
// can claim, speaks the line through the active companion. The server-side claim
// means only the first open client voices a given event, so multiple tabs don't
// double-speak. Purely a side-effect provider — it renders its children untouched.

import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { speak } from '@/lib/voice/voicePlaybackStore'
import { getActiveCompanionId } from '@/hooks/useActiveCompanion'
import { listPendingAnnouncements, claimAnnouncement, getFrigateStatus, type FrigateAnnouncement } from '@/lib/frigate/api'

const POLL_MS = 6000

function humanCamera(camera: string | null | undefined): string {
  if (!camera) return 'camera'
  return camera.replace(/[_-]+/g, ' ').trim() || 'camera'
}

function groupAnnouncements(items: FrigateAnnouncement[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]!.title ?? ''

  const persons = items.filter(i => i.kind === 'object' && i.label === 'person')
  const others  = items.filter(i => !(i.kind === 'object' && i.label === 'person'))

  const parts: string[] = []

  if (persons.length >= 2) {
    const cams = persons.map(p => humanCamera(p.camera))
    const last = cams.pop()!
    parts.push(`Someone's at the ${cams.join(', ')} and the ${last}.`)
  } else if (persons.length === 1) {
    if (persons[0]!.title) parts.push(persons[0]!.title)
  }

  for (const other of others) {
    if (other.title) parts.push(other.title)
  }

  return parts.filter(Boolean).join(' ')
}

export function FrigateAnnounceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const attempting = useRef<Set<string>>(new Set())  // ids this client is mid-claim on

  // Only poll for announcements when Frigate is actually set up. When it's off (or never
  // configured) this is the single request the client makes — no 6s announce loop.
  // Re-checked on window focus / every 5 min, so enabling Frigate starts polling without a reload.
  const { data: status } = useQuery({
    queryKey: ['frigate', 'status'],
    queryFn: getFrigateStatus,
    enabled: !!userId,
    staleTime: 5 * 60_000,
  })
  const frigateOn = !!status?.enabled

  useEffect(() => {
    if (!userId || !frigateOn) return
    let cancelled = false

    const tick = async () => {
      if (document.visibilityState !== 'visible') return
      let items: FrigateAnnouncement[]
      try { items = await listPendingAnnouncements() } catch { return }
      if (cancelled) return

      // Filter to items we haven't already tried to claim
      const toTry = items.filter(item => !attempting.current.has(item.id))
      if (!toTry.length) return

      toTry.forEach(item => attempting.current.add(item.id))

      // Claim all at once — winner speaks, losers stay silent
      const results = await Promise.allSettled(toTry.map(item => claimAnnouncement(item.id)))
      if (cancelled) return

      const won = toTry.filter((_, i) => {
        const r = results[i]
        return r?.status === 'fulfilled' && (r as PromiseFulfilledResult<boolean>).value
      })

      if (won.length > 0) {
        const text = groupAnnouncements(won)
        if (text) {
          void speak({ text, characterId: getActiveCompanionId() }).catch(() => { /* TTS best-effort */ })
        }
      }

      // Bound the dedup set
      if (attempting.current.size > 200) {
        attempting.current = new Set([...attempting.current].slice(-100))
      }
    }

    const poll = window.setInterval(() => { void tick() }, POLL_MS)
    return () => { cancelled = true; window.clearInterval(poll) }
  }, [userId, frigateOn])

  return <>{children}</>
}
