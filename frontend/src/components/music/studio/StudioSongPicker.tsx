// "Find a song" picker for the Studio: search the Music app catalog and send a pick into
// the Studio (which resolves + fetches its audio server-side). Modeled on MusicBrowsePage's
// search rows.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Play } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useRadio } from '@/context/RadioContext'
import { toast } from '@/lib/toast'
import { StudioCover } from './StudioCover'
import { catalogSearchSongs, resolveSong, type CatalogSong } from '@/lib/music/catalogApi'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (song: CatalogSong) => void
}

function fmtDur(sec: number | null): string {
  if (!sec) return ''
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function StudioSongPicker({ open, onOpenChange, onPick }: Props) {
  const radio = useRadio()
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const dTitle = useDebouncedValue(title.trim(), 350)
  const dArtist = useDebouncedValue(artist.trim(), 350)

  const { data: songs = [], isFetching } = useQuery({
    queryKey: ['studio-song-search', dTitle, dArtist],
    queryFn: () => catalogSearchSongs(dTitle, dArtist),
    enabled: dTitle.length > 1,
  })

  // Preview a match in the app's player: resolve the catalog song to a playable id, then play.
  async function preview(s: CatalogSong) {
    setPreviewId(s.mbid)
    try {
      const r = await resolveSong({ mbid: s.mbid, title: s.title, artist: s.artistName, durationSec: s.durationSec })
      if (r) radio.playTrack({ videoId: r.videoId, title: r.title, author: r.artist })
      else toast.error('No preview found for that song')
    } catch { toast.error('Could not load preview') }
    finally { setPreviewId(null) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>Find a song</DialogTitle>
          <DialogDescription>Search your Music catalog by song title and optional band.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Song title" className="pl-9" />
          </div>
          <Input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Band / artist (optional)" />
        </div>
        <div className="-mr-2 h-80 overflow-y-auto pr-2">
          {isFetching && songs.length === 0 ? (
            <div className="flex h-full items-center justify-center"><Spinner /></div>
          ) : dTitle.length <= 1 ? (
            <p className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">Enter a song title (and optionally a band) to search your Music catalog.</p>
          ) : songs.length === 0 ? (
            <p className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">No matches. Try a different search.</p>
          ) : (
            <div className="space-y-1">
              {songs.map((s: CatalogSong) => (
                <div key={s.mbid} className="flex items-center gap-1 rounded-control hover:bg-accent/50">
                  <Button
                    variant="ghost"
                    onClick={() => onPick(s)}
                    className="h-auto min-w-0 flex-1 justify-start gap-3 px-2 py-2 text-left hover:bg-transparent"
                  >
                    <StudioCover artist={s.artistName} album={s.albumTitle ?? s.title} className="size-9" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{s.title}</p>
                      <p className="truncate text-xs font-normal text-muted-foreground">{s.artistName}{s.albumTitle ? ` · ${s.albumTitle}` : ''}</p>
                    </div>
                    <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{fmtDur(s.durationSec)}</span>
                  </Button>
                  <Button
                    variant="ghost" size="icon-sm" className="mr-1 shrink-0"
                    aria-label={`Preview ${s.title}`}
                    onClick={() => preview(s)} disabled={previewId === s.mbid}
                  >
                    {previewId === s.mbid ? <Spinner className="size-4" /> : <Play className="size-4" />}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
