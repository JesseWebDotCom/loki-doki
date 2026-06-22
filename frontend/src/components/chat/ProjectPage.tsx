import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, FolderIcon, MoreHorizontal, Pencil, Plus, Trash2,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { useChatContext } from '@/context/ChatContext'
import type { Project } from '@/context/ChatContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { resolveProjectColor } from '@/components/shared/ColorPicker'
import { getIconChoice } from '@/components/shared/IconPicker'
import { ProjectEditor } from '@/components/chat/ProjectEditor'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ChatListRow } from '@/components/chat/ChatListRow'
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
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        <button
          onClick={() => navigate('/chat/projects')}
          className="mb-5 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          All projects
        </button>

        {/* Header */}
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl"
            style={{ backgroundColor: `color-mix(in oklch, ${color} 16%, transparent)`, color }}
          >
            <Icon className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold leading-tight">{project.name}</h1>
            {project.description && (
              <p className="mt-1 text-sm text-muted-foreground">{project.description}</p>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground">
                <MoreHorizontal className="size-4" />
              </button>
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
        </div>

        {/* New chat */}
        <button
          onClick={handleNewChat}
          className="mt-5 flex w-full items-center gap-2 rounded-xl border border-border/40 bg-card px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        >
          <Plus className="size-4" />
          New chat in this project
        </button>

        {/* Instructions */}
        {project.instructions && (
          <div className="mt-5 rounded-xl border border-border/30 bg-foreground/[0.02] p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
              Instructions
            </p>
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted-foreground">
              {project.instructions}
            </p>
          </div>
        )}

        {/* Conversations */}
        <div className="mt-6">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
            {projConvs.length} {projConvs.length === 1 ? 'chat' : 'chats'}
          </p>
          {projConvs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground/50">
              No chats in this project yet.
            </p>
          ) : (
            <div className={cn('rounded-xl')}>
              {projConvs.map((conv) => (
                <ChatListRow
                  key={conv.id}
                  title={conv.title}
                  updatedAt={conv.updatedAt}
                  onSelect={() => navigate(`/chat/${conv.id}`)}
                  onDelete={() => setDeleteConvTarget(conv.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

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
    </div>
  )
}
