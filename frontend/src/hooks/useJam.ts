// Family Jam: the household's shared Up Next. One query everything reads (the banner,
// the queue sheet, the host's consume loop), polled so members see each other's adds
// without a refresh.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { getJam, type Jam } from '@/lib/together/api'
import { getDeviceId } from '@/lib/together/deviceIdentity'

export const JAM_KEY = ['together-jam'] as const

const POLL_MS = 6_000

export interface JamView {
  jam: Jam | null
  /** True when this SESSION is the one whose player consumes the shared queue. */
  isHostDevice: boolean
  /** True when this USER started the jam (they can end it from any of their sessions). */
  isHostUser: boolean
  loading: boolean
}

export function useJam(): JamView {
  const { user } = useAuth()
  const { data, isLoading } = useQuery({
    queryKey: JAM_KEY,
    queryFn: getJam,
    enabled: !!user?.id,
    refetchInterval: POLL_MS,
  })
  const jam = data?.jam ?? null
  return {
    jam,
    isHostDevice: !!jam && jam.hostDeviceId === getDeviceId(),
    isHostUser: !!jam && !!user?.id && jam.hostUserId === user.id,
    loading: isLoading,
  }
}

/** Refresh the jam everywhere after a mutation. */
export function useRefreshJam(): () => void {
  const qc = useQueryClient()
  return () => { void qc.invalidateQueries({ queryKey: JAM_KEY }) }
}
