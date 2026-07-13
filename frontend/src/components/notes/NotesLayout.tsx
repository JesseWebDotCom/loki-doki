import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { NotesRail } from '@/components/notes/NotesRail'
import { createNote } from '@/lib/notes/api'

// Pages under the layout publish their own app header (single publisher per route;
// the header config is one last-writer slot). The layout hands them the drawer rail
// node and the shared "new note" action through this context.
interface NotesUI { rail: ReactNode; newNote: () => void }
const NotesUICtx = createContext<NotesUI | null>(null)
export function useNotesUI() {
  const ctx = useContext(NotesUICtx)
  if (!ctx) throw new Error('useNotesUI must be inside NotesLayout')
  return ctx
}

export function NotesLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const scrollRef = useRef<HTMLDivElement>(null)

  usePublishUIContext({ label: 'Notes', description: 'User is browsing their Notes (household knowledge base and personal notes).' })
  useEffect(() => { scrollRef.current?.scrollTo(0, 0) }, [pathname])

  async function newNote() {
    try {
      const note = await createNote({})
      qc.invalidateQueries({ queryKey: ['notes'] })
      navigate(`/notes/${note.id}?new=1`)
    } catch { toast.error('Could not create note') }
  }

  const rail = useMemo(() => <NotesRail variant="drawer" onNewNote={newNote} />, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <NotesUICtx.Provider value={{ rail, newNote }}>
      <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
        <NotesRail onNewNote={newNote} />
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none"><Outlet /></div>
      </div>
    </NotesUICtx.Provider>
  )
}
