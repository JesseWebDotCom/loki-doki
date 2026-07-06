import { BookAudio, Library, ShieldCheck } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { BookSourceManager } from '@/components/books/BookSourceManager'
import { IndexerManager } from '@/components/books/IndexerManager'
import { getAppByPath } from '@/lib/appCategories'

const BOOKS_GRADIENT = getAppByPath('/books')!.gradient

const SECTIONS: AppSettingsSection[] = [
  {
    id: 'catalog',
    label: 'Catalog Sources',
    icon: Library,
    content: (
      <div>
        <h2 className="text-sm font-semibold">Catalog Sources</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Search combines enabled ebook catalogs, audiobook services, previews, web results, and configured OPDS servers.
        </p>
      </div>
    ),
  },
  {
    id: 'admin',
    label: 'Admin',
    icon: ShieldCheck,
    adminOnly: true,
    content: (
      <div className="space-y-6">
        <BookSourceManager />
        <div className="border-t border-border pt-6"><IndexerManager /></div>
      </div>
    ),
  },
]

export function BooksSourcesPage() {
  return (
    <AppSettingsShell
      appId="books"
      icon={BookAudio}
      gradient={BOOKS_GRADIENT}
      sections={SECTIONS}
    />
  )
}
