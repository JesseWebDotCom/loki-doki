// Open the in-app MusicBrainz detail pages (artist / album) from a currently-playing track.
//
// A playing radio track (QueuedTrack) only carries a free-text `author` string and `title` — it has
// no MusicBrainz id — so a click can't link straight to /music/artist/:mbid or /music/album/:mbid.
// This hook resolves the name to an mbid through the existing catalog search first, then navigates
// to our own detail page (never out to musicbrainz.org). Shared by the now-playing surfaces so the
// "click the artist / song" behavior is identical everywhere.

import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { catalogSearch } from '@/lib/music/catalogApi'

export function useCatalogNav() {
  const navigate = useNavigate()
  // Which lookup is in flight ('artist' | 'song' | null) — drives a subtle pending affordance and
  // guards against a second click while the search round-trip is still resolving.
  const [pending, setPending] = useState<'artist' | 'song' | null>(null)

  const openArtist = useCallback(async (name: string) => {
    const q = (name || '').trim()
    if (!q || pending) return
    setPending('artist')
    try {
      const { artists } = await catalogSearch(q, 'artists')
      const mbid = artists?.[0]?.mbid
      if (mbid) navigate(`/music/artist/${mbid}`)
      else toast.error(`No catalog match for "${q}"`)
    } catch { toast.error(`Couldn't open "${q}"`) } finally { setPending(null) }
  }, [navigate, pending])

  // Songs have no detail route of their own — the closest in-app MusicBrainz view is the album
  // (release group) that contains them, so we open that; fall back to the artist page.
  const openSong = useCallback(async (title: string, artist: string) => {
    const t = (title || '').trim()
    if (!t || pending) return
    setPending('song')
    try {
      const { songs } = await catalogSearch(`${(artist || '').trim()} ${t}`.trim(), 'songs')
      const s = songs?.[0]
      if (s?.albumMbid) { navigate(`/music/album/${s.albumMbid}`); return }
      if (s?.artistMbid) { navigate(`/music/artist/${s.artistMbid}`); return }
      const a = (artist || '').trim()
      if (a) {
        const { artists } = await catalogSearch(a, 'artists')
        if (artists?.[0]?.mbid) { navigate(`/music/artist/${artists[0].mbid}`); return }
      }
      toast.error(`No catalog match for "${t}"`)
    } catch { toast.error(`Couldn't open "${t}"`) } finally { setPending(null) }
  }, [navigate, pending])

  return { openArtist, openSong, pending }
}
