// React-query hooks for the YouTube app's shared data, plus duration backfill.

import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getFeed, getSubscriptions, getDownloads, backfillDurations, type FeedVideo, type SavedRow } from './api'
import { channelKey, feedToItem, type VideoItem } from './types'
import type { ChannelEntry } from '@/components/youtube/shelves'

export function useYtSubs() {
  return useQuery({ queryKey: ['yt-subs'], queryFn: getSubscriptions })
}

export function useYtDownloads() {
  return useQuery({
    queryKey: ['yt-downloads'],
    queryFn: getDownloads,
    refetchInterval: (q) => (q.state.data?.some(r => r.status === 'pending' || r.status === 'downloading') ? 5000 : false),
  })
}

/** Feed videos with lazily-backfilled durations (RSS omits them) merged in. */
export function useYtFeed(limit = 120): { videos: FeedVideo[]; items: VideoItem[]; loading: boolean } {
  const qc = useQueryClient()
  const { data: videos = [], isLoading } = useQuery({ queryKey: ['yt-feed', limit], queryFn: () => getFeed(limit) })
  const { data: durations = {} } = useQuery<Record<string, number>>({ queryKey: ['yt-durations'], queryFn: () => ({}), staleTime: Infinity, enabled: false })

  useEffect(() => {
    const missing = videos.filter(v => v.durationSec == null && durations[v.videoId] == null).map(v => v.videoId).slice(0, 40)
    if (!missing.length) return
    backfillDurations(missing).then(d => {
      if (Object.keys(d).length) qc.setQueryData<Record<string, number>>(['yt-durations'], prev => ({ ...(prev ?? {}), ...d }))
    }).catch(() => {})
  }, [videos, durations, qc])

  const items = videos.map(v => feedToItem(v, durations[v.videoId]))
  return { videos, items, loading: isLoading }
}

/** Channel entries derived from subscriptions + feed authors. */
export function buildChannels(subs: { id: string; externalId: string; title: string; thumbnailUrl: string | null }[], videos: FeedVideo[]): ChannelEntry[] {
  const byKey = new Map<string, ChannelEntry>()
  for (const s of subs) byKey.set(channelKey(s.title), { id: s.externalId, title: s.title, thumbnailUrl: s.thumbnailUrl })
  for (const v of videos) {
    const k = channelKey(v.author)
    if (!byKey.has(k)) byKey.set(k, { id: v.channelId ?? k, title: v.author || k, thumbnailUrl: v.channelThumb })
  }
  return [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title))
}

export type { SavedRow }
