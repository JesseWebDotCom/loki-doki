import { Bug, ChevronDown, Ellipsis, LogOut, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Pencil, Search, Settings, Shield, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type UserRecord = {
  username: string
  display_name: string
  is_admin?: boolean
}

type ChatSummary = {
  id: string
  title: string
}

type AppSidebarProps = {
  isMobileSidebarOpen: boolean
  isSidebarCollapsed: boolean
  bootstrapAppName: string
  filteredChats: ChatSummary[]
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
  onBeginRenamingChat: (chat: ChatSummary) => void
  onRenameChatSubmit: (chatId: string) => void
  onRenameChatTitleChange: (title: string) => void
  onRenameChatCancel: () => void
  onDeleteChat: (chat: ChatSummary) => void
  onToggleProfileMenu: () => void
  onSignOut: () => void
  onToggleDebugMode: () => void
}

export function AppSidebar({
  isMobileSidebarOpen,
  isSidebarCollapsed,
  bootstrapAppName,
  filteredChats,
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
  onBeginRenamingChat,
  onRenameChatSubmit,
  onRenameChatTitleChange,
  onRenameChatCancel,
  onDeleteChat,
  onToggleProfileMenu,
  onSignOut,
  onToggleDebugMode,
}: AppSidebarProps) {
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
        className={`app-sidebar absolute inset-y-0 left-0 z-30 flex w-[min(340px,88vw)] min-h-0 flex-col transition-transform md:relative md:z-20 md:w-auto md:translate-x-0 ${
          isMobileSidebarOpen ? "translate-x-0" : "-translate-x-full md:flex"
        }`}
      >
        <div className={`border-b border-[var(--line)] ${isSidebarCollapsed ? "px-2 py-3" : "px-4 py-3"}`}>
          <div className={`flex items-center ${isSidebarCollapsed ? "justify-center" : "justify-between"} gap-3`}>
            {!isSidebarCollapsed ? (
              <button className="flex min-w-0 items-center gap-3 text-left" onClick={onCreateChat} type="button">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.04]">
                  <img alt="LokiDoki logo" className="h-7 w-7" src="/lokidoki-logo.svg" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold text-[var(--foreground)]">{bootstrapAppName}</div>
                </div>
              </button>
            ) : null}
            <Button
              className="hidden h-9 w-9 border border-[var(--line)] bg-white/[0.03] text-[var(--foreground)] md:flex"
              onClick={onToggleSidebarCollapsed}
              size="icon"
              tooltip={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              type="button"
              variant="ghost"
            >
              {isSidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        <div className={`${isSidebarCollapsed ? "px-2 py-3" : "px-4 py-3"}`}>
          <Button
            className={`h-11 rounded-[18px] border border-[var(--line)] ${
              isSidebarCollapsed ? "w-11 p-0" : "w-full justify-start gap-2 px-4"
            } sidebar-hover-surface bg-[var(--input)] text-sm font-medium text-[var(--foreground)]`}
            onClick={onCreateChat}
            tooltip={isSidebarCollapsed ? "New chat" : undefined}
            type="button"
          >
            <MessageSquarePlus className="h-4 w-4" />
            {!isSidebarCollapsed ? "New chat" : null}
          </Button>
        </div>
        <div className={`${isSidebarCollapsed ? "px-2 pb-3" : "px-4 pb-3"}`}>
          {isSidebarCollapsed ? (
            <button
              aria-label="Search chats"
              className="flex w-full justify-center px-0 py-3 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
              onClick={() => {
                onSetActiveView("assistant")
                onCloseMobileSidebar()
              }}
              title="Search chats"
              type="button"
            >
              <Search className="h-4 w-4 shrink-0" />
            </button>
          ) : (
            <div className="space-y-3">
              <button
                className="sidebar-hover-ghost flex w-full items-center gap-3 rounded-[18px] px-3 py-3 text-left text-[var(--foreground)]"
                onClick={() => {
                  onSetActiveView("assistant")
                  onCloseMobileSidebar()
                }}
                type="button"
              >
                <Search className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
                <div className="text-sm font-medium">Search</div>
              </button>
            </div>
          )}
        </div>
        <div className={`min-h-0 flex-1 overflow-y-auto ${isSidebarCollapsed ? "px-2 pb-24" : "px-3 pb-36"}`}>
          {!isSidebarCollapsed ? (
            <>
              <div className="px-2 pb-2 pt-3 text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--muted-foreground)]">Recent chats</div>
              <div className="space-y-1.5">
                {filteredChats.map((chat) => {
                  const isActive = chat.id === activeChatId
                  const isMenuOpen = openChatMenuId === chat.id && chatMenuAnchor === "sidebar"
                  const isRenaming = renamingChatId === chat.id
                  return (
                    <div
                      key={chat.id}
                      className={`group relative rounded-[18px] px-3 py-2.5 text-left transition ${
                        isActive ? "bg-[color-mix(in_srgb,var(--accent)_12%,var(--input))] text-[var(--foreground)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]" : "text-[var(--muted-foreground)] hover:bg-[color-mix(in_srgb,var(--accent)_8%,var(--panel))] hover:text-[var(--foreground)]"
                      }`}
                    >
                      {isRenaming ? (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault()
                            onRenameChatSubmit(chat.id)
                          }}
                        >
                          <Input
                            autoFocus
                            className="h-9 rounded-xl border-[var(--line)] bg-black/20 pr-10 text-sm"
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
                        <button className="block min-w-0 max-w-full pr-9 text-left" onClick={() => onSelectChat(chat.id)} type="button">
                          <div className="truncate text-sm font-medium">{chat.title}</div>
                        </button>
                      )}
                      <button
                        className={`absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--panel-strong)]/95 text-[var(--muted-foreground)] transition hover:bg-[color-mix(in_srgb,var(--accent)_12%,var(--input))] hover:text-[var(--foreground)] ${
                          isActive || isMenuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                        }`}
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpenChatMenu(chat.id, "sidebar")
                        }}
                        title={`Chat actions for ${chat.title}`}
                        type="button"
                      >
                        <Ellipsis className="h-4 w-4" />
                      </button>
                      {isMenuOpen ? (
                        <div
                          className="absolute right-2 top-[calc(100%+6px)] z-40 w-48 rounded-[22px] border border-[var(--line)] bg-[var(--panel-strong)]/98 p-2 shadow-[0_18px_40px_rgba(0,0,0,0.45)]"
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <button className="sidebar-menu-item sidebar-hover-ghost flex w-full items-center gap-3 rounded-xl px-3 py-2 text-[var(--foreground)]" onClick={() => onBeginRenamingChat(chat)} style={{ fontSize: "var(--ui-sidebar-menu-size)" }} type="button">
                            <Pencil className="h-4 w-4 text-[var(--muted-foreground)]" />
                            Rename chat
                          </button>
                          <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-rose-300 hover:bg-rose-500/10" onClick={() => onDeleteChat(chat)} type="button">
                            <Trash2 className="h-4 w-4 text-rose-300" />
                            Delete chat
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
                {filteredChats.length === 0 ? <div className="px-3 py-2 text-sm text-[var(--muted-foreground)]">No chats match that search.</div> : null}
              </div>
            </>
          ) : (
            <div />
          )}
        </div>
        <div className={`absolute bottom-0 left-0 right-0 border-t border-[var(--line)] bg-[var(--panel-strong)]/95 ${isSidebarCollapsed ? "flex justify-center p-2" : "p-4"}`}>
          <div className="relative z-40 w-full" onPointerDown={(event) => event.stopPropagation()}>
            <button
              className={`flex items-center gap-3 rounded-[18px] border border-[var(--line)] bg-[var(--input)] text-left ${isSidebarCollapsed ? "h-10 w-10 justify-center p-0" : "w-full px-3 py-3"}`}
              onClick={onToggleProfileMenu}
              type="button"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-sm font-medium text-[var(--accent-foreground)]">
                {(user?.display_name || "G").slice(0, 1)}
              </div>
              {!isSidebarCollapsed ? (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="sidebar-profile-name truncate text-[var(--foreground)]">{user?.display_name || "Guest"}</div>
                    <div className="sidebar-profile-meta truncate text-[var(--muted-foreground)]">@{user?.username || "not-signed-in"}</div>
                  </div>
                  <ChevronDown className="sidebar-menu-icon text-[var(--muted-foreground)]" style={{ width: "var(--ui-sidebar-icon-size)", height: "var(--ui-sidebar-icon-size)" }} />
                </>
              ) : null}
            </button>
            {isProfileMenuOpen ? (
              <div className={`sidebar-menu-shell quick-switcher-shell absolute bottom-[calc(100%+10px)] z-50 rounded-[24px] p-2 ${isSidebarCollapsed ? "left-0 w-56" : "left-0 right-0"}`}>
                <button className="sidebar-menu-item quick-switcher-item flex w-full items-center gap-3 rounded-xl px-3 py-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={() => onSetActiveView("settings")} style={{ fontSize: "var(--ui-sidebar-menu-size)" }} type="button">
                  <Settings className="sidebar-menu-icon text-[var(--muted-foreground)]" style={{ width: "var(--ui-sidebar-icon-size)", height: "var(--ui-sidebar-icon-size)" }} />
                  Settings
                </button>
                {user?.is_admin ? (
                  <button className="sidebar-menu-item quick-switcher-item flex w-full items-center gap-3 rounded-xl px-3 py-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={() => onSetActiveView("admin")} style={{ fontSize: "var(--ui-sidebar-menu-size)" }} type="button">
                    <Shield className="sidebar-menu-icon text-[var(--muted-foreground)]" style={{ width: "var(--ui-sidebar-icon-size)", height: "var(--ui-sidebar-icon-size)" }} />
                    Administration
                  </button>
                ) : null}
                {user?.is_admin ? (
                  <button className="sidebar-menu-item quick-switcher-item flex w-full items-center gap-3 rounded-xl px-3 py-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={onToggleDebugMode} style={{ fontSize: "var(--ui-sidebar-menu-size)" }} type="button">
                    <Bug className="sidebar-menu-icon text-[var(--muted-foreground)]" style={{ width: "var(--ui-sidebar-icon-size)", height: "var(--ui-sidebar-icon-size)" }} />
                    Debug mode: {debugMode ? "On" : "Off"}
                  </button>
                ) : null}
                <button className="sidebar-menu-item quick-switcher-item flex w-full items-center gap-3 rounded-xl px-3 py-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={onSignOut} style={{ fontSize: "var(--ui-sidebar-menu-size)" }} type="button">
                  <LogOut className="sidebar-menu-icon text-[var(--muted-foreground)]" style={{ width: "var(--ui-sidebar-icon-size)", height: "var(--ui-sidebar-icon-size)" }} />
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </aside>
    </>
  )
}
