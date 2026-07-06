import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ListPlus, Plus } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface MinePlaylist { id: string; name: string }

export interface AddToPlaylistMenuProps<TItem> {
  item: TItem
  queryKey: unknown[]
  listMine: () => Promise<MinePlaylist[]>
  createAndReturn: (name: string) => Promise<{ id: string }>
  addToPlaylist: (playlistId: string, item: TItem) => Promise<unknown>
  /** Called after a successful add, with the target playlist id — use for query invalidation. */
  onAdded?: (playlistId: string) => void
  className?: string
  /** Custom trigger content (e.g. a labeled pill) instead of the default icon button. */
  trigger?: ReactNode
}

/** Icon button + dropdown for adding an item (song, video, ...) to one of the user's playlists
 *  (or a fresh one). Media-agnostic — pass in the fetch/create/add functions for your domain.
 *  Drop into any row alongside other row-action buttons. */
export function AddToPlaylistMenu<TItem>({ item, queryKey, listMine, createAndReturn, addToPlaylist, onAdded, className, trigger }: AddToPlaylistMenuProps<TItem>) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const { data: mine = [] } = useQuery({ queryKey, queryFn: listMine, enabled: open })

  const addTo = async (playlistId: string) => {
    setBusyId(playlistId)
    try {
      await addToPlaylist(playlistId, item)
      onAdded?.(playlistId)
      toast.success('Added to playlist')
      setOpen(false)
    } catch { toast.error('Could not add to playlist') }
    finally { setBusyId(null) }
  }

  const createAndAdd = async () => {
    const n = name.trim()
    if (!n) return
    try {
      const playlist = await createAndReturn(n)
      await addTo(playlist.id)
      setCreating(false); setName('')
    } catch { toast.error('Could not create playlist') }
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <button type="button" onClick={e => e.stopPropagation()} aria-label="Add to playlist" title="Add to playlist"
              className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent/60 hover:text-foreground', className)}>
              <ListPlus className="size-4" />
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
          <DropdownMenuItem onClick={() => { setOpen(false); setName(''); setCreating(true) }}>
            <Plus className="size-4" /> New playlist
          </DropdownMenuItem>
          {mine.length > 0 && <DropdownMenuSeparator />}
          {mine.map(p => (
            <DropdownMenuItem key={p.id} disabled={busyId === p.id} onClick={() => void addTo(p.id)}>
              {busyId === p.id ? <Spinner className="text-current" /> : <ListPlus className="size-4" />} {p.name}
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
