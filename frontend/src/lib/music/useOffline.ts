// Shared offline-state hooks for the Music app. Each wraps a single react-query key, so every
// consumer (station cards, download buttons, offline pages) dedupes onto one cached request and
// one poll — no matter how many render at once.
import { useQuery } from '@tanstack/react-query'
import { listOffline, listOfflineStations, type OfflineStatus } from '@/lib/music/catalogApi'

/** All saved-offline stations + live readiness. Polls only while something is still downloading. */
export function useOfflineStations() {
  return useQuery({
    queryKey: ['music-offline-stations'],
    queryFn: listOfflineStations,
    refetchInterval: q => (q.state.data?.stations.some(s => s.offline.status === 'pending' || s.offline.status === 'partial') ? 4000 : false),
  })
}

/** Map of stationId → offline status, for badges/filters. */
export function useOfflineStationMap(): Map<string, OfflineStatus['status']> {
  const { data } = useOfflineStations()
  const m = new Map<string, OfflineStatus['status']>()
  for (const s of data?.stations ?? []) m.set(s.id, s.offline.status)
  return m
}

/** All offline songs (the ytDownloads audio list) + which videoIds belong to a saved station. */
export function useOfflineSongs() {
  return useQuery({
    queryKey: ['music-offline'],
    queryFn: listOffline,
    refetchInterval: q => (q.state.data?.offline.some(t => t.status === 'pending' || t.status === 'downloading') ? 4000 : false),
  })
}
