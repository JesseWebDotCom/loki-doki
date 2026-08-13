import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Newspaper, RefreshCw, WifiOff, Plus, MoreHorizontal, EyeOff, Settings2, Trash2, Rss, Circle, Bookmark, Upload, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { PageShell } from '@/components/shared/PageShell'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { NewsFeature, NewsRow, hostFromUrl } from '@/components/shared/NewsCard'
import { FaviconImg } from '@/components/shared/FaviconImg'
import { toast } from '@/lib/toast'
import {
  newsQueryOptions, newsCategoriesQueryOptions,
  hideCategory, unhideCategory, createPersonalCategory, deletePersonalCategory,
  type NewsCategory,
} from '@/lib/news/useNews'
import { listFeeds, addFeed, deleteFeed, refreshFeedApi, importOpml, type Feed } from '@/lib/feeds/api'
import { FeedListView, type FeedScope } from '@/components/news/FeedListView'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { useCurrentPlace } from '@/hooks/useCurrentPlace'

const SCOPES: { key: FeedScope; label: string; icon: typeof Rss }[] = [
  { key: 'all', label: 'All', icon: Rss },
  { key: 'unread', label: 'Unread', icon: Circle },
  { key: 'saved', label: 'Saved', icon: Bookmark },
]

export function NewsPage() {
  useAppHeader({ query: '', setQuery: () => {}, searchable: false, settingsHref: '/apps/news/settings' })
  const qc = useQueryClient()
  // `sel` is either a category id, or `scope:<all|unread|saved>` for the power feed reader.
  const [sel, setSel] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addFeedOpen, setAddFeedOpen] = useState(false)
  const [managing, setManaging] = useState<NewsCategory | null>(null)
  const [deleting, setDeleting] = useState<NewsCategory | null>(null)
  const opmlRef = useRef<HTMLInputElement>(null)

  const { data: categories = [] } = useQuery(newsCategoriesQueryOptions())
  const visible = useMemo(() => categories.filter((c) => !c.hidden), [categories])
  const hidden = useMemo(() => categories.filter((c) => c.hidden), [categories])

  const scope: FeedScope | null = sel?.startsWith('scope:') ? (sel.slice(6) as FeedScope) : null

  // Resolve the active category (only when not in a feed scope): the clicked tab if still
  // visible, else ?tab=, else the first.
  const active = useMemo(() => {
    if (scope) return null
    if (sel && visible.some((c) => c.id === sel)) return visible.find((c) => c.id === sel)!
    const param = new URLSearchParams(window.location.search).get('tab')
    return visible.find((c) => c.slug === param || c.id === param) ?? visible[0] ?? null
  }, [sel, scope, visible])

  usePublishUIContext({ label: 'News', description: scope ? `User is browsing their ${scope} feeds.` : `User is reading ${active?.name ?? ''} news.` })

  // While traveling, the Local tab covers the town the device is actually in
  // (same current-place signal the weather surfaces use). Home behavior otherwise.
  const { current } = useCurrentPlace()
  const { data: items = [], isLoading, isError, refetch } = useQuery({
    ...newsQueryOptions(active?.id ?? '', active?.slug === 'local' ? current?.label : undefined),
    enabled: !!active && !scope,
  })
  const status = !active ? 'empty' : isLoading ? 'loading' : isError || items.length === 0 ? 'error' : 'ready'

  const featured = items.slice(0, 3)
  const rest = items.slice(3)

  const invalidateCats = () => qc.invalidateQueries({ queryKey: ['news-categories'] })

  async function onHide(cat: NewsCategory) {
    await hideCategory(cat.id)
    if (active?.id === cat.id) setSel(null)
    toast.success(`Hid ${cat.name}`)
    invalidateCats()
  }
  async function onUnhide(cat: NewsCategory) {
    await unhideCategory(cat.id)
    setSel(cat.id)
    invalidateCats()
  }
  async function onOpml(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    try { const n = await importOpml(await f.text()); toast.success(`Imported ${n} feeds`); qc.invalidateQueries({ queryKey: ['feeds'] }) }
    catch { toast.error('Import failed') } finally { if (opmlRef.current) opmlRef.current.value = '' }
  }

  return (
    <PageShell>
      <PageContainer>
      <PageHeader
        title="News"
        subtitle="Global headlines, local news, and your RSS feeds - all in one place."
        actions={
          <div className="flex items-center gap-2">
            <div className="inline-flex max-w-[60vw] items-center gap-1 overflow-x-auto rounded-full border border-border bg-secondary/50 p-1">
              {SCOPES.map((s) => (
                <Button
                  key={s.key}
                  size="sm"
                  variant={scope === s.key ? 'default' : 'ghost'}
                  onClick={() => setSel(`scope:${s.key}`)}
                  className={`shrink-0 gap-1.5 ${scope !== s.key ? 'text-muted-foreground hover:text-foreground' : ''}`}
                >
                  <s.icon className="size-3.5" />{s.label}
                </Button>
              ))}
              {visible.length > 0 && <span className="mx-0.5 h-5 w-px shrink-0 bg-border" />}
              {visible.map((c) => (
                <Button
                  key={c.id}
                  size="sm"
                  variant={active?.id === c.id ? 'default' : 'ghost'}
                  onClick={() => setSel(c.id)}
                  className={`shrink-0 ${active?.id !== c.id ? 'text-muted-foreground hover:text-foreground' : ''}`}
                >
                  {c.name}
                </Button>
              ))}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="size-8 shrink-0 text-muted-foreground hover:text-foreground" aria-label="News settings">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {active && (
                  <>
                    <DropdownMenuLabel className="truncate">{active.name}</DropdownMenuLabel>
                    {active.editable && (
                      <DropdownMenuItem onClick={() => setManaging(active)}>
                        <Settings2 className="mr-2 size-4" /> Manage feeds
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => onHide(active)}>
                      <EyeOff className="mr-2 size-4" /> Hide this tab
                    </DropdownMenuItem>
                    {active.editable && (
                      <DropdownMenuItem onClick={() => setDeleting(active)} className="text-destructive focus:text-destructive">
                        <Trash2 className="mr-2 size-4" /> Delete category
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={() => setAddOpen(true)}>
                  <Plus className="mr-2 size-4" /> New category
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAddFeedOpen(true)}>
                  <Rss className="mr-2 size-4" /> Add feed
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => opmlRef.current?.click()}>
                  <Upload className="mr-2 size-4" /> Import OPML
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href="/api/feeds/opml/export"><Globe className="mr-2 size-4" /> Export OPML</a>
                </DropdownMenuItem>
                {hidden.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground">Hidden</DropdownMenuLabel>
                    {hidden.map((c) => (
                      <DropdownMenuItem key={c.id} onClick={() => onUnhide(c)}>
                        <span className="truncate">{c.name}</span>
                        <span className="ml-auto text-xs text-muted-foreground">Show</span>
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      <div className="pb-10">
        {scope ? <FeedListView scope={scope} /> : (<>
        {status === 'loading' && (
          <div className="flex items-center justify-center py-20">
            <Spinner size="lg" />
          </div>
        )}

        {status === 'empty' && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <Newspaper className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No categories yet - add one to start reading.</p>
            <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="mr-1.5 size-4" /> New category</Button>
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <WifiOff className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {active?.editable ? "No articles yet - add a feed to this category." : "Couldn't load news right now."}
            </p>
            <div className="flex gap-2">
              {active?.editable && (
                <Button size="sm" variant="outline" onClick={() => setManaging(active)}><Settings2 className="mr-1.5 size-4" /> Manage feeds</Button>
              )}
              <button onClick={() => refetch()} className="flex items-center gap-1.5 text-xs text-brand hover:underline">
                <RefreshCw className="size-3" /> Try again
              </button>
            </div>
          </div>
        )}

        {status === 'ready' && (
          <div className="space-y-8">
            <section className="space-y-3">
              <SectionHeader title="Featured" />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {featured.map((item, i) => <NewsFeature key={i} item={item} />)}
              </div>
            </section>

            {rest.length > 0 && (
              <section className="space-y-2">
                <SectionHeader title="More Headlines" />
                <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {rest.map((item, i) => <NewsRow key={i} item={item} />)}
                </div>
              </section>
            )}
          </div>
        )}
        </>)}
      </div>

      <input ref={opmlRef} type="file" accept=".opml,.xml,text/xml" className="hidden" onChange={onOpml} />

      <AddCategoryDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(id) => { setSel(id); invalidateCats() }}
      />

      <AddFeedDialog
        open={addFeedOpen}
        onClose={() => setAddFeedOpen(false)}
        onAdded={() => { qc.invalidateQueries({ queryKey: ['feeds'] }); qc.invalidateQueries({ queryKey: ['feed-items'] }) }}
      />

      {managing && (
        <ManageFeedsDialog
          category={managing}
          onClose={() => setManaging(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: ['news', managing.id] })}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => { if (!o) setDeleting(null) }}
        title="Delete this category?"
        description={deleting ? `"${deleting.name}" and its feeds will be removed.` : undefined}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (deleting) {
            await deletePersonalCategory(deleting.id)
            if (active?.id === deleting.id) setSel(null)
            toast.success('Category deleted')
            invalidateCats()
          }
          setDeleting(null)
        }}
      />
      </PageContainer>
    </PageShell>
  )
}

function AddFeedDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit() {
    if (!url.trim()) return
    setBusy(true)
    try { await addFeed({ url: url.trim() }); toast.success('Feed added'); setUrl(''); onAdded(); onClose() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to add feed') }
    finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Add a feed</DialogTitle></DialogHeader>
        <DialogDescription className="sr-only">Add an RSS or website feed.</DialogDescription>
        <p className="text-sm text-muted-foreground">Paste a site or RSS/Atom URL - we'll find the feed automatically. It shows up under All / Unread.</p>
        <Input autoFocus placeholder="https://example.com or .../feed.xml" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submit() }} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Spinner className="mr-1.5 text-current" />}Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AddCategoryDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit() {
    if (!name.trim()) return
    setBusy(true)
    try {
      const id = await createPersonalCategory(name.trim())
      toast.success('Category created')
      setName(''); onCreated(id); onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create category')
    } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>New category</DialogTitle></DialogHeader>
        <DialogDescription className="sr-only">Create a news category.</DialogDescription>
        <p className="text-sm text-muted-foreground">Give it a name, then add RSS feeds to fill it.</p>
        <Input autoFocus placeholder="e.g. Technology" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Spinner className="mr-1.5 text-current" />}Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ManageFeedsDialog({ category, onClose, onChanged }: { category: NewsCategory; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['feeds'], queryFn: listFeeds })
  const feeds = (data?.feeds ?? []).filter((f: Feed) => f.folderId === category.id)

  const refresh = () => { qc.invalidateQueries({ queryKey: ['feeds'] }); onChanged() }

  async function add() {
    if (!url.trim()) return
    setBusy(true)
    try {
      const id = await addFeed({ url: url.trim(), folderId: category.id })
      // Wait for the first fetch so articles are present before the News list refetches
      // (otherwise the category reads back empty).
      await refreshFeedApi(id).catch(() => {})
      toast.success('Feed added')
      setUrl(''); refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add feed')
    } finally { setBusy(false) }
  }
  async function remove(f: Feed) {
    await deleteFeed(f.id)
    toast.success('Feed removed')
    refresh()
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Manage feeds - {category.name}</DialogTitle></DialogHeader>
        <DialogDescription className="sr-only">Add or remove feeds in this category.</DialogDescription>

        <div className="flex gap-2">
          <Input autoFocus placeholder="https://example.com or .../feed.xml" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add() }} />
          <Button onClick={add} disabled={busy}>{busy ? <Spinner className="text-current" /> : <Plus className="size-4" />}</Button>
        </div>

        <div className="max-h-72 space-y-1 overflow-y-auto">
          {isLoading && <div className="py-6 text-center"><Spinner className="mx-auto size-5" /></div>}
          {!isLoading && feeds.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No feeds yet. Paste a site or RSS URL above.</p>
          )}
          {feeds.map((f: Feed) => (
            <div key={f.id} className="flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-muted/50">
              <FaviconImg domain={hostFromUrl(f.siteUrl || f.url || undefined) ?? ''} className="size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{f.title || f.url}</div>
                {f.lastError && <div className="truncate text-xs text-destructive">{f.lastError}</div>}
              </div>
              <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => remove(f)} aria-label="Remove feed">
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
