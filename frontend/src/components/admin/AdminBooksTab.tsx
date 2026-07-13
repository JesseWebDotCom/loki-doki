// Admin > Integrations > Books: control built-in catalogs and manage custom
// self-hosted OPDS indexers for the whole instance.

import { BookAudio } from 'lucide-react'
import { IndexerManager } from '@/components/books/IndexerManager'
import { BookSourceManager } from '@/components/books/BookSourceManager'
import { BookRequestsManager } from '@/components/books/BookRequestsManager'

export function AdminBooksTab() {
  return (
    <div className="flex max-w-2xl flex-col gap-6 p-5">
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-control bg-muted p-2"><BookAudio className="size-5 text-muted-foreground" /></div>
        <div>
          <h2 className="text-title">Books Sources</h2>
          <p className="text-sm text-muted-foreground">
            Choose the catalogs used by search and browsing for every user. You can also add a self-hosted OPDS catalog.
          </p>
        </div>
      </div>

      <BookSourceManager />
      <div className="border-t border-border pt-6">
        <BookRequestsManager />
      </div>
      <div className="border-t border-border pt-6">
        <IndexerManager />
      </div>
    </div>
  )
}
