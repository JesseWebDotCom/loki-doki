import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ListChecks, Plus, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useChatContext } from '@/context/ChatContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { Button } from '@/components/ui/button'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ChatListRow } from '@/components/chat/ChatListRow'

/** Full, searchable list of every conversation - the "View all" target for Chats. */
export function ChatsBrowsePage() {
  const navigate = useNavigate()
  const {
    conversations, projects,
    newConversation, setCurrentProject, deleteConversation,
  } = useChatContext()
  const [query, setQuery] = useState('')
  const [deleteConvTarget, setDeleteConvTarget] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)

  // Clear any open conversation so the floating composer starts fresh from here.
  useEffect(() => {
    newConversation()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  usePublishUIContext({ label: 'Chat', description: 'User is browsing all of their chats in the Chat app.' })

  const projectName = useMemo(() => {
    const map = new Map(projects.map((p) => [p.id, p.name]))
    return (id: string | null) => (id ? map.get(id) ?? null : null)
  }, [projects])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => c.title.toLowerCase().includes(q))
  }, [conversations, query])

  const allVisibleSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id))

  function handleNewChat() {
    setCurrentProject(null)
    newConversation()
    navigate('/chat')
  }

  function toggleSelectMode() {
    setSelectMode((on) => !on)
    setSelected(new Set())
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (allVisibleSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map((c) => c.id)))
    }
  }

  async function handleConfirmDeleteConv() {
    if (!deleteConvTarget) return
    await deleteConversation(deleteConvTarget)
    setDeleteConvTarget(null)
    toast.success('Chat deleted')
  }

  async function handleConfirmBulkDelete() {
    const ids = [...selected]
    if (ids.length === 0) return
    await Promise.all(ids.map((id) => deleteConversation(id)))
    setSelected(new Set())
    setSelectMode(false)
    toast.success(ids.length === 1 ? 'Chat deleted' : `${ids.length} chats deleted`)
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="narrow" className="py-6">
        <PageHeader
          title="Chats"
          className="pt-0 pb-4"
          actions={
            <div className="flex items-center gap-2">
              {conversations.length > 0 && (
                <Button variant={selectMode ? 'secondary' : 'ghost'} size="sm" onClick={toggleSelectMode}>
                  <ListChecks className="size-3.5" />
                  {selectMode ? 'Done' : 'Select'}
                </Button>
              )}
              <Button size="sm" onClick={handleNewChat}>
                <Plus className="size-3.5" />
                New chat
              </Button>
            </div>
          }
        />

        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="w-full rounded-control border border-border/40 bg-card py-2.5 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-border"
          />
        </div>

        {selectMode && (
          <div className="mb-2 flex items-center gap-3 rounded-control border border-border/40 bg-card px-3 py-2">
            {/* design-ok(raw-input-element): native checkbox for bulk-select, no ui/ Checkbox primitive (same pattern as AdminUsersTab) */}
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAll}
              aria-label="Select all chats"
              className="size-4 rounded border-border accent-brand"
            />
            <span className="text-sm text-muted-foreground">
              {selected.size === 0 ? 'Select chats' : `${selected.size} selected`}
            </span>
            <Button
              variant="destructive"
              size="sm"
              disabled={selected.size === 0}
              onClick={() => setConfirmBulk(true)}
              className="ml-auto"
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          </div>
        )}

        {filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground/50">
            {conversations.length === 0 ? 'No chats yet.' : 'No chats match your search.'}
          </p>
        ) : (
          <div>
            {filtered.map((conv) => (
              <ChatListRow
                key={conv.id}
                title={conv.title}
                projectName={projectName(conv.projectId)}
                updatedAt={conv.updatedAt}
                onSelect={() => navigate(`/chat/${conv.id}`)}
                onDelete={() => setDeleteConvTarget(conv.id)}
                selectMode={selectMode}
                selected={selected.has(conv.id)}
                onToggleSelect={() => toggleSelected(conv.id)}
              />
            ))}
          </div>
        )}
      </PageContainer>

      <ConfirmDialog
        open={deleteConvTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteConvTarget(null) }}
        title="Delete conversation?"
        description="This conversation will be permanently deleted."
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirmDeleteConv}
      />
      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={selected.size === 1 ? 'Delete 1 chat?' : `Delete ${selected.size} chats?`}
        description="The selected conversations will be permanently deleted."
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirmBulkDelete}
      />
    </div>
  )
}
