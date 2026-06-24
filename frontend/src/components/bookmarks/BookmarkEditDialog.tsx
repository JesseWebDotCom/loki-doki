import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { updateItem, listCollections, createCollection, type BookmarkItem } from '@/lib/bookmarks/api'
import { useAuth } from '@/context/AuthContext'

// Edit an existing bookmark: title, tags, collection, and (for live links) whether it
// opens inside Loki or in a new tab. The URL is identity and can't be changed here — re-save
// to capture a different page.
export function BookmarkEditDialog({ item, open, onClose }: { item: BookmarkItem | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState('')
  const [collectionId, setCollectionId] = useState('')
  const [newCollection, setNewCollection] = useState<string | null>(null) // null = pick existing
  const [useEmbed, setUseEmbed] = useState(false)
  const [captureMedia, setCaptureMedia] = useState(false)
  const [makeGlobal, setMakeGlobal] = useState(false)
  const [saving, setSaving] = useState(false)

  const { data: collections = [] } = useQuery({ queryKey: ['bookmark-collections'], queryFn: listCollections })

  useEffect(() => {
    if (open && item) {
      setTitle(item.title ?? '')
      setTags(item.tags.join(', '))
      setCollectionId(item.collectionId ?? '')
      setNewCollection(null)
      setUseEmbed(item.useEmbed)
      setCaptureMedia(item.captureMedia)
      setMakeGlobal(item.isGlobal)
    }
  }, [open, item])

  async function save() {
    if (!item) return
    setSaving(true)
    try {
      // Resolve a freshly-typed collection name into an id (server creates it if needed).
      let collId: string | null = collectionId || null
      if (newCollection !== null) {
        const name = newCollection.trim()
        collId = name ? await createCollection(name) : null
      }
      await updateItem(item.id, {
        title: title.trim() || item.url,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        collectionId: collId,
        captureMedia,
        ...(isAdmin ? { makeGlobal } : {}),
        ...(item.type === 'live' ? { useEmbed } : {}),
      })
      qc.invalidateQueries({ queryKey: ['bookmarks'] })
      qc.invalidateQueries({ queryKey: ['bookmark-collections'] })
      toast.success('Saved')
      onClose()
    } catch {
      toast.error('Failed to save changes')
    } finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit link</DialogTitle>
          <DialogDescription className="truncate">{item?.url}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
          <Input placeholder="Tags, comma-separated" value={tags} onChange={e => setTags(e.target.value)} />
          {newCollection === null ? (
            <div className="flex gap-2">
              <select value={collectionId} onChange={e => setCollectionId(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm">
                <option value="">No collection</option>
                {collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <Button type="button" variant="outline" onClick={() => { setNewCollection(''); setCollectionId('') }}>
                <Plus className="size-4" /> New
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input placeholder="New collection name" value={newCollection} autoFocus
                onChange={e => setNewCollection(e.target.value)} />
              <Button type="button" variant="ghost" onClick={() => setNewCollection(null)}>Cancel</Button>
            </div>
          )}
          {item?.type === 'live' && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={useEmbed} onChange={e => setUseEmbed(e.target.checked)}
                className="size-4 rounded border-border" />
              Open inside Loki instead of a new tab
            </label>
          )}
          <label className="flex items-start gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={captureMedia} onChange={e => setCaptureMedia(e.target.checked)}
              className="mt-0.5 size-4 rounded border-border" />
            <span>Capture embedded video/audio when archiving <span className="text-muted-foreground/60">(uses yt-dlp; slower)</span></span>
          </label>
          {isAdmin && (
            <label className="flex items-start gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={makeGlobal} onChange={e => setMakeGlobal(e.target.checked)}
                className="mt-0.5 size-4 rounded border-border" />
              <span>Visible to everyone <span className="text-muted-foreground/60">(global bookmark, not just you)</span></span>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
