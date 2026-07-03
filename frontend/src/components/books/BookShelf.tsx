// Horizontal cover-art shelf, the Apple-Books-style building block for every Books
// "store" page (Home/Book Store/Audiobook Store): a title, and a row of tiles the
// caller supplies. Layout only: what's inside each tile (BookCard, a search
// result, an offline-archive pack) varies per page, so this doesn't own item
// rendering.

import type { ReactNode } from 'react'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Spinner } from '@/components/ui/spinner'

export function BookShelf({ title, to, count, loading, empty, children }: {
  title: string
  /** "See all" link: the deep view-by-category page behind this shelf's preview. */
  to?: string
  count?: number
  loading?: boolean
  empty?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <SectionHeader title={title} to={to} count={count} className="mb-4" />
      {loading ? (
        <div className="flex h-40 items-center justify-center"><Spinner /></div>
      ) : empty ? (
        <div className="py-6 text-sm text-muted-foreground">{empty}</div>
      ) : (
        <div className="flex gap-5 overflow-x-auto pb-2 no-scrollbar">{children}</div>
      )}
    </section>
  )
}

export function ShelfSlot({ children }: { children: ReactNode }) {
  return <div className="w-36 shrink-0 sm:w-40">{children}</div>
}
