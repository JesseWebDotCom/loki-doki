import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ColorPicker } from '@/components/shared/ColorPicker'
import { IconPicker } from '@/components/shared/IconPicker'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { toast } from '@/lib/toast'
import { updateCollection, deleteCollection, listCollections, type BookmarkCollection } from '@/lib/bookmarks/api'

// Collection ids that are `id` or a descendant of it: invalid parents (would loop).
function descendantsOf(id: string, all: BookmarkCollection[]): Set<string> {
  const out = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const c of all) if (c.parentId && out.has(c.parentId) && !out.has(c.id)) { out.add(c.id); grew = true }
  }
  return out
}

interface CollectionEditorProps {
  open: boolean
  collection: BookmarkCollection | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function CollectionEditor({ open, collection, onOpenChange, onDeleted }: CollectionEditorProps) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<string | null>(null)
  const [color, setColor] = useState<string | null>(null)
  const [parentId, setParentId] = useState<string>('')
  const [pending, setPending] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const { data: collections = [] } = useQuery({ queryKey: ['bookmark-collections'], queryFn: listCollections, enabled: open })
  // Valid parents: my own collections, excluding this one + its descendants.
  const parentOptions = useMemo(() => {
    if (!collection) return []
    const banned = descendantsOf(collection.id, collections)
    return collections.filter(c => c.role === 'owner' && !banned.has(c.id))
  }, [collection, collections])

  useEffect(() => {
    if (open && collection) {
      setName(collection.name)
      setIcon(collection.icon)
      setColor(collection.color)
      setParentId(collection.parentId ?? '')
    }
  }, [open, collection])

  async function handleSave() {
    if (!collection) return
    const trimmed = name.trim()
    if (!trimmed) { toast.error('Name is required'); return }
    setPending(true)
    try {
      await updateCollection(collection.id, { name: trimmed, icon, color, parentId: parentId || null })
      qc.invalidateQueries({ queryKey: ['bookmark-collections'] })
      toast.success('Collection updated')
      onOpenChange(false)
    } catch {
      toast.error('Failed to update collection')
    } finally {
      setPending(false)
    }
  }

  async function handleDelete() {
    if (!collection) return
    setPending(true)
    try {
      await deleteCollection(collection.id)
      qc.invalidateQueries({ queryKey: ['bookmark-collections'] })
      qc.invalidateQueries({ queryKey: ['bookmarks'] })
      toast.success('Collection deleted')
      setConfirmDelete(false)
      onOpenChange(false)
      onDeleted?.()
    } catch {
      toast.error('Failed to delete collection')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next) onOpenChange(false) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit collection</DialogTitle>
            <DialogDescription>Rename this collection or give it an icon and color.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <label htmlFor="coll-name" className="text-sm font-medium">Name</label>
              <Input
                id="coll-name"
                placeholder="Collection name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Icon</span>
                <IconPicker value={icon} onChange={setIcon} />
              </div>
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">Color</span>
                <ColorPicker value={color} onChange={setColor} />
              </div>
            </div>

            <div className="grid gap-1.5">
              <label htmlFor="coll-parent" className="text-sm font-medium">Parent collection</label>
              <select id="coll-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}
                className="h-9 rounded-control border border-border bg-background px-2.5 text-sm outline-none focus:border-primary">
                <option value="">None (top level)</option>
                {parentOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>

          <DialogFooter className="sm:justify-between">
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)} disabled={pending}>
              Delete
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={pending}>Save</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete collection?"
        description={`"${collection?.name ?? ''}" will be removed. Its items stay in your library.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </>
  )
}
