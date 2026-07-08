import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getHubHistory, type HubVideoItem, type VideoSource } from '@/lib/videos/api'
import { hubHistoryToItem } from '@/components/videos/HubCard'

/** Continue-watching items for one non-YouTube source: watch-state rows that aren't
 *  finished, mapped into hub cards. Shared by every source's own page's "Continue
 *  watching" shelf — was copy-pasted identically across TikTok/Vimeo/Reddit before. */
export function useSourceContinueWatching(source: VideoSource, enabled = true): HubVideoItem[] {
  const { data: hubHist } = useQuery({ queryKey: ['videos-history'], queryFn: getHubHistory, enabled })
  return useMemo<HubVideoItem[]>(() => (hubHist?.history ?? [])
    .filter((r) => r.source === source && !r.completed && r.positionSec > 5)
    .map((r) => ({ ...hubHistoryToItem(r), vertical: source === 'tiktok' })), [hubHist, source])
}
