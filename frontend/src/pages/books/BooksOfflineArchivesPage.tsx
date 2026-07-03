// Cross-lists installed offline-library archives tagged category "Books" (bulk
// public-domain packs like Gutenberg/Wikisource) alongside the Books app's own
// per-title library. No new pipeline: this is a read-only filtered view over the
// same /api/archives/installed the generic offline-library grid already uses;
// opening one still goes through the existing /read/:sourceId ZIM viewer.

import { Link } from 'react-router-dom'
import { Archive as ArchiveIconLucide } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { Card } from '@/components/ui/card'
import { useInstalledArchives } from '@/hooks/useInstalledArchives'
import { ArchiveIcon } from '@/components/shared/ArchiveIcon'
import { formatBytes } from '@/lib/archiveCategories'
import { Spinner } from '@/components/ui/spinner'
import { getAppByPath } from '@/lib/appCategories'

const BOOKS_GRADIENT = getAppByPath('/books')?.gradient

export function BooksOfflineArchivesPage() {
  const { data: archives = [], isLoading } = useInstalledArchives()
  const bookPacks = archives.filter((a) => a.category === 'Books')

  if (isLoading) {
    return <div className="flex h-full items-center justify-center py-24"><Spinner size="lg" /></div>
  }

  if (!bookPacks.length) {
    return (
      <div className="h-full overflow-y-auto">
        <PageContainer width="wide">
          <EmptyAppState
            icon={ArchiveIconLucide}
            title="No offline book packs installed"
            tagline="Install a bulk public-domain collection (Project Gutenberg, Wikisource, and more) to read thousands of books fully offline."
            gradient={BOOKS_GRADIENT}
            actions={<Link to="/categories" className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover">Browse the offline library</Link>}
            features={[]}
          />
        </PageContainer>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="pb-16">
        <PageHeader title="Offline Archives" eyebrow="Books" subtitle="Bulk public-domain collections: read thousands of books entirely offline." />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {bookPacks.map((a) => (
            <Link key={a.id} to={`/books/archives/${a.sourceId}`}>
              <Card variant="interactive" className="flex items-center gap-3 p-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-gradient-to-br from-brand to-brand/60">
                  <ArchiveIcon zimIconUrl={a.zimIconUrl} category={a.category} className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.label}</p>
                  {a.description && <p className="truncate text-xs text-muted-foreground">{a.description}</p>}
                </div>
                {formatBytes(a.fileSizeBytes) && <span className="shrink-0 text-[10px] text-muted-foreground">{formatBytes(a.fileSizeBytes)}</span>}
              </Card>
            </Link>
          ))}
        </div>
      </PageContainer>
    </div>
  )
}
