import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { getPlexStatus, getPlexRail, type PlexPoster } from './api'

// Shared Plex status. Reuses the same query key as PlexBadge so the configured-check is
// fetched once and shared across every Plex affordance (rails, badges, now-playing).
export function usePlexStatus() {
  return useQuery({ queryKey: ['plex-status'], queryFn: getPlexStatus, staleTime: 5 * 60 * 1000 })
}

export function usePlexConfigured(): boolean {
  return !!usePlexStatus().data?.configured
}

/** Whether the current user has linked their OWN Plex account (not just the shared fallback). */
export function usePlexLinked(): boolean {
  return !!usePlexStatus().data?.linked
}

/** Whether an admin configured the shared server (so a connect prompt is worth showing). */
export function usePlexServerConfigured(): boolean {
  return !!usePlexStatus().data?.serverConfigured
}

// Query options for a Plex library rail — shared so home pages and prefetch use one contract.
export function plexRailQueryOptions(
  kind: 'recent' | 'ondeck' | 'hubs',
  type: 'movie' | 'show',
  enabled: boolean,
): UseQueryOptions<PlexPoster[]> {
  return {
    queryKey: ['plex-rail', kind, type],
    queryFn: () => getPlexRail(kind, type),
    enabled,
    staleTime: 5 * 60 * 1000,
  }
}
