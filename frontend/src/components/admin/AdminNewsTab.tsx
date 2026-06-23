import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Trash2, Newspaper } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { FaviconImg } from '@/components/shared/FaviconImg'
import { hostFromUrl } from '@/components/shared/NewsCard'
import { toast } from '@/lib/toast'

// Shared News categories: visible to every user as read-only News tabs. Built-in Global/Local
// are managed in code (seeded, locked) and never appear here.

interface SharedFeed { id: string; title: string; url: string | null; lastError: string | null }
interface SharedCategory { id: string; name: string; feeds: SharedFeed[] }

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

async function fetchCategories(): Promise<SharedCategory[]> {
  const r = await fetch('/api/admin/news/categories', opts)
  if (!r.ok) throw new Error('Failed to load categories')
  return ((await r.json()) as { categories: SharedCategory[] }).categories
}

export function AdminNewsTab() {
  const qc = useQueryClient()
  const { data: categories = [], isLoading } = useQuery({ queryKey: ['admin-news'], queryFn: fetchCategories })
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [delCat, setDelCat] = useState<SharedCategory | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-news'] })

  async function createCategory() {
    if (!newName.trim()) return
    setBusy(true)
    try {
      const r = await fetch('/api/admin/news/categories', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ name: newName.trim() }) })
      if (!r.ok) throw new Error('Failed')
      toast.success('Category created'); setNewName(''); invalidate()
    } catch { toast.error('Failed to create category') } finally { setBusy(false) }
  }

  return (
    <div className="space-y-5 p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-muted p-2"><Newspaper className="size-5 text-muted-foreground" /></div>
        <div className="flex-1">
          <h2 className="text-base font-semibold">Shared News categories</h2>
          <p className="text-sm text-muted-foreground">
            Curated categories everyone sees in the News app, alongside the built-in Global and Local tabs.
            Users can hide them but can't edit their feeds.
          </p>
        </div>
      </div>

      <div className="flex max-w-md gap-2">
        <Input placeholder="New category name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void createCategory() }} />
        <Button onClick={createCategory} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}</Button>
      </div>

      {isLoading && <div className="py-10 text-center"><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /></div>}
      {!isLoading && categories.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">No shared categories yet.</p>
      )}

      <div className="space-y-4">
        {categories.map((cat) => (
          <CategoryCard key={cat.id} cat={cat} onChanged={invalidate} onDelete={() => setDelCat(cat)} />
        ))}
      </div>

      <ConfirmDialog
        open={!!delCat}
        onOpenChange={(o) => { if (!o) setDelCat(null) }}
        title="Delete this shared category?"
        description={delCat ? `"${delCat.name}" and its feeds will be removed for everyone.` : undefined}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (delCat) {
            const r = await fetch(`/api/admin/news/categories/${delCat.id}`, { ...opts, method: 'DELETE' })
            if (r.ok) { toast.success('Category deleted'); invalidate() } else toast.error('Failed to delete')
          }
          setDelCat(null)
        }}
      />
    </div>
  )
}

function CategoryCard({ cat, onChanged, onDelete }: { cat: SharedCategory; onChanged: () => void; onDelete: () => void }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  async function addFeed() {
    if (!url.trim()) return
    setBusy(true)
    try {
      const r = await fetch(`/api/admin/news/categories/${cat.id}/feeds`, { ...opts, method: 'POST', headers: J, body: JSON.stringify({ url: url.trim() }) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Failed')
      toast.success('Feed added'); setUrl(''); onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to add feed') } finally { setBusy(false) }
  }
  async function removeFeed(f: SharedFeed) {
    const r = await fetch(`/api/admin/news/feeds/${f.id}`, { ...opts, method: 'DELETE' })
    if (r.ok) { toast.success('Feed removed'); onChanged() } else toast.error('Failed to remove')
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-medium">{cat.name}</h3>
        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={onDelete} aria-label="Delete category">
          <Trash2 className="size-4" />
        </Button>
      </div>

      <div className="mb-2 flex gap-2">
        <Input placeholder="https://example.com or .../feed.xml" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addFeed() }} />
        <Button onClick={addFeed} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}</Button>
      </div>

      <div className="space-y-1">
        {cat.feeds.length === 0 && <p className="py-2 text-center text-xs text-muted-foreground">No feeds yet.</p>}
        {cat.feeds.map((f) => (
          <div key={f.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
            <FaviconImg domain={hostFromUrl(f.url || undefined) ?? ''} className="size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{f.title || f.url}</div>
              {f.lastError && <div className="truncate text-xs text-destructive">{f.lastError}</div>}
            </div>
            <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => removeFeed(f)} aria-label="Remove feed">
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
