import { ListPlus } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { AddToPlaylistMenu } from '@/components/shared/AddToPlaylistMenu'
import { listYtPlaylists, createYtPlaylist, addYtPlaylistVideo, type PlaylistVideoSource } from '@/lib/youtube/playlists'

/** `videoSource` absent means YouTube — every existing call site predates cross-source
 *  playlists. `thumbnailUrl` only matters for non-YouTube sources (YouTube thumbnails are
 *  derived from videoId), so it's fine to leave unset there. */
interface Vid {
  videoId: string; title: string; author?: string; channelId?: string; durationSec?: number | null
  videoSource?: PlaylistVideoSource; thumbnailUrl?: string | null
}

function useAddVideoProps(video: Vid) {
  const qc = useQueryClient()
  return {
    item: video,
    // Distinct from the ['yt-playlists'] key YoutubeLibraryPage uses for the full
    // { mine, shared } list response — sharing that key here served up the wrong shape (the
    // whole object where an array was expected) as soon as both were cached, throwing on
    // `mine.map`. Still gets swept by invalidateQueries(['yt-playlists']) below (prefix match).
    queryKey: ['yt-playlists', 'mine'] as unknown[],
    listMine: async () => (await listYtPlaylists()).mine,
    createAndReturn: async (name: string) => (await createYtPlaylist({ name })).playlist,
    addToPlaylist: (playlistId: string, v: Vid) => addYtPlaylistVideo(playlistId, {
      videoId: v.videoId, title: v.title, author: v.author, channelId: v.channelId, durationSec: v.durationSec,
      videoSource: v.videoSource, thumbnailUrl: v.thumbnailUrl,
    }),
    onAdded: (playlistId: string) => {
      qc.invalidateQueries({ queryKey: ['yt-playlist', playlistId] })
      qc.invalidateQueries({ queryKey: ['yt-playlists'] })
    },
  }
}

/** Icon button + dropdown for adding a video to one of the user's YouTube playlists (or a fresh
 *  one). Drop into any video row/card alongside other row-action buttons. */
export function AddToPlaylistButton({ video, className }: { video: Vid; className?: string }) {
  return <AddToPlaylistMenu className={className} {...useAddVideoProps(video)} />
}

/** Same menu, styled to sit inside the WatchPage action row. `compact` matches the grouped
 *  SegBtn segment (size-8, transparent); otherwise renders a standalone muted pill. */
export function AddToPlaylistPill({ video, compact }: { video: Vid; compact?: boolean }) {
  const trigger = compact ? (
    <button title="Add to playlist" aria-label="Add to playlist"
      className="grid size-8 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-background/60 data-[state=open]:bg-background/70 data-[state=open]:text-foreground">
      <ListPlus className="size-4" />
    </button>
  ) : (
    <Button variant="secondary" size="icon" title="Add to playlist" aria-label="Add to playlist"
      className="bg-muted text-foreground/80 hover:bg-muted/70">
      <ListPlus className="size-4" />
    </Button>
  )
  return <AddToPlaylistMenu {...useAddVideoProps(video)} trigger={trigger} />
}
