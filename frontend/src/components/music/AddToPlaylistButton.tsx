import { useQueryClient } from '@tanstack/react-query'
import { AddToPlaylistMenu } from '@/components/shared/AddToPlaylistMenu'
import { listPlaylists, createPlaylist, addPlaylistTrack } from '@/lib/music/catalogApi'

interface Song { videoId: string; title: string; artist?: string; mbid?: string; durationSec?: number }

/** Icon button + dropdown for adding a song to one of the user's playlists (or a fresh one).
 *  Drop into any track row alongside SongDownloadButton/OpenInYoutubeButton. */
export function AddToPlaylistButton({ song, className }: { song: Song; className?: string }) {
  const qc = useQueryClient()
  return (
    <AddToPlaylistMenu
      item={song}
      className={className}
      // Distinct from the ['music-playlists'] key MusicLibraryPage uses for the full
      // { mine, shared } list response — sharing that key served up the wrong shape as soon
      // as both were cached, throwing on `mine.map`. Still swept by
      // invalidateQueries(['music-playlists']) below (prefix match).
      queryKey={['music-playlists', 'mine']}
      listMine={async () => (await listPlaylists()).mine}
      createAndReturn={async (name) => (await createPlaylist({ name })).playlist}
      addToPlaylist={(playlistId, s) => addPlaylistTrack(playlistId, { videoId: s.videoId, title: s.title, artist: s.artist, mbid: s.mbid, durationSec: s.durationSec })}
      onAdded={(playlistId) => {
        qc.invalidateQueries({ queryKey: ['music-playlist', playlistId] })
        qc.invalidateQueries({ queryKey: ['music-playlists'] })
      }}
    />
  )
}
