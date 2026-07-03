import { useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  ChevronRight, FolderIcon, MessageSquare, MoreHorizontal,
  PanelLeftOpen, Pencil, Plus, Trash2,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { ProjectEditor } from '@/components/chat/ProjectEditor'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { resolveProjectColor } from '@/components/shared/ColorPicker'
import { getIconChoice } from '@/components/shared/IconPicker'
import { useChatContext } from '@/context/ChatContext'
import type { Project } from '@/context/ChatContext'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { PageShell } from '@/components/shared/PageShell'

const RECENT_PROJECTS = 5
const RECENT_CHATS = 20

export function ChatLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    conversationId, conversations,
    newConversation, deleteConversation,
    projects, setCurrentProject, deleteProject,
  } = useChatContext()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [deleteConvTarget, setDeleteConvTarget] = useState<string | null>(null)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null)

  // Recent slices. Conversations arrive newest-first; projects sorted by recency.
  const recentProjects = useMemo(
    () => [...projects]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, RECENT_PROJECTS),
    [projects],
  )
  const recentConvs = useMemo(() => conversations.slice(0, RECENT_CHATS), [conversations])

  const activeProjectId = location.pathname.startsWith('/chat/project/')
    ? location.pathname.slice('/chat/project/'.length)
    : null

  function handleNewChat() {
    setCurrentProject(null)
    newConversation()
    navigate('/chat')
    setSheetOpen(false)
  }

  function handleSelectConv(convId: string) {
    navigate(`/chat/${convId}`)
    setSheetOpen(false)
  }

  function handleSelectProject(p: Project) {
    navigate(`/chat/project/${p.id}`)
    setSheetOpen(false)
  }

  async function handleConfirmDeleteConv() {
    if (!deleteConvTarget) return
    await deleteConversation(deleteConvTarget)
    if (deleteConvTarget === conversationId) navigate('/chat', { replace: true })
    setDeleteConvTarget(null)
  }

  async function handleConfirmDeleteProject() {
    if (!deleteProjectTarget) return
    const id = deleteProjectTarget.id
    await deleteProject(id)
    setDeleteProjectTarget(null)
    if (activeProjectId === id) navigate('/chat', { replace: true })
  }

  const sidebarContent = (
    <div className="flex h-full flex-col">
      {/* New chat */}
      <div className="shrink-0 px-3 pt-4 pb-2">
        <Button
          variant="ghost"
          onClick={handleNewChat}
          className="w-full justify-start gap-2.5 rounded-control px-3 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Plus className="size-4 shrink-0" />
          New chat
        </Button>
      </div>

      {/* Projects section */}
      <div className="shrink-0">
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <span className="text-overline text-muted-foreground/60">
            Projects
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setCreatingProject(true)}
            title="New project"
            aria-label="New project"
            className="size-6 rounded-control text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>

        <div className="px-2 space-y-0.5">
          {recentProjects.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              isActive={activeProjectId === p.id}
              onSelect={() => handleSelectProject(p)}
              onEdit={() => setEditingProject(p)}
              onDelete={() => setDeleteProjectTarget(p)}
            />
          ))}

          {projects.length === 0 && (
            <p className="px-2.5 py-2 text-sm text-muted-foreground/60">No projects yet</p>
          )}

          {projects.length > RECENT_PROJECTS && (
            <ViewAllRow label="View all projects" onClick={() => { navigate('/chat/projects'); setSheetOpen(false) }} />
          )}
        </div>
      </div>

      <div className="mx-3 my-3 border-t border-border/20" />

      {/* Chats section */}
      <div className="flex items-center justify-between px-3 pb-2">
        <span className="text-overline text-muted-foreground/60">
          Chats
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleNewChat}
          title="New chat"
          aria-label="New chat"
          className="size-6 rounded-control text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar px-2 space-y-0.5 pb-2">
        {recentConvs.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground/60">No conversations yet</p>
        ) : (
          recentConvs.map((conv) => (
            <ConversationRow
              key={conv.id}
              title={conv.title}
              isActive={conv.id === conversationId}
              onSelect={() => handleSelectConv(conv.id)}
              onDelete={() => setDeleteConvTarget(conv.id)}
            />
          ))
        )}

        {conversations.length > RECENT_CHATS && (
          <ViewAllRow label="View all chats" onClick={() => { navigate('/chat/chats'); setSheetOpen(false) }} />
        )}
      </div>
    </div>
  )

  return (
    <PageShell className="flex-1 min-h-0 overflow-hidden">
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Sidebar - desktop */}
        <div className="hidden md:flex w-64 shrink-0 flex-col border-r border-border/30 bg-sidebar">
          {sidebarContent}
        </div>

        {/* Sidebar - mobile sheet */}
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="left" className="w-72 p-0 flex flex-col">
            {sidebarContent}
          </SheetContent>
        </Sheet>

        {/* Main pane */}
        <div className="flex flex-1 min-h-0 flex-col">
          <div className="md:hidden shrink-0 flex items-center gap-2 border-b border-border/20 px-3 py-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setSheetOpen(true)}
              aria-label="Open chat sidebar"
              className="rounded-control text-muted-foreground hover:text-foreground"
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          </div>
          <Outlet />
        </div>

        {/* Modals */}
        <ProjectEditor
          open={creatingProject}
          project={null}
          onOpenChange={setCreatingProject}
          onCreated={(project) => navigate(`/chat/project/${project.id}`)}
        />
        <ProjectEditor
          open={editingProject !== null}
          project={editingProject}
          onOpenChange={(open) => { if (!open) setEditingProject(null) }}
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
          open={deleteProjectTarget !== null}
          onOpenChange={(open) => { if (!open) setDeleteProjectTarget(null) }}
          title={`Delete "${deleteProjectTarget?.name}"?`}
          description="All conversations in this project will move to All chats."
          confirmLabel="Delete"
          destructive
          onConfirm={handleConfirmDeleteProject}
        />
      </div>
    </PageShell>
  )
}

