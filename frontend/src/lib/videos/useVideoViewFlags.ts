import { useQuery } from '@tanstack/react-query'
import { getVideoSources, type VideoViewFlags } from '@/lib/videos/api'

// Per-user video view limits + approved-only mode, read from the same cached
// /api/videos/sources payload every Videos surface already fetches. Defaults are all-off
// while loading, so nothing flashes hidden for unrestricted users.
export function useVideoViewFlags(): VideoViewFlags & { allowlistOnly: boolean } {
  const { data } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources, staleTime: 5 * 60_000 })
  return {
    noAutoplay: data?.viewFlags?.noAutoplay === true,
    noShorts: data?.viewFlags?.noShorts === true,
    noSuggestions: data?.viewFlags?.noSuggestions === true,
    allowlistOnly: data?.allowlistOnly === true,
  }
}
