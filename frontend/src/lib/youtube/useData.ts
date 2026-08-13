// React-query hooks for the YouTube app's shared data, plus duration backfill.

import { useEffect, useState } from 'react'
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

/** Offline-save state for one video, derived from the shared downloads cache. */
export function useSavedState(videoId: string): 'saved' | 'saving' | null {
  const { data } = useYtDownloads()
  const row = data?.find(r => r.videoId === videoId)
  if (!row) return null
  if (row.status === 'ready') return 'saved'
  if (row.status === 'pending' || row.status === 'downloading') return 'saving'
  return null
}

/** Feed videos with lazily-backfilled durations (RSS omits them) merged in. */
export function useYtFeed(limit = 120): { videos: FeedVideo[]; items: VideoItem[]; loading: boolean } {
  const qc = useQueryClient()
  const { data: rawVideos = [], isLoading } = useQuery({ queryKey: ['yt-feed', limit], queryFn: () => getFeed(limit) })
  const { data: durations = {} } = useQuery<Record<string, number>>({ queryKey: ['yt-durations'], queryFn: () => ({}), staleTime: Infinity, enabled: false })

  // One-frame gate for persisted data. The feed is restored from disk (prefetch/persist.ts)
  // so on a reopen it is already populated during the consumer's MOUNT render - and a
  // 100-item feed rendered whole in the mount pass reliably trips a Suspense fallback that
  // never retries (the route hangs on a spinner; reproduced and bisected 2026-08-13, count-
  // dependent: ~30 cards fine, ~60+ hang). Rendering the same tree one frame later, as an
  // UPDATE, is the path the app has always taken when the feed arrived over the network,
  // and never hangs. So consumers see loading for exactly one extra frame after mount.
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const videos = mounted ? rawVideos : []

  useEffect(() => {
    const missing = videos.filter(v => v.durationSec == null && durations[v.videoId] == null).map(v => v.videoId).slice(0, 40)
    if (!missing.length) return
    // Merge each chunk as it lands so durations fill in progressively rather than all at once.
    backfillDurations(missing, (chunk) => {
      qc.setQueryData<Record<string, number>>(['yt-durations'], prev => ({ ...(prev ?? {}), ...chunk }))
    }).catch(() => {})
  }, [videos, durations, qc])

  const items = videos.map(v => feedToItem(v, durations[v.videoId]))
  return { videos, items, loading: isLoading || !mounted }
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
