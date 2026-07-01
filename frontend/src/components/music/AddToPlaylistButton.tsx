import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ListPlus, Plus, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { listPlaylists, createPlaylist, addPlaylistTrack } from '@/lib/music/catalogApi'

interface Song { videoId: string; title: string; artist?: string; mbid?: string; durationSec?: number }

/** Icon button + dropdown for adding a song to one of the user's playlists (or a fresh one).
 *  Drop into any track row alongside SongDownloadButton/OpenInYoutubeButton. */
export function AddToPlaylistButton({ song, className }: { song: Song; className?: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const { data } = useQuery({ queryKey: ['music-playlists'], queryFn: listPlaylists, enabled: open })
  const mine = data?.mine ?? []

  const addTo = async (playlistId: string) => {
    setBusyId(playlistId)
    try {
      await addPlaylistTrack(playlistId, { videoId: song.videoId, title: song.title, artist: song.artist, mbid: song.mbid, durationSec: song.durationSec })
      qc.invalidateQueries({ queryKey: ['music-playlist', playlistId] })
      qc.invalidateQueries({ queryKey: ['music-playlists'] })
      toast.success('Added to playlist')
      setOpen(false)
    } catch { toast.error('Could not add to playlist') }
    finally { setBusyId(null) }
  }

  const createAndAdd = async () => {
    const n = name.trim()
    if (!n) return
    try {
      const { playlist } = await createPlaylist({ name: n })
      await addTo(playlist.id)
      setCreating(false); setName('')
    } catch { toast.error('Could not create playlist') }
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button type="button" onClick={e => e.stopPropagation()} aria-label="Add to playlist" title="Add to playlist"
            className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent/60 hover:text-foreground', className)}>
            <ListPlus className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
          <DropdownMenuItem onClick={() => { setOpen(false); setName(''); setCreating(true) }}>
            <Plus className="size-4" /> New playlist
          </DropdownMenuItem>
          {mine.length > 0 && <DropdownMenuSeparator />}
          {mine.map(p => (
            <DropdownMenuItem key={p.id} disabled={busyId === p.id} onClick={() => void addTo(p.id)}>
              {busyId === p.id ? <Loader2 className="size-4 animate-spin" /> : <ListPlus className="size-4" />} {p.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>New playlist</DialogTitle></DialogHeader>
          <Input value={name} autoFocus placeholder="Playlist name" onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void createAndAdd() }} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={() => void createAndAdd()} disabled={!name.trim()}>Create &amp; add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
