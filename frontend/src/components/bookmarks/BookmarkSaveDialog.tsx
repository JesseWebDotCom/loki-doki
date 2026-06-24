import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, FileText, Loader2, Plus } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { createItem, listCollections, probe, type BookmarkType } from '@/lib/bookmarks/api'

// Shared in-app save flow (the rail "+ Save" button). The bookmarklet/share-target
// capture surface (/save) is a separate workstream that posts to the same endpoint.
export function BookmarkSaveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [type, setType] = useState<BookmarkType>('offline')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState('')
  const [collectionId, setCollectionId] = useState('')
  const [newCollection, setNewCollection] = useState<string | null>(null) // null = pick existing
  const [favicon, setFavicon] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [saving, setSaving] = useState(false)

  const { data: collections = [] } = useQuery({ queryKey: ['bookmark-collections'], queryFn: listCollections })

  useEffect(() => {
    if (!open) { setType('offline'); setUrl(''); setTitle(''); setTags(''); setCollectionId(''); setNewCollection(null); setFavicon(null) }
  }, [open])

  // Probe the URL (favicon + page title) once it looks complete.
  useEffect(() => {
    if (!open || !/^https?:\/\/.+\..+/.test(url)) return
    const t = setTimeout(async () => {
      setProbing(true)
      try {
        const r = await probe(url)
        setFavicon(r.faviconUrl)
        if (!title && r.title) setTitle(r.title)
      } finally { setProbing(false) }
    }, 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, open])

  async function save() {
    if (!url.trim()) { toast.error('Enter a URL'); return }
    setSaving(true)
    try {
      await createItem({
        type, url: url.trim(), title: title.trim() || undefined,
        faviconUrl: favicon ?? undefined,
        // Either an existing collection (collectionId) or a new one by name (server creates it).
        collectionId: newCollection === null ? (collectionId || undefined) : undefined,
        collectionName: newCollection?.trim() || undefined,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      })
      // The server renders + screenshots (offline: full archive; live: thumbnail) via the job
      // queue, so the card's screenshot fills in shortly. No client-side capture needed.
      toast.success(type === 'offline' ? 'Saving article for offline reading…' : 'Bookmark saved')
      qc.invalidateQueries({ queryKey: ['bookmarks'] })
      onClose()
    } catch {
      toast.error('Failed to save')
    } finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Save to Bookmarks</DialogTitle></DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          {([
            { v: 'live', icon: Bookmark, label: 'Live link', hint: 'Bookmark a site / dashboard' },
            { v: 'offline', icon: FileText, label: 'Offline', hint: 'Save the full article' },
          ] as const).map(o => (
            <button key={o.v} type="button" onClick={() => setType(o.v)}
              className={cn('flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors',
                type === o.v ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/40')}>
              <o.icon className="size-4" />
              <span className="text-sm font-medium">{o.label}</span>
              <span className="text-[11px] text-muted-foreground">{o.hint}</span>
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <div className="relative">
            <Input placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} autoFocus />
            {probing && <Loader2 className="absolute right-2 top-2.5 size-4 animate-spin text-muted-foreground" />}
          </div>
          <Input placeholder="Title (optional)" value={title} onChange={e => setTitle(e.target.value)} />
          <Input placeholder="Tags, comma-separated (optional)" value={tags} onChange={e => setTags(e.target.value)} />
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
