import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, Copy, Rss, UserPlus, Trash2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import { useAuth } from '@/context/AuthContext'
import {
  updateCollection, listMembers, addMember, removeMember, listHouseholdProfiles,
  type BookmarkCollection,
} from '@/lib/bookmarks/api'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 border-t border-border/60 pt-4 first:border-t-0 first:pt-0">
      <p className="text-sm font-semibold">{title}</p>
      {children}
    </div>
  )
}

export function CollectionShareDialog({ collection, open, onOpenChange }: {
  collection: BookmarkCollection
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [isPublic, setIsPublic] = useState(collection.isPublic)
  const [slug, setSlug] = useState<string | null>(collection.publicSlug)
  const [rssUrl, setRssUrl] = useState(collection.rssUrl ?? '')
  const [rssAutoTag, setRssAutoTag] = useState(collection.rssAutoTag)
  const [addRole, setAddRole] = useState<'viewer' | 'editor'>('viewer')
  const [addUser, setAddUser] = useState('')

  useEffect(() => {
    if (open) { setIsPublic(collection.isPublic); setSlug(collection.publicSlug); setRssUrl(collection.rssUrl ?? ''); setRssAutoTag(collection.rssAutoTag) }
  }, [open, collection])

  const { data: members = [] } = useQuery({ queryKey: ['bookmark-members', collection.id], queryFn: () => listMembers(collection.id), enabled: open })
  const { data: profiles = [] } = useQuery({ queryKey: ['household-profiles'], queryFn: listHouseholdProfiles, enabled: open })
  const memberIds = useMemo(() => new Set(members.map(m => m.userId)), [members])
  const candidates = profiles.filter(p => p.id !== user?.id && !memberIds.has(p.id))
  const shareUrl = slug ? `${location.origin}/b/${slug}` : ''
  const rssOutUrl = slug ? `${location.origin}/api/bookmarks/public/${slug}/rss` : ''

  function invalidate() { qc.invalidateQueries({ queryKey: ['bookmark-collections'] }) }

  async function togglePublic(next: boolean) {
    setIsPublic(next)
    try {
      const { publicSlug } = await updateCollection(collection.id, { isPublic: next })
      setSlug(publicSlug)
      invalidate()
    } catch { toast.error('Failed to update sharing'); setIsPublic(!next) }
  }

  async function saveRss() {
    try {
      await updateCollection(collection.id, { rssUrl: rssUrl.trim() || null, rssAutoTag })
      invalidate()
      toast.success(rssUrl.trim() ? 'Feed subscribed. Fetching new items…' : 'Feed removed')
    } catch { toast.error('Failed to save feed') }
  }

  async function invite() {
    if (!addUser) return
    try { await addMember(collection.id, addUser, addRole); setAddUser(''); qc.invalidateQueries({ queryKey: ['bookmark-members', collection.id] }) }
    catch { toast.error('Failed to add member') }
  }
  async function kick(userId: string) {
    try { await removeMember(collection.id, userId); qc.invalidateQueries({ queryKey: ['bookmark-members', collection.id] }) }
    catch { toast.error('Failed to remove member') }
  }
  function copy(text: string) { navigator.clipboard.writeText(text).then(() => toast.success('Copied')) }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share "{collection.name}"</DialogTitle>
          <DialogDescription>Publish it publicly, invite household members, or subscribe it to an RSS feed.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Section title="Public link">
            <label className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm text-muted-foreground"><Globe className="size-4" />Anyone with the link can view</span>
              <Switch checked={isPublic} onCheckedChange={togglePublic} />
            </label>
            {isPublic && slug && (
              // design-ok(mobile-input-zoom): read-only share-URL fields, tap-to-copy not tap-to-type
              <div className="grid gap-2">
                <div className="flex items-center gap-1.5">
                  <Input readOnly value={shareUrl} className="text-xs" onFocus={(e) => e.currentTarget.select()} />
                  <Button variant="outline" size="icon-sm" onClick={() => copy(shareUrl)} aria-label="Copy link"><Copy className="size-4" /></Button>
                </div>
                {/* design-ok(mobile-input-zoom): read-only RSS-URL field, tap-to-copy not tap-to-type */}
                <div className="flex items-center gap-1.5">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground"><Rss className="size-3.5" />RSS</span>
                  <Input readOnly value={rssOutUrl} className="text-xs" onFocus={(e) => e.currentTarget.select()} />
                  <Button variant="outline" size="icon-sm" onClick={() => copy(rssOutUrl)} aria-label="Copy RSS"><Copy className="size-4" /></Button>
                </div>
              </div>
            )}
          </Section>

          <Section title="Collaborators">
            {members.length === 0 && <p className="text-xs text-muted-foreground">No collaborators yet.</p>}
            {members.map(m => (
              <div key={m.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1 truncate">{m.name}</span>
                <span className="rounded-full bg-accent/60 px-2 py-0.5 text-[10px] capitalize text-muted-foreground">{m.role}</span>
                <Button variant="ghost" size="icon-sm" onClick={() => kick(m.userId)} aria-label="Remove" className="text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" /></Button>
              </div>
            ))}
            {candidates.length > 0 && (
              <div className="flex items-center gap-1.5">
                <select value={addUser} onChange={(e) => setAddUser(e.target.value)}
                  className="h-9 min-w-0 flex-1 rounded-control border border-border bg-background px-2.5 text-sm outline-none focus:border-primary">
                  <option value="">Add someone…</option>
                  {candidates.map(p => <option key={p.id} value={p.id}>{p.nickname}</option>)}
                </select>
                <select value={addRole} onChange={(e) => setAddRole(e.target.value as 'viewer' | 'editor')}
                  className="h-9 rounded-control border border-border bg-background px-2.5 text-sm outline-none focus:border-primary">
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <Button size="icon-sm" onClick={invite} disabled={!addUser} aria-label="Invite"><UserPlus className="size-4" /></Button>
              </div>
            )}
          </Section>

          <Section title="Subscribe to an RSS feed">
            <p className="text-xs text-muted-foreground">New items from this feed are auto-saved into this collection.</p>
            <div className="flex items-center gap-1.5">
              <Input placeholder="https://example.com/feed.xml" value={rssUrl} onChange={(e) => setRssUrl(e.target.value)} className="text-sm" />
              <Button variant="outline" size="sm" onClick={saveRss} className="gap-1.5"><Check className="size-4" />Save</Button>
            </div>
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">Auto-tag new items with AI</span>
              <Switch checked={rssAutoTag} onCheckedChange={setRssAutoTag} />
            </label>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
