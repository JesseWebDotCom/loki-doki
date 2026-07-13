import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Library, Bookmark, FileText, FolderOpen, Tag, Pin, Plus, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Card } from '@/components/ui/card'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { getAppByPath } from '@/lib/appCategories'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { useBookmarkUI } from '@/components/bookmarks/BookmarksLayout'
import { BookmarkCard } from '@/components/bookmarks/BookmarkCard'
import { getHome, listCollections, updateItem, deleteItem, type BookmarkItem } from '@/lib/bookmarks/api'

function StatCard({ icon: Icon, label, value, to }: { icon: typeof Library; label: string; value: number; to: string }) {
  return (
    <Link to={to}>
      <Card className="flex items-center gap-3 border-border/60 p-4 transition-colors hover:border-border">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-accent/60"><Icon className="size-5 text-muted-foreground" /></div>
        <div className="min-w-0">
          <p className="text-2xl font-semibold leading-none">{value}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{label}</p>
        </div>
      </Card>
    </Link>
  )
}

export function BookmarksHomePage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { openSave } = useBookmarkUI()
  useAppHeader({ query: '', setQuery: () => {}, searchable: false })

  const { data: home, isLoading } = useQuery({ queryKey: ['bookmark-home'], queryFn: getHome })
  const { data: collections = [] } = useQuery({ queryKey: ['bookmark-collections'], queryFn: listCollections })
  const collById = useMemo(() => new Map(collections.map(c => [c.id, c])), [collections])

  function openItem(item: BookmarkItem) {
    if (item.type === 'live' && !item.useEmbed && item.contentKind === 'link') { window.open(item.url, '_blank', 'noopener'); return }
    navigate(`/bookmarks/read/${item.id}`)
  }
  async function togglePin(item: BookmarkItem) {
    await updateItem(item.id, { isPinned: !item.isPinned })
    qc.invalidateQueries({ queryKey: ['bookmark-home'] }); qc.invalidateQueries({ queryKey: ['bookmarks'] })
  }
  async function removeItem(item: BookmarkItem) {
    await deleteItem(item.id); qc.invalidateQueries({ queryKey: ['bookmark-home'] })
  }

  const actions = { onOpen: openItem, onTogglePin: togglePin, onDelete: removeItem, collections }

  if (isLoading) return <PageContainer width="wide" className="py-6"><div className="flex justify-center py-20"><Spinner size="lg" /></div></PageContainer>

  const stats = home?.stats
  const isEmpty = (stats?.total ?? 0) === 0

  if (isEmpty) {
    return (
      <PageContainer width="wide" className="py-6">
        <EmptyAppState
          icon={Bookmark}
          gradient={getAppByPath('/bookmarks')?.gradient}
          title="Your private read-it-later & web archive"
          tagline="Save any link, read it later distraction-free, and keep a full offline copy that's yours forever."
          actions={<>
            <Button onClick={openSave}><Plus className="mr-1.5 size-4" />Save your first link</Button>
            <Link to="/bookmarks/settings"><Button variant="outline">Get the Save bookmarklet</Button></Link>
          </>}
        />
      </PageContainer>
    )
  }

  return (
    <PageContainer width="wide" className="space-y-8 py-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={Library} label="Bookmarks" value={stats?.total ?? 0} to="/bookmarks/all" />
        <StatCard icon={Bookmark} label="Live links" value={stats?.live ?? 0} to="/bookmarks/all?type=live" />
        <StatCard icon={FolderOpen} label="Collections" value={stats?.collections ?? 0} to="/bookmarks/all" />
        <StatCard icon={Tag} label="Tags" value={stats?.tags ?? 0} to="/bookmarks/tags" />
      </div>

      {home && home.pinned.length > 0 && (
        <section>
          <SectionHeader title="Pinned" lead={<Pin className="size-4 text-primary" />} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {home.pinned.map(item => <BookmarkCard key={item.id} item={item} collById={collById} view="grid" actions={actions} />)}
          </div>
        </section>
      )}

      <section>
        <SectionHeader title="Recent" lead={<FileText className="size-4 text-muted-foreground" />} action={
          <Link to="/bookmarks/all"><Button variant="ghost" size="sm" className="gap-1 text-muted-foreground">All bookmarks <ArrowRight className="size-4" /></Button></Link>
        } />
        {home && home.recent.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {home.recent.map(item => <BookmarkCard key={item.id} item={item} collById={collById} view="grid" actions={actions} />)}
          </div>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">Nothing saved yet.</p>
        )}
      </section>
    </PageContainer>
  )
}
