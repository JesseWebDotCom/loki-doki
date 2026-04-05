import { useEffect, useState } from "react"
import { Bug, ChevronDown, ChevronRight, Ellipsis, Folder, FolderPlus, LayoutGrid, LogOut, MessageSquarePlus, PanelLeftClose, Pencil, Search, Settings, Shield, Trash2, icons } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type UserRecord = {
  id?: string
  username: string
  display_name: string
  is_admin?: boolean
}

type ChatSummary = {
  id: string
  title: string
  project_id: string | null
  created_at: string
  updated_at: string
  last_message_at: string | null
  message_count: number
}

export type ProjectSummary = {
  id: string
  name: string
  icon?: string
  icon_color?: string
}

type AppSidebarProps = {
  isMobileSidebarOpen: boolean
  isSidebarCollapsed: boolean
  bootstrapAppName: string
  filteredChats: ChatSummary[]
  projects?: ProjectSummary[]
  activeProjectId?: string
  activeChatId: string
  openChatMenuId: string
  chatMenuAnchor: "header" | "sidebar"
  renamingChatId: string
  renameChatTitle: string
  user: UserRecord | null
  isProfileMenuOpen: boolean
  debugMode: boolean
  onOpenMobileSidebar: () => void
  onCloseMobileSidebar: () => void
  onToggleSidebarCollapsed: () => void
  onCreateChat: () => void
  onSetActiveView: (view: "assistant" | "settings" | "admin") => void
  onSelectChat: (chatId: string) => void
  onOpenChatMenu: (chatId: string, anchor: "header" | "sidebar") => void
  onSelectProject?: (projectId: string) => void
  onCreateProject?: () => void
  onBeginRenamingChat: (chat: ChatSummary) => void
  onRenameChatSubmit: (chatId: string) => void
  onRenameChatTitleChange: (title: string) => void
  onRenameChatCancel: () => void
  onDeleteChat: (chat: ChatSummary) => void
  onMoveChatToProject?: (chat: ChatSummary) => void
  onToggleProfileMenu: () => void
  onSignOut: () => void
  onToggleDebugMode: () => void
}

