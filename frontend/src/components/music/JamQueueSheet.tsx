import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, ListMusic, Plus, Search, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { SongArt } from '@/components/music/SongArt'
import { useJam, useRefreshJam } from '@/hooks/useJam'
import { addJamItem, removeJamItem, reorderJam, type JamItem } from '@/lib/together/api'
import { catalogSearchSongs, resolveSong, type CatalogSong } from '@/lib/music/catalogApi'

// Family Jam: the shared queue itself. Everyone in the house sees the same list, with
// who added what, and can reorder it or add to it. Adding goes through the existing
// music catalog search + resolve (the same path the rest of the app uses to turn a
// song into a playable ref), so nothing about track resolution is special-cased here.

function JamRow({ item, onRemove }: { item: JamItem; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('group flex items-center gap-3 rounded-control px-2 py-1.5 transition-colors hover:bg-foreground/[0.06]',
        isDragging && 'relative z-10 bg-foreground/[0.08] shadow-lg')}
    >
      <SongArt trackRef={item.videoId} title={item.title} artist={item.author} className="size-10" rounded="rounded-control" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.title}</p>
        <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          {item.author && <span className="truncate">{item.author}</span>}
          {item.addedByName && (
            <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px] font-normal">
              added by {item.addedByName}
            </Badge>
          )}
        </p>
      </div>
      <Button variant="ghost" size="icon-sm" onClick={onRemove}
        className="size-8 shrink-0 text-muted-foreground/50 opacity-0 transition hover:text-foreground group-hover:opacity-100"
        aria-label={`Remove ${item.title}`}>
        <Trash2 className="size-3.5" />
      </Button>
      {/* design-ok(hand-styled-button): drag grip, mirrors the Up Next row in nowPlayingParts */}
      <button type="button" {...attributes} {...listeners}
        className="grid size-8 shrink-0 cursor-grab touch-none place-items-center rounded-control text-muted-foreground/50 opacity-0 transition hover:text-foreground group-hover:opacity-100 active:cursor-grabbing"
        aria-label={`Reorder ${item.title}`} title="Drag to reorder">
        <GripVertical className="size-4" />
      </button>
    </div>
  )
}

function AddToJam() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<CatalogSong[]>([])
  const refresh = useRefreshJam()

  const search = useMutation({
    mutationFn: (query: string) => catalogSearchSongs(query),
    onSuccess: (songs) => {
      setResults(songs.slice(0, 6))
      if (!songs.length) toast.info('Nothing found for that.')
    },
    onError: () => toast.error('Could not search right now.'),
  })

  const add = useMutation({
    mutationFn: async (s: CatalogSong) => {
      // Same resolve path the station engine uses: catalog song -> playable ref.
      const resolved = await resolveSong({ mbid: s.mbid, title: s.title, artist: s.artistName, durationSec: s.durationSec })
      if (!resolved) throw new Error(`Could not find a playable version of "${s.title}".`)
      return addJamItem({ videoId: resolved.videoId, title: resolved.title, author: resolved.artist || s.artistName, thumbnail: '' })
    },
    onSuccess: (_r, s) => { toast.success(`Added "${s.title}" to the jam`); setResults([]); setQ(''); refresh() },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="space-y-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); if (q.trim()) search.mutate(q.trim()) }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a song to the jam…" className="h-9" />
        <Button type="submit" size="icon" className="size-9 shrink-0" disabled={search.isPending || !q.trim()} aria-label="Search">
          {search.isPending ? <Spinner size="sm" /> : <Search className="size-4" />}
        </Button>
      </form>
      {results.length > 0 && (
        <div className="space-y-1 rounded-control border border-border/60 p-1">
          {results.map((s) => (
            // design-ok(hand-styled-button): search result list row, not a button-styled control
            <button
              key={s.mbid}
              onClick={() => add.mutate(s)}
              disabled={add.isPending}
              className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.06] disabled:opacity-60"
            >
              <Plus className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{s.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{s.artistName}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function JamQueueSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { jam } = useJam()
  const refresh = useRefreshJam()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderJam(ids),
    onSuccess: refresh,
    onError: () => { toast.error('Could not reorder the jam.'); refresh() },
  })
  const remove = useMutation({
    mutationFn: (id: string) => removeJamItem(id),
    onSuccess: refresh,
    onError: () => toast.error('Could not remove that track.'),
  })

  const items = jam?.items ?? []
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const ids = items.map((i) => i.id)
    const from = ids.indexOf(String(e.active.id))
    const to = ids.indexOf(String(e.over.id))
    if (from < 0 || to < 0) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(to, 0, moved)
    reorder.mutate(next)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[70vh] rounded-t-2xl">
        <SheetTitle>{jam ? jam.name : 'Family Jam'}</SheetTitle>
        {jam && (
          <p className="mt-1 text-xs text-muted-foreground">
            Everyone adds to the same queue. {jam.hostName} is playing it.
          </p>
        )}
        <div className="mt-4">
          <AddToJam />
        </div>
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground">
              <ListMusic className="size-7 opacity-30" />
              <p className="text-sm">The jam queue is empty. Add the first song.</p>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
                {items.map((i) => (
                  <JamRow key={i.id} item={i} onRemove={() => remove.mutate(i.id)} />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
