// Shared "play a custom playlist through the full watch page" plumbing. The URL carries
// which playlist + position (?plist=&ppos=), so every autoplay/up-next hop navigates through
// the SAME playlist on whichever source's watch page it lands on — same idea as YouTube's own
// /watch?v=X&list=Y, as opposed to the mini-player's queue (still used for Shuffle).

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getYtPlaylist, type YtPlaylistVideo, type PlaylistVideoSource } from '@/lib/youtube/playlists'

const KEY_PLAYLIST = 'plist'
const KEY_POS = 'ppos'

/** Mine (Studio bin) entries have no watch page of their own, so they're never a valid
 *  autoplay/link target here — every other source maps 1:1 to /videos/<source>/watch/<id>. */
export function playlistWatchHref(source: Exclude<PlaylistVideoSource, 'mine'>, videoId: string, playlistId: string, pos: number): string {
  return `/videos/${source}/watch/${encodeURIComponent(videoId)}?${KEY_PLAYLIST}=${encodeURIComponent(playlistId)}&${KEY_POS}=${pos}`
}

/** First index at/after `from` with a real watch page (i.e. not Mine). */
export function firstPlayableIndex(videos: YtPlaylistVideo[], from = 0): number {
  for (let i = from; i < videos.length; i++) if (videos[i]!.videoSource !== 'mine') return i
  return -1
}

export interface PlaylistQueue {
  active: boolean
  playlistId: string | null
  playlistName: string | null
  videos: YtPlaylistVideo[]
  pos: number
  next: YtPlaylistVideo | null
  nextIndex: number
}

/** Reads ?plist=&ppos= off the current URL and, when present, fetches that playlist so the
 *  watch page can render its queue and autoplay through it instead of algorithmic "related".
 *  No "previous" here — PlaylistQueuePanel already lets you jump to any row directly. */
export function usePlaylistQueue(): PlaylistQueue {
  const [params] = useSearchParams()
  const playlistId = params.get(KEY_PLAYLIST)
  const pos = Number(params.get(KEY_POS) ?? 0) || 0

  const { data } = useQuery({
    queryKey: ['yt-playlist', playlistId],
    queryFn: () => getYtPlaylist(playlistId!),
    enabled: !!playlistId,
    staleTime: 30_000,
  })
  const videos = data?.videos ?? []
  const playlistName = data?.playlist.name ?? null

  const nextIndex = useMemo(() => (playlistId ? firstPlayableIndex(videos, pos + 1) : -1), [playlistId, videos, pos])

  return {
    active: !!playlistId,
    playlistId,
    playlistName,
    videos,
    pos,
    next: nextIndex >= 0 ? videos[nextIndex]! : null,
    nextIndex,
  }
}
