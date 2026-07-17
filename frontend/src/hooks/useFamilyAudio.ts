import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

// The signed-in profile's family audio status (GET /api/family-audio/me): whether the
// time gate is open, minutes remaining, allowlist mode, and the volume cap. Enforcement
// is server-side; this hook powers the cooperative player UX (remaining-time chip,
// graceful stop, 5-minute warning, volume clamp, kids podcast lane).

export interface FamilyAudioStatus {
  allowed: boolean
  reason: 'quiet_hours' | 'time_budget' | null
  remainingMinutes: number | null
  usedMinutesToday: number
  allowlistOnly: boolean
  maxVolumePercent: number | null
  quietHoursStart: string | null
  quietHoursEnd: string | null
  restricted: boolean
}

async function fetchStatus(): Promise<FamilyAudioStatus> {
  const r = await fetch('/api/family-audio/me', { credentials: 'include' })
  if (!r.ok) throw new Error('family audio status unavailable')
  return r.json() as Promise<FamilyAudioStatus>
}

export function useFamilyAudio() {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['family-audio-me'],
    queryFn: fetchStatus,
    enabled: !!user,
    staleTime: 15_000,
    // Restricted profiles poll every 30s so the budget/quiet-hours boundary lands within
    // half a minute; unrestricted profiles only re-check occasionally.
    refetchInterval: (query) => (query.state.data?.restricted ? 30_000 : 5 * 60_000),
  })
}

/** "1h 05m" / "42m" for the remaining-time chip. */
export function formatRemaining(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`
  }
  return `${minutes}m`
}
