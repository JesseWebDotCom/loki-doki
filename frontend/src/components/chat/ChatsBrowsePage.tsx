import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Archive, ArchiveRestore, Download, History, ListChecks, MessageSquare, Plus, Search, Trash2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { useChatContext } from '@/context/ChatContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { Button } from '@/components/ui/button'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { AppTabBar } from '@/components/shared/AppTabBar'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ChatListRow } from '@/components/chat/ChatListRow'
import { formatRelativeTime } from '@/lib/relativeTime'

type BrowseTab = 'all' | 'archived' | 'deleted'

interface LifecycleRow {
  id: string
  title: string
  updatedAt: Date
}

interface MessageHit {
  conversationId: string
  messageId: string
  title: string | null
  role: string
  snippet: string
  createdAt: number
}

/** Full, searchable list of every conversation - the "View all" target for Chats.
 *  Search matches message CONTENT server-side (FTS), not just titles; tabs expose
 *  the archive and the 30-day "Recently deleted" bin. */
export function ChatsBrowsePage() {
  const navigate = useNavigate()
  const {
    conversations, projects,
    newConversation, setCurrentProject, deleteConversation, refreshConversations,
  } = useChatContext()
  const [tab, setTab] = useState<BrowseTab>('all')
  const [query, setQuery] = useState('')
  const [messageHits, setMessageHits] = useState<MessageHit[]>([])
  const [lifecycleRows, setLifecycleRows] = useState<LifecycleRow[]>([])
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

  // Archived / Recently-deleted rows come from the server on tab switch (they are
  // excluded from the context's live conversation list by design).
  useEffect(() => {
    if (tab === 'all') { setLifecycleRows([]); return }
    let cancelled = false
    fetch(`/api/chat/conversations?filter=${tab}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ id: string; title: string | null; createdAt: number; updatedAt: number | null }>) => {
        if (cancelled) return
        setLifecycleRows(rows.map((r) => ({
          id: r.id,
          title: r.title ?? 'Untitled',
          updatedAt: new Date((r.updatedAt ?? r.createdAt) * 1000),
        })))
      })
      .catch(() => { /* offline */ })
    return () => { cancelled = true }
  }, [tab])

  // Debounced server-side message-content search (FTS5 over the full history).
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2 || tab !== 'all') { setMessageHits([]); return }
    const t = setTimeout(() => {
      fetch(`/api/chat/search?q=${encodeURIComponent(q)}`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((data: { results: MessageHit[] }) => setMessageHits(data.results))
        .catch(() => setMessageHits([]))
    }, 250)
    return () => clearTimeout(t)
  }, [query, tab])

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
    setLifecycleRows((prev) => prev.filter((r) => r.id !== deleteConvTarget))
    setDeleteConvTarget(null)
    toast.success('Chat moved to Recently deleted')
  }

  async function handleConfirmBulkDelete() {
    const ids = [...selected]
    if (ids.length === 0) return
    await Promise.all(ids.map((id) => deleteConversation(id)))
    setSelected(new Set())
    setSelectMode(false)
    toast.success(ids.length === 1 ? 'Chat moved to Recently deleted' : `${ids.length} chats moved to Recently deleted`)
  }

  async function archiveConversation(id: string, archived: boolean) {
    await fetch(`/api/chat/conversations/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived }),
    }).catch(() => {})
    await refreshConversations()
    setLifecycleRows((prev) => prev.filter((r) => r.id !== id))
    toast.success(archived ? 'Chat archived' : 'Chat unarchived')
  }

  async function restoreConversation(id: string) {
    await fetch(`/api/chat/conversations/${id}/restore`, { method: 'POST', credentials: 'include' }).catch(() => {})
    await refreshConversations()
    setLifecycleRows((prev) => prev.filter((r) => r.id !== id))
    toast.success('Chat restored')
  }

  function exportConversation(id: string, format: 'md' | 'json') {
    // Content-Disposition attachment - a plain navigation downloads without leaving the page.
    window.location.assign(`/api/chat/conversations/${id}/export?format=${format}`)
  }

  const rowActions = (convId: string) => (
    <>
      <Button variant="ghost" size="icon-sm" title="Download as markdown" aria-label="Download as markdown"
        onClick={() => exportConversation(convId, 'md')}
        className="shrink-0 rounded-control text-muted-foreground/50 hover:text-foreground">
        <Download className="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon-sm" title="Archive" aria-label="Archive conversation"
        onClick={() => void archiveConversation(convId, true)}
        className="shrink-0 rounded-control text-muted-foreground/50 hover:text-foreground">
        <Archive className="size-3.5" />
      </Button>
    </>
  )

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="narrow" className="py-6">
        <PageHeader
          title="Chats"
          className="pt-0 pb-4"
          actions={
            <div className="flex items-center gap-2">
              {tab === 'all' && conversations.length > 0 && (
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

        <AppTabBar
          className="mb-3"
          tabs={[
            { id: 'all' as const, label: 'All chats', icon: MessageSquare },
            { id: 'archived' as const, label: 'Archived', icon: Archive },
            { id: 'deleted' as const, label: 'Recently deleted', icon: History },
          ]}
          value={tab}
          onChange={(id) => { setTab(id); setSelectMode(false); setSelected(new Set()) }}
        />

        {tab === 'all' && (
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all messages…"
              className="w-full rounded-control border border-border/40 bg-card py-2.5 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-border"
            />
          </div>
        )}

        {tab === 'all' && selectMode && (
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

        {tab === 'all' && (
          <>
            {/* Message-content hits from the server FTS - deep links into conversations. */}
            {messageHits.length > 0 && (
              <div className="mb-4">
                <p className="pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">In messages</p>
                {messageHits.map((hit) => (
                  <button
                    key={hit.messageId}
                    onClick={() => navigate(`/chat/${hit.conversationId}`)}
                    className="flex w-full flex-col gap-0.5 border-b border-border/15 py-2.5 text-left transition-colors last:border-0 hover:bg-foreground/[0.03]"
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-sm text-foreground">{hit.title ?? 'Untitled'}</span>
                      <span className="shrink-0 text-xs text-muted-foreground/50">{formatRelativeTime(new Date(hit.createdAt * 1000))}</span>
                    </span>
                    {/* snippet() output carries <mark> around matched terms */}
                    <span
                      className="line-clamp-2 text-xs text-muted-foreground [&_mark]:rounded-[3px] [&_mark]:bg-brand/20 [&_mark]:px-0.5 [&_mark]:text-foreground"
                      dangerouslySetInnerHTML={{ __html: sanitizeSnippet(hit.snippet) }}
                    />
                  </button>
                ))}
              </div>
            )}

            {filtered.length === 0 && messageHits.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground/50">
                {conversations.length === 0 ? 'No chats yet.' : 'No chats match your search.'}
              </p>
            ) : (
              <div>
                {messageHits.length > 0 && filtered.length > 0 && (
                  <p className="pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">Chats</p>
                )}
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
                    actions={rowActions(conv.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'archived' && (
          lifecycleRows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground/50">No archived chats.</p>
          ) : (
            <div>
              {lifecycleRows.map((row) => (
                <ChatListRow
                  key={row.id}
                  title={row.title}
                  updatedAt={row.updatedAt}
                  onSelect={() => navigate(`/chat/${row.id}`)}
                  onDelete={() => setDeleteConvTarget(row.id)}
                  actions={
                    <Button variant="ghost" size="icon-sm" title="Unarchive" aria-label="Unarchive conversation"
                      onClick={() => void archiveConversation(row.id, false)}
                      className="shrink-0 rounded-control text-muted-foreground/50 hover:text-foreground">
                      <ArchiveRestore className="size-3.5" />
                    </Button>
                  }
                />
              ))}
            </div>
          )
        )}

        {tab === 'deleted' && (
          lifecycleRows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground/50">
              Nothing here. Deleted chats stay recoverable for 30 days.
            </p>
          ) : (
            <div>
              {lifecycleRows.map((row) => (
                <ChatListRow
                  key={row.id}
                  title={row.title}
                  updatedAt={row.updatedAt}
                  onSelect={() => void restoreConversation(row.id)}
                  actions={
                    <Button variant="ghost" size="icon-sm" title="Restore" aria-label="Restore conversation"
                      onClick={() => void restoreConversation(row.id)}
                      className="shrink-0 rounded-control text-muted-foreground/50 hover:text-foreground">
                      <Undo2 className="size-3.5" />
                    </Button>
                  }
                />
              ))}
            </div>
          )
        )}
      </PageContainer>

      <ConfirmDialog
        open={deleteConvTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteConvTarget(null) }}
        title="Delete conversation?"
        description="It will move to Recently deleted, where you can restore it for 30 days."
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirmDeleteConv}
      />
      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={selected.size === 1 ? 'Delete 1 chat?' : `Delete ${selected.size} chats?`}
        description="The selected conversations will move to Recently deleted, where you can restore them for 30 days."
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirmBulkDelete}
      />
    </div>
  )
}

/** The FTS snippet is our own message text plus <mark> wrappers, but it renders via
 *  dangerouslySetInnerHTML - escape everything, then re-allow exactly <mark>. */
function sanitizeSnippet(snippet: string): string {
  const escaped = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>')
}
