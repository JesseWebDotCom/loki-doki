// Admin > Integrations > Books: manage custom self-hosted OPDS indexers. Built-in
// source toggles (Gutenberg/Internet Archive/LibriVox) live in-app instead, at
// Books > Sources: any household member can flip those, no admin needed.

import { BookAudio } from 'lucide-react'
import { IndexerManager } from '@/components/books/IndexerManager'

export function AdminBooksTab() {
  return (
    <div className="flex max-w-2xl flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-control bg-muted p-2"><BookAudio className="size-5 text-muted-foreground" /></div>
        <div>
          <h2 className="text-title">Books: Self-Hosted Indexers</h2>
          <p className="text-sm text-muted-foreground">
            Optional. Point the Book Store at your own OPDS catalogs as extra search sources beyond the built-in
            Project Gutenberg, Internet Archive, and LibriVox. Only entries with a direct EPUB download link are shown.
            Turning the built-ins on/off is in the Books app itself, under Sources.
          </p>
        </div>
      </div>

      <IndexerManager />
    </div>
  )
}
