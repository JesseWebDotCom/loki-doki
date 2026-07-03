import { BookAudio } from 'lucide-react'
import { AppSettingsPage } from '@/components/shared/AppSettingsPage'
import { BookSourceManager } from '@/components/books/BookSourceManager'
import { IndexerManager } from '@/components/books/IndexerManager'
import { getAppByPath } from '@/lib/appCategories'

const BOOKS_GRADIENT = getAppByPath('/books')!.gradient

export function BooksSourcesPage() {
  return (
    <AppSettingsPage
      title="Sources"
      backTo="/books"
      backLabel="Book Store"
      icon={BookAudio}
      gradient={BOOKS_GRADIENT}
      adminSection={(
        <div className="space-y-6">
          <BookSourceManager />
          <div className="border-t border-border pt-6"><IndexerManager /></div>
        </div>
      )}
      adminNotice="Book sources are managed by an administrator in Admin > Integrations > Books."
    >
      <div>
        <h2 className="text-sm font-semibold">Catalog Sources</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Search combines enabled ebook catalogs, audiobook services, previews, web results, and configured OPDS servers.
        </p>
      </div>
    </AppSettingsPage>
  )
}
