import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Tag, Pencil, Trash2, Check, X, Merge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Card } from '@/components/ui/card'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { toast } from '@/lib/toast'
import { listTags, renameTag, deleteTag, mergeTags, type BookmarkTag } from '@/lib/bookmarks/api'

export function BookmarksTagsPage() {
  const qc = useQueryClient()
  useAppHeader({ query: '', setQuery: () => {}, searchable: false })
  const { data: tags = [], isLoading } = useQuery({ queryKey: ['bookmark-tags'], queryFn: listTags })
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmDel, setConfirmDel] = useState<BookmarkTag | null>(null)

  function invalidate() { qc.invalidateQueries({ queryKey: ['bookmark-tags'] }); qc.invalidateQueries({ queryKey: ['bookmarks'] }) }

  async function saveRename(tag: BookmarkTag) {
    const name = draft.trim()
    if (!name || name === tag.name) { setEditing(null); return }
    try { await renameTag(tag.id, name); invalidate(); toast.success('Tag renamed') }
    catch { toast.error('Failed to rename') }
    finally { setEditing(null) }
  }
  async function doDelete(tag: BookmarkTag) {
    try { await deleteTag(tag.id); invalidate(); toast.success('Tag deleted') }
    catch { toast.error('Failed to delete') }
  }
  async function doMerge(source: BookmarkTag, targetId: string) {
    try { await mergeTags([source.id], targetId); invalidate(); toast.success('Tags merged') }
    catch { toast.error('Failed to merge') }
  }

  return (
    <PageContainer className="py-6">
      <PageHeader title="Tags" subtitle="Rename, merge, or remove the tags across your library." className="pt-0 pb-5" />

      {isLoading ? (
        <div className="flex justify-center py-20"><Spinner size="lg" /></div>
      ) : tags.length === 0 ? (
        <EmptyAppState icon={Tag} title="No tags yet" tagline="Tag a bookmark from its card or the reader, or let AI auto-tag your saved articles." />
      ) : (
        <div className="grid gap-2">
          {tags.map(tag => (
            <Card key={tag.id} className="flex items-center gap-3 border-border/60 p-3">
              <Tag className="size-4 shrink-0 text-muted-foreground" />
              {editing === tag.id ? (
                <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveRename(tag); if (e.key === 'Escape') setEditing(null) }}
                  className="h-8 flex-1" />
              ) : (
                <Link to={`/bookmarks/all?tag=${encodeURIComponent(tag.name)}`} className="flex-1 truncate font-medium hover:underline">{tag.name}</Link>
              )}
              <span className="shrink-0 rounded-full bg-accent/60 px-2 py-0.5 text-xs text-muted-foreground">{tag.count} item{tag.count === 1 ? '' : 's'}</span>
              {editing === tag.id ? (
                <>
                  <Button variant="ghost" size="icon-sm" onClick={() => saveRename(tag)} aria-label="Save"><Check className="size-4" /></Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing(null)} aria-label="Cancel"><X className="size-4" /></Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="icon-sm" onClick={() => { setEditing(tag.id); setDraft(tag.name) }} aria-label="Rename"><Pencil className="size-4" /></Button>
                  {tags.length > 1 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Merge into"><Merge className="size-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="max-h-72 w-48 overflow-y-auto">
                        <DropdownMenuLabel>Merge into…</DropdownMenuLabel><DropdownMenuSeparator />
                        {tags.filter(t => t.id !== tag.id).map(t => (
                          <DropdownMenuItem key={t.id} onClick={() => doMerge(tag, t.id)}><Tag className="size-4" /><span className="truncate">{t.name}</span></DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <Button variant="ghost" size="icon-sm" onClick={() => setConfirmDel(tag)} aria-label="Delete" className="text-muted-foreground hover:text-destructive"><Trash2 className="size-4" /></Button>
                </>
              )}
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDel}
        onOpenChange={(o) => { if (!o) setConfirmDel(null) }}
        title="Delete this tag?"
        description={confirmDel ? `"${confirmDel.name}" will be removed from ${confirmDel.count} item${confirmDel.count === 1 ? '' : 's'}. The bookmarks stay.` : ''}
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (confirmDel) void doDelete(confirmDel); setConfirmDel(null) }}
      />
    </PageContainer>
  )
}
