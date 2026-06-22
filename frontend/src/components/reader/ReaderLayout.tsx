import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { ReaderRail } from '@/components/reader/ReaderRail'
import { ReaderSaveDialog } from '@/components/reader/ReaderSaveDialog'

interface ReaderUI { openSave: () => void }
const ReaderUICtx = createContext<ReaderUI | null>(null)
export function useReaderUI() {
  const ctx = useContext(ReaderUICtx)
  if (!ctx) throw new Error('useReaderUI must be inside ReaderLayout')
  return ctx
}

export function ReaderLayout() {
  const { pathname } = useLocation()
  const [saveOpen, setSaveOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  usePublishUIContext({ label: 'Reader', description: 'User is browsing their Reader library (saved links & offline articles).' })
  useEffect(() => { scrollRef.current?.scrollTo(0, 0) }, [pathname])

  return (
    <ReaderUICtx.Provider value={{ openSave: () => setSaveOpen(true) }}>
      <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
        <ReaderRail onSave={() => setSaveOpen(true)} />
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none"><Outlet /></div>
      </div>
      <ReaderSaveDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
    </ReaderUICtx.Provider>
  )
}
