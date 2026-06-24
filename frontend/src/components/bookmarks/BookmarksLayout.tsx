import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { BookmarksRail } from '@/components/bookmarks/BookmarksRail'
import { BookmarkSaveDialog } from '@/components/bookmarks/BookmarkSaveDialog'

interface BookmarkUI { openSave: () => void }
const BookmarkUICtx = createContext<BookmarkUI | null>(null)
export function useBookmarkUI() {
  const ctx = useContext(BookmarkUICtx)
  if (!ctx) throw new Error('useBookmarkUI must be inside BookmarksLayout')
  return ctx
}

export function BookmarksLayout() {
  const { pathname } = useLocation()
  const [saveOpen, setSaveOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  usePublishUIContext({ label: 'Bookmarks', description: 'User is browsing their Bookmarks library (saved links & offline articles).' })
  useEffect(() => { scrollRef.current?.scrollTo(0, 0) }, [pathname])

  return (
    <BookmarkUICtx.Provider value={{ openSave: () => setSaveOpen(true) }}>
      <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
        <BookmarksRail onSave={() => setSaveOpen(true)} />
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none"><Outlet /></div>
      </div>
      <BookmarkSaveDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
    </BookmarkUICtx.Provider>
  )
}