export function AppSidebar({
  isMobileSidebarOpen,
  isSidebarCollapsed,
  bootstrapAppName,
  filteredChats,
  projects = [],
  activeProjectId,
  activeChatId,
  openChatMenuId,
  chatMenuAnchor,
  renamingChatId,
  renameChatTitle,
  user,
  isProfileMenuOpen,
  debugMode,
  onCloseMobileSidebar,
  onToggleSidebarCollapsed,
  onCreateChat,
  onSetActiveView,
  onSelectChat,
  onOpenChatMenu,
  onSelectProject,
  onCreateProject,
  onBeginRenamingChat,
  onRenameChatSubmit,
  onRenameChatTitleChange,
  onRenameChatCancel,
  onDeleteChat,
  onMoveChatToProject,
  onToggleProfileMenu,
  onSignOut,
  onToggleDebugMode,
}: AppSidebarProps) {
  const projectsKey = user?.id ? `ld_projects_collapsed_${user.id}` : "ld_projects_collapsed"
  const chatsKey = user?.id ? `ld_chats_collapsed_${user.id}` : "ld_chats_collapsed"

  const [isProjectsCollapsed, setIsProjectsCollapsed] = useState(() => localStorage.getItem(projectsKey) === "1")
  const [isChatsCollapsed, setIsChatsCollapsed] = useState(() => localStorage.getItem(chatsKey) === "1")

  useEffect(() => {
    localStorage.setItem(projectsKey, isProjectsCollapsed ? "1" : "0")
  }, [isProjectsCollapsed, projectsKey])

  useEffect(() => {
    localStorage.setItem(chatsKey, isChatsCollapsed ? "1" : "0")
  }, [isChatsCollapsed, chatsKey])

  return (
    <>
      {isMobileSidebarOpen ? (
        <button
          aria-label="Close navigation"
          className="absolute inset-0 z-20 bg-black/45 md:hidden"
          onClick={onCloseMobileSidebar}
          type="button"
        />
      ) : null}
      <aside
        className={`app-sidebar absolute inset-y-0 left-0 z-30 flex w-[260px] min-h-0 flex-col border-r border-[#1a1a1a] bg-[#090909] transition-transform md:relative md:z-20 md:translate-x-0 ${
          isMobileSidebarOpen ? "translate-x-0" : "-translate-x-full md:flex"
        } ${isSidebarCollapsed ? "md:w-[70px]" : "md:w-[260px]"}`}
      >
        {/* Branding */}
        <div className={cn(
          "flex h-16 items-center p-2 transition-all",
          isSidebarCollapsed ? "px-2" : "px-4"
        )}>
          <div className="flex w-full items-center justify-between">
            <div 
              className={cn(
                "flex items-center gap-2.5 cursor-pointer transition-opacity hover:opacity-80 active:scale-95",
                isSidebarCollapsed && "w-full justify-center"
              )}
              onClick={onToggleSidebarCollapsed}
            >
              <img 
                alt="LokiDoki logo" 
                className="h-[24px] w-[24px]" 
                src="/lokidoki-logo.svg" 
              />
              {!isSidebarCollapsed && (
                <span className="text-lg font-bold tracking-tight text-[#ececec]">
                  {bootstrapAppName.toLowerCase() === "lokidoki" ? "lokidoki" : bootstrapAppName}
                </span>
              )}
            </div>
            {!isSidebarCollapsed && (
              <Button
                className="h-8 w-8 text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec]"
                onClick={onToggleSidebarCollapsed}
                size="icon"
                variant="ghost"
              >
                <PanelLeftClose className="h-[18px] w-[18px]" />
              </Button>
            )}
          </div>
        </div>

        {/* Action Menu */}
        <div className="space-y-0.5 px-2 pb-4">
          <button
            className={cn(
              "flex h-10 w-full items-center gap-3 rounded-lg px-3 text-[#8e8e8e] transition hover:bg-white/[0.05] hover:text-[#ececec]",
              isSidebarCollapsed && "justify-center px-0"
            )}
            onClick={onCreateChat}
            type="button"
            title="New Session"
          >
            <MessageSquarePlus className="h-[18px] w-[18px]" />
            {!isSidebarCollapsed && <span className="text-[13px] font-medium">New Session</span>}
          </button>
          <button
            className={cn(
              "flex h-10 w-full items-center gap-3 rounded-lg px-3 text-[#8e8e8e] transition hover:bg-white/[0.05] hover:text-[#ececec]",
              isSidebarCollapsed && "justify-center px-0"
            )}
            onClick={() => onSetActiveView("assistant")}
            type="button"
            title="Search Chats"
          >
            <Search className="h-[18px] w-[18px]" />
            {!isSidebarCollapsed && <span className="text-[13px] font-medium">Search Chats</span>}
          </button>
          <button
            className={cn(
              "flex h-10 w-full items-center gap-3 rounded-lg px-3 text-[#8e8e8e] transition hover:bg-white/[0.05] hover:text-[#ececec]",
              isSidebarCollapsed && "justify-center px-0"
            )}
            onClick={() => {}} // Placeholder for Craft
            type="button"
            title="Craft"
          >
            <LayoutGrid className="h-[18px] w-[18px]" />
            {!isSidebarCollapsed && <span className="text-[13px] font-medium">Craft</span>}
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          {!isSidebarCollapsed && (
            <>
              {/* Projects */}
              <div className="mt-4 px-3">
                <div 
                  className="flex cursor-pointer items-center justify-between py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#8e8e8e]/50"
                  onClick={() => setIsProjectsCollapsed(!isProjectsCollapsed)}
                >
                  <span>Projects</span>
                  {isProjectsCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </div>
                {!isProjectsCollapsed && (
                  <div className="mt-1 space-y-0.5">
                    <button
                      className="flex h-9 w-full items-center gap-3 rounded-lg px-2 text-[#8e8e8e] transition hover:bg-white/[0.04] hover:text-[#ececec]"
                      onClick={onCreateProject}
                      type="button"
                    >
                      <FolderPlus className="h-4 w-4 opacity-70" />
                      <span className="text-[13px] font-medium">New Project</span>
                    </button>
                    {projects.map((project) => {
                      const isActive = project.id === activeProjectId
                      const IconComponent = (icons as any)[project.icon || "Folder"] || Folder
                      return (
                        <button
                          key={project.id}
                          className={`flex h-9 w-full items-center gap-3 rounded-lg px-2 text-[13px] font-medium transition ${
                            isActive ? "bg-[#1a1a1a] text-[#ececec]" : "text-[#8e8e8e] hover:bg-white/[0.04] hover:text-[#ececec]"
                          }`}
                          onClick={() => onSelectProject?.(project.id)}
                          type="button"
                        >
                          <IconComponent className="h-4 w-4 opacity-70" style={{ color: project.icon_color }} />
                          <span className="truncate">{project.name}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Recents */}
              <div className="mt-6 px-3">
                <div 
                  className="flex cursor-pointer items-center justify-between py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#8e8e8e]/50"
                  onClick={() => setIsChatsCollapsed(!isChatsCollapsed)}
                >
                  <span>Recently</span>
                  {isChatsCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </div>
                {!isChatsCollapsed && (
                  <div className="mt-1 space-y-0.5">
                    {filteredChats.map((chat) => {
                      const isActive = chat.id === activeChatId
                      const isMenuOpen = openChatMenuId === chat.id && chatMenuAnchor === "sidebar"
                      const isRenaming = renamingChatId === chat.id
                      return (
                        <div
                          key={chat.id}
                          className={`group relative flex h-9 w-full items-center rounded-lg px-2 text-[13px] font-medium transition ${
                            isActive ? "bg-[#1a1a1a] text-[#ececec]" : "text-[#8e8e8e] hover:bg-white/[0.04] hover:text-[#ececec]"
                          }`}
                        >
                          {isRenaming ? (
                            <form
                              className="flex-1"
                              onSubmit={(event) => {
                                event.preventDefault()
                                onRenameChatSubmit(chat.id)
                              }}
                            >
                              <Input
                                autoFocus
                                className="h-7 border-0 bg-transparent p-0 text-[13px] focus-visible:ring-0"
                                value={renameChatTitle}
                                onBlur={() => onRenameChatSubmit(chat.id)}
                                onChange={(event) => onRenameChatTitleChange(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") {
                                    onRenameChatCancel()
                                  }
                                }}
                              />
                            </form>
                          ) : (
                            <button className="flex-1 truncate pr-6 text-left" onClick={() => onSelectChat(chat.id)}>
                              {chat.title}
                            </button>
                          )}
                          <button
                            className={`absolute right-1 flex h-6 w-6 items-center justify-center rounded-md text-[#8e8e8e] hover:bg-white/10 hover:text-[#ececec] ${
                              isActive || isMenuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                            }`}
                            onClick={(event) => {
                              event.stopPropagation()
                              onOpenChatMenu(chat.id, "sidebar")
                            }}
                          >
                            <Ellipsis className="h-3.5 w-3.5" />
                          </button>
                          {isMenuOpen && (
                            <div
                              className="absolute left-[calc(100%+8px)] top-0 z-50 w-48 rounded-xl border border-[#1a1a1a] bg-[#161616] p-1.5 shadow-2xl"
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec]" onClick={() => onBeginRenamingChat(chat)}>
                                <Pencil className="h-3.5 w-3.5" />
                                Rename
                              </button>
                              {onMoveChatToProject && (
                                <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec]" onClick={() => onMoveChatToProject(chat)}>
                                  <Folder className="h-3.5 w-3.5" />
                                  Move
                                </button>
                              )}
                              <div className="my-1 h-px bg-[#1a1a1a]" />
                              <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-rose-400 hover:bg-rose-500/10" onClick={() => onDeleteChat(chat)}>
                                <Trash2 className="h-3.5 w-3.5" />
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Bottom Profile */}
        <div className="mt-auto p-2">
          <div className="relative">
            <button
              className={`flex h-12 w-full items-center gap-3 rounded-lg px-3 transition hover:bg-white/[0.05] ${
                isSidebarCollapsed ? "justify-center px-0" : ""
              }`}
              onClick={onToggleProfileMenu}
              type="button"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#333] text-[10px] font-bold text-white">
                {(user?.display_name || "G").slice(0, 1).toUpperCase()}
              </div>
              {!isSidebarCollapsed && (
                <span className="truncate text-[13px] font-medium text-[#ececec]">{user?.display_name || "Guest"}</span>
              )}
            </button>
            {isProfileMenuOpen && (
              <div className={`absolute bottom-[calc(100%+8px)] z-50 rounded-xl border border-[#1a1a1a] bg-[#161616] p-1.5 shadow-2xl ${
                isSidebarCollapsed ? "left-0 w-56" : "left-0 right-0"
              }`}>
                <button className="flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[13px] text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec]" onClick={() => onSetActiveView("settings")}>
                  <Settings className="h-4 w-4" />
                  Settings
                </button>
                {user?.is_admin && (
                  <>
                    <button className="flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[13px] text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec]" onClick={() => onSetActiveView("admin")}>
                      <Shield className="h-4 w-4" />
                      Administration
                    </button>
                    <button className="flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[13px] text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec]" onClick={onToggleDebugMode}>
                      <Bug className="h-4 w-4" />
                      Debug mode: {debugMode ? "On" : "Off"}
                    </button>
                  </>
                )}
                <div className="my-1.5 h-px bg-[#1a1a1a]" />
                <button className="flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[13px] text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec]" onClick={onSignOut}>
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}

