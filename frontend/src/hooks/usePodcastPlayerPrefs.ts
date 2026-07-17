import { useCallback, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'
import { getPlayerStats } from '@/lib/podcast/playerApi'
import { getSessionSavedSeconds, subscribeSavedSeconds } from '@/lib/podcastAudioGraph'

// Global (all-shows) podcast DSP toggles, persisted per user in user_preferences so they
// sync across devices. Per-show overrides live in podcast_show_settings and win when set.
export function usePodcastDspPrefs() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const prefsQuery = useUserPreferences()
  const voiceBoost = prefsQuery.data?.['podcasts.voiceBoost'] === true
  const trimSilence = prefsQuery.data?.['podcasts.trimSilence'] === true

  const set = useCallback((key: 'podcasts.voiceBoost' | 'podcasts.trimSilence', value: boolean) => {
    const userId = user?.id
    if (!userId) return
    patchUserPreferencesCache(queryClient, userId, { [key]: value })
    void fetch(`/api/users/${userId}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    })
  }, [user?.id, queryClient])

  return {
    voiceBoost,
    trimSilence,
    setVoiceBoost: (v: boolean) => set('podcasts.voiceBoost', v),
    setTrimSilence: (v: boolean) => set('podcasts.trimSilence', v),
  }
}

/** Cumulative trim-silence "time saved": the server total plus whatever this session has
 *  accumulated but not flushed yet (updates live while silence is being skipped). */
export function useTimeSaved(): number {
  const { data } = useQuery({ queryKey: ['podcast-player-stats'], queryFn: getPlayerStats, staleTime: 60_000 })
  // Floor the snapshot so the store only "changes" once per whole second of savings.
  const session = useSyncExternalStore(subscribeSavedSeconds, () => Math.floor(getSessionSavedSeconds()), () => 0)
  return Math.round((data?.timeSavedSec ?? 0) + session)
}

export function fmtTimeSaved(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
