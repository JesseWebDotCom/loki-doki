import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, FolderIcon, ListChecks, MoreHorizontal, Pencil, Plus, Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { useChatContext } from '@/context/ChatContext'
import type { Project } from '@/context/ChatContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { resolveProjectColor } from '@/components/shared/ColorPicker'
import { getIconChoice } from '@/components/shared/IconPicker'
import { ProjectEditor } from '@/components/chat/ProjectEditor'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ChatListRow } from '@/components/chat/ChatListRow'
import { ProjectDocumentsPanel } from '@/components/chat/ProjectDocumentsPanel'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** Project landing page: description, instructions, and the project's conversations. */
export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const {
    projects, conversations,
    setCurrentProject, newConversation,
    deleteProject, deleteConversation,
  } = useChatContext()

  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId])

  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteConvTarget, setDeleteConvTarget] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)

  // Make this project the active one (so new chats are filed under it) and clear
  // any open conversation. Re-runs when the project changes.
  useEffect(() => {
    if (!project) return
    setCurrentProject(project)
    newConversation()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  usePublishUIContext({
    label: 'Chat',
    description: project
      ? `User is viewing the "${project.name}" project page in the Chat app.`
      : 'User is viewing a project in the Chat app.',
  })

  const projConvs = useMemo(
    () => conversations.filter((c) => c.projectId === projectId),
    [conversations, projectId],
  )

  // Project list may still be loading on a direct page load.
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {projects.length === 0 ? 'Loading…' : 'Project not found.'}
      </div>
    )
  }

  const choice = getIconChoice(project.icon)
  const Icon = choice?.Icon ?? FolderIcon
  const color = resolveProjectColor(project.color)

  function handleNewChat() {
    newConversation()
    navigate('/chat')
  }

  async function handleConfirmDelete() {
    const id = project!.id
    await deleteProject(id)
    setConfirmDelete(false)
    navigate('/chat/projects')
  }

  async function handleConfirmDeleteConv() {
    if (!deleteConvTarget) return
    await deleteConversation(deleteConvTarget)
    setDeleteConvTarget(null)
    toast.success('Chat deleted')
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
        <button
          onClick={() => navigate('/chat/projects')}
          className="mb-5 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          All projects
        </button>

        <PageHeader
          title={project.name}
          subtitle={project.description ?? undefined}
          icon={Icon}
          gradient={color}
          className="pt-0 pb-5"
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Project options" className="shrink-0 text-muted-foreground hover:text-foreground">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem onClick={() => setEditing(true)}>
                  <Pencil className="size-3.5" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setConfirmDelete(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />

        {/* New chat */}
        <Button
          variant="outline"
          onClick={handleNewChat}
          className="mt-5 w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-4" />
          New chat in this project
        </Button>

        {/* Instructions */}
        {project.instructions && (
          <Card variant="flat" className="mt-5 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
              Instructions
            </p>
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted-foreground">
              {project.instructions}
            </p>
          </Card>
        )}

        {/* Documents + long-form generation */}
        <ProjectDocumentsPanel projectId={project.id} />

        {/* Conversations */}
        <div className="mt-6">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
              {projConvs.length} {projConvs.length === 1 ? 'chat' : 'chats'}
            </p>
            {projConvs.length > 0 && (
              <Button
                variant={selectMode ? 'secondary' : 'ghost'}
                size="sm"
                onClick={toggleSelectMode}
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
              >
                <ListChecks className="size-3.5" />
                {selectMode ? 'Done' : 'Select'}
              </Button>
            )}
          </div>
          {selectMode && (
            <div className="mb-2 flex items-center gap-3 rounded-control border border-border/40 bg-card px-3 py-2">
              {/* design-ok(raw-input-element): native checkbox for bulk-select, no ui/ Checkbox primitive (same pattern as AdminUsersTab) */}
              <input
                type="checkbox"
                checked={projConvs.length > 0 && projConvs.every((c) => selected.has(c.id))}
                onChange={() => {
                  if (projConvs.every((c) => selected.has(c.id))) setSelected(new Set())
                  else setSelected(new Set(projConvs.map((c) => c.id)))
                }}
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
          {projConvs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground/50">
              No chats in this project yet.
            </p>
          ) : (
            <div className="rounded-card">
              {projConvs.map((conv) => (
                <ChatListRow
                  key={conv.id}
                  title={conv.title}
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
        </div>
      </PageContainer>

      {/* Modals */}
      <ProjectEditor
        open={editing}
        project={project as Project}
        onOpenChange={(open) => { if (!open) setEditing(false) }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${project.name}"?`}
        description="All conversations in this project will move to All chats."
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirmDelete}
      />
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