// ── View-all row ────────────────────────────────────────────────────────────

function ViewAllRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className="w-full justify-start gap-1 rounded-control px-2.5 font-normal text-muted-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      {label}
      <ChevronRight className="size-3" />
    </Button>
  )
}

// ── Project row ───────────────────────────────────────────────────────────────

function ProjectRow({
  project, isActive, onSelect, onEdit, onDelete,
}: {
  project: Project
  isActive: boolean
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const choice = getIconChoice(project.icon)
  const Icon = choice?.Icon ?? FolderIcon
  const color = resolveProjectColor(project.color)
  const tintStyle: React.CSSProperties = {
    backgroundColor: `color-mix(in oklch, ${color} 14%, transparent)`,
    color,
  }

  return (
    <div className={cn(
      'group/proj relative flex items-center rounded-control transition-colors',
      isActive ? 'bg-brand/10' : 'hover:bg-foreground/5',
    )}>
      {/* design-ok(hand-styled-button): headless row hotspot - row styling lives on the parent */}
      <button
        onClick={onSelect}
        className="flex flex-1 min-w-0 items-center gap-2 px-2 py-2 text-left"
      >
        <span
          className="flex size-5 shrink-0 items-center justify-center rounded-control"
          style={tintStyle}
        >
          <Icon className="size-3" />
        </span>
        <span className={cn(
          'truncate text-sm',
          isActive ? 'text-brand font-medium' : 'text-muted-foreground',
        )}>
          {project.name}
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => e.stopPropagation()}
            aria-label="Project options"
            className="relative mr-1 size-5 shrink-0 rounded-control text-muted-foreground/60 opacity-0 group-hover/proj:opacity-100 hover:bg-foreground/10 hover:text-foreground data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-36">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="size-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// ── Conversation row ──────────────────────────────────────────────────────────

function ConversationRow({
  title, isActive, onSelect, onDelete,
}: {
  title: string
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className={cn(
        'group relative flex items-center rounded-control transition-colors',
        isActive ? 'bg-brand/10' : 'hover:bg-foreground/5',
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* design-ok(hand-styled-button): headless row hotspot - row styling lives on the parent */}
      <button
        onClick={onSelect}
        className="flex flex-1 min-w-0 items-center gap-2 px-2.5 py-2 text-left"
      >
        <MessageSquare className={cn(
          'size-3.5 shrink-0',
          isActive ? 'text-brand/70' : 'text-muted-foreground/60',
        )} />
        <span className={cn(
          'truncate text-sm',
          isActive ? 'text-brand font-medium' : 'text-muted-foreground',
        )}>
          {title}
        </span>
      </button>

      {hovered && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          title="Delete conversation"
          aria-label="Delete conversation"
          className="absolute right-1.5 size-5 shrink-0 rounded-control text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-3" />
        </Button>
      )}
    </div>
  )
}
