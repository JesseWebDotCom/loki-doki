import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { useChatContext } from '@/context/ChatContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ChatListRow } from '@/components/chat/ChatListRow'

/** Full, searchable list of every conversation — the "View all" target for Chats. */
export function ChatsBrowsePage() {
  const navigate = useNavigate()
  const {
    conversations, projects,
    newConversation, setCurrentProject, deleteConversation,
  } = useChatContext()
  const [query, setQuery] = useState('')
  const [deleteConvTarget, setDeleteConvTarget] = useState<string | null>(null)

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

  function handleNewChat() {
    setCurrentProject(null)
    newConversation()
    navigate('/chat')
  }

  async function handleConfirmDeleteConv() {
    if (!deleteConvTarget) return
    await deleteConversation(deleteConvTarget)
    setDeleteConvTarget(null)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Chats</h1>
          <button
            onClick={handleNewChat}
            className="flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
          >
            <Plus className="size-3.5" />
            New chat
          </button>
        </div>

        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="w-full rounded-xl border border-border/40 bg-card py-2.5 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-border"
          />
        </div>

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
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleteConvTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteConvTarget(null) }}
        title="Delete conversation?"
        description="This conversation will be permanently deleted."
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirmDeleteConv}
      />
    </div>
  )
}
