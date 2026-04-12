import React, { useState, useEffect } from 'react';
import {
  Ghost,
  Brain,
  Network,
  Plus,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Wifi,
  WifiOff,
  Bot,
  HardDrive,
  MemoryStick,
  MessageSquare,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  getSessions,
  deleteSession,
  getProjects,
  createProject,
  updateProject,
  deleteProject,
  updateSession,
  getSystemInfo,
} from '../../lib/api';
import type { SystemInfo } from '../../lib/api-types';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import ChatListItem from './ChatListItem';
import ProjectListItem from './ProjectListItem';
import ProjectModal from './ProjectModal';
import ProfileMenu from './ProfileMenu';
import ConfirmDialog from '../ui/ConfirmDialog';

// ── Status indicators ────────────────────────────────────────
// Tiny colored icons that reflect system health at a glance.

const useSystemStatus = () => {
  const [status, setStatus] = useState<SystemInfo | null>(null);
  useEffect(() => {
    const poll = () => { void getSystemInfo().then(setStatus).catch(() => {}); };
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);
  return status;
};

const healthColor = (pct: number) =>
  pct >= 95 ? 'text-red-400' : pct >= 85 ? 'text-amber-400' : 'text-emerald-400';

const StatusIcons: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const s = useSystemStatus();
  if (!s) return null;
  const items = [
    {
      icon: s.internet_ok ? Wifi : WifiOff,
      color: s.internet_ok ? 'text-emerald-400' : 'text-red-400',
      title: s.internet_ok ? 'Internet connected' : 'No internet',
    },
    {
      icon: Bot,
      color: s.ollama_ok ? 'text-emerald-400' : 'text-red-400',
      title: s.ollama_ok ? `Ollama ${s.ollama_version}` : 'Ollama offline',
    },
    {
      icon: MemoryStick,
      color: healthColor(s.system.memory.used_percent),
      title: `RAM ${s.system.memory.used_percent.toFixed(0)}%`,
    },
    {
      icon: HardDrive,
      color: healthColor(s.system.disk.used_percent),
      title: `Disk ${s.system.disk.used_percent.toFixed(0)}%`,
    },
  ];

  const summaryTone = items.some((item) => item.color === 'text-red-400')
    ? 'bg-red-400'
    : items.some((item) => item.color === 'text-amber-400')
      ? 'bg-amber-400'
      : 'bg-emerald-400';

  if (compact) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-card/50 hover:text-foreground cursor-default"
              aria-label="System status"
            >
              <span className={`block h-2.5 w-2.5 rounded-full ${summaryTone}`} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={10} className="w-52 rounded-xl px-3 py-3">
            <div className="space-y-2">
              {items.map((it) => {
                const Icon = it.icon;
                return (
                  <div key={it.title} className="flex items-center gap-2 text-xs text-background/90">
                    <Icon size={14} className={it.color} />
                    <span>{it.title}</span>
                  </div>
                );
              })}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <div className="flex items-center gap-3 px-2">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <span key={it.title} title={it.title}>
            <Icon size={14} className={`${it.color} transition-colors`} />
          </span>
        );
      })}
    </div>
  );
};

interface SidebarProps {
  // Kept for backwards compat with callers (ChatPage still passes pipeline state).
  // The visualizer block has been removed; props are intentionally unused.
  phase?: string;
  pipeline?: unknown;
  onNewSession?: (projectId?: number) => void;
  onSelectSession?: (sessionId: string) => void;
  currentSessionId?: string;
  activeProjectId?: number | null;
  onSelectProject?: (projectId: number | null) => void;
  projectsVersion?: number;
  onProjectsChanged?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  onNewSession,
  onSelectSession,
  currentSessionId,
  activeProjectId: activeProjectIdProp,
  onSelectProject,
  projectsVersion = 0,
  onProjectsChanged,
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const isChat = location.pathname === '/';
  const isMemory = location.pathname === '/memory';
  const isPeople = location.pathname === '/people';
  const isFeedback = location.pathname === '/feedback';

  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('ld-sidebar-collapsed') === 'true',
  );
  useEffect(() => {
    localStorage.setItem('ld-sidebar-collapsed', String(collapsed));
  }, [collapsed]);

  const handleSelectSession = (id: string) => {
    if (onSelectSession) {
      onSelectSession(id);
    } else {
      navigate('/', { state: { selectSessionId: id } });
    }
  };

  const handleNewSessionFallback = (projectId?: number) => {
    if (onNewSession) {
      onNewSession(projectId);
    } else {
      navigate('/', { state: { newSession: true, projectId: projectId ?? null } });
    }
  };

  const [sessions, setSessions] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);

  const [showChats, setShowChats] = useState(
    () => localStorage.getItem('ld-show-chats') !== 'false',
  );
  const [showProjects, setShowProjects] = useState(
    () => localStorage.getItem('ld-show-projects') !== 'false',
  );

  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<any>(null);
  const [projectPendingDelete, setProjectPendingDelete] = useState<any>(null);

  useEffect(() => {
    localStorage.setItem('ld-show-chats', String(showChats));
  }, [showChats]);

  useEffect(() => {
    localStorage.setItem('ld-show-projects', String(showProjects));
  }, [showProjects]);

  useEffect(() => {
    loadData();
  }, [isChat, projectsVersion]);

  const loadData = async () => {
    try {
      const [sRes, pRes] = await Promise.all([getSessions(), getProjects()]);
      setSessions(sRes.details || []);
      setProjects(pRes.projects || []);
    } catch {
      // API not available
    }
  };

  const handleCreateProject = async (data: any) => {
    if (editingProject) {
      await updateProject(editingProject.id, data);
    } else {
      await createProject(data);
    }
    setEditingProject(null);
    loadData();
    onProjectsChanged?.();
  };

  const handleDeleteProject = (id: number) => {
    const project = projects.find((p) => p.id === id) ?? { id, name: `Project ${id}` };
    setProjectPendingDelete(project);
  };

  const confirmDeleteProject = async () => {
    if (!projectPendingDelete) return;
    const id = projectPendingDelete.id;
    setProjectPendingDelete(null);
    await deleteProject(id);
    loadData();
    onProjectsChanged?.();
  };

  const handleRenameChat = async (id: string, title: string) => {
    await updateSession(id, { title });
    loadData();
  };

  const handleDeleteChat = async (id: string) => {
    await deleteSession(id);
    loadData();
  };

  const handleMoveChat = async (id: string, projectId: number | null) => {
    await updateSession(id, { project_id: projectId ?? 0 });
    loadData();
  };

  const [localActiveProjectId, setLocalActiveProjectId] = useState<number | null>(null);
  const activeProjectId = activeProjectIdProp ?? localActiveProjectId;
  const setActiveProjectId = (id: number | null) => {
    if (onSelectProject) onSelectProject(id);
    else setLocalActiveProjectId(id);
  };

  const globalSessions = sessions.filter((s) => !s.project_id);

  // ---------------- Collapsed (icon-only rail) ----------------
  if (collapsed) {
    const slot =
      'flex h-10 w-10 items-center justify-center rounded-xl transition-colors';
    return (
      <aside
        className="border-r border-sidebar-border bg-sidebar flex h-screen flex-col items-center px-1.5 py-3 select-none shadow-m4 z-20 overflow-hidden transition-[width] duration-300 ease-in-out"
        style={{ width: '3.5rem' }}
      >
        <button
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          className={`group relative mb-4 text-primary hover:bg-card/50 cursor-pointer ${slot}`}
        >
          <Ghost size={16} className="transition-opacity duration-150 group-hover:opacity-0" />
          <PanelLeftOpen size={16} className="absolute opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
        </button>
        <nav className="flex flex-1 flex-col items-center gap-2">
          <button
            onClick={() => handleNewSessionFallback()}
            title="New Chat"
            className={`${slot} cursor-pointer ${
              isChat ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-primary'
            }`}
          >
            <PenLine size={16} />
          </button>
          <Link
            to="/people"
            title="People"
            className={`${slot} cursor-pointer ${
              isPeople ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
            }`}
          >
            <Network size={16} />
          </Link>
          <Link
            to="/memory"
            title="Memory"
            className={`${slot} cursor-pointer ${
              isMemory ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
            }`}
          >
            <Brain size={16} />
          </Link>
          <Link
            to="/feedback"
            title="Feedback"
            className={`${slot} cursor-pointer ${
              isFeedback ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
            }`}
          >
            <MessageSquare size={16} />
          </Link>
        </nav>
        <div className="mt-2 flex w-full flex-col items-center gap-2 border-t border-sidebar-border/40 pt-2">
          <ProfileMenu compact />
          <StatusIcons compact />
        </div>
      </aside>
    );
  }

  // ---------------- Expanded ----------------
  return (
    <aside
      className="border-r border-sidebar-border bg-sidebar flex flex-col px-2 py-3 h-screen select-none shadow-m4 z-20 overflow-hidden transition-[width] duration-300 ease-in-out"
      style={{ width: '17rem' }}
    >
      {/* Branding + collapse toggle. Ghost icon sits in the same w-8 h-8 slot
          as every nav row so collapsing the rail leaves it visually pinned. */}
      <div className="mb-5 flex items-center group">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center text-primary">
          <Ghost size={18} />
        </div>
        <h2 className="ml-1 flex-1 text-base font-bold tracking-tight text-sidebar-foreground">
          lokidoki
        </h2>
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
          className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-card/50 hover:text-foreground cursor-pointer"
        >
          <PanelLeftClose size={18} />
        </button>
      </div>

      {/* Navigation. Each row is w-full but the icon stays in a fixed 32px slot
          flush to the left edge, matching the collapsed rail exactly. */}
      <nav className="mb-5 space-y-1">
        <button
          type="button"
          onClick={() => handleNewSessionFallback()}
          className={`flex w-full items-center rounded-xl transition-colors text-sm font-medium cursor-pointer ${
            isChat ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <span className="flex h-10 w-10 items-center justify-center shrink-0">
            <PenLine size={18} />
          </span>
          <span className="ml-1">New Chat</span>
        </button>
        <Link
          to="/people"
          className={`flex items-center rounded-xl transition-colors text-sm font-medium cursor-pointer ${
            isPeople ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <span className="flex h-10 w-10 items-center justify-center shrink-0">
            <Network size={18} />
          </span>
          <span className="ml-1">People</span>
        </Link>
        <Link
          to="/memory"
          className={`flex items-center rounded-xl transition-colors text-sm font-medium cursor-pointer ${
            isMemory ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <span className="flex h-10 w-10 items-center justify-center shrink-0">
            <Brain size={18} />
          </span>
          <span className="ml-1">Memory</span>
        </Link>
        <Link
          to="/feedback"
          className={`flex items-center rounded-xl transition-colors text-sm font-medium cursor-pointer ${
            isFeedback ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <span className="flex h-10 w-10 items-center justify-center shrink-0">
            <MessageSquare size={18} />
          </span>
          <span className="ml-1">Feedback</span>
        </Link>
      </nav>

      {/* Main Content Area (Scrollable) */}
      <div className="flex-1 overflow-y-auto no-scrollbar space-y-4 pb-4">
        {/* Projects Section */}
        <Collapsible open={showProjects} onOpenChange={setShowProjects}>
          <div className="mb-2 flex items-center justify-between px-2">
            <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground/70 transition-all hover:text-foreground cursor-pointer">
              Projects
            </CollapsibleTrigger>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditingProject(null);
                setIsProjectModalOpen(true);
              }}
              className="p-0.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-all cursor-pointer"
            >
              <FolderPlus size={14} />
            </button>
          </div>
          <CollapsibleContent className="space-y-1 px-1">
            {projects.map((project) => {
              const projectChats = sessions.filter((s) => s.project_id === project.id);
              const isExpanded = activeProjectId === project.id;

              return (
                <div key={project.id} className="space-y-1">
                  <ProjectListItem
                    project={project}
                    isActive={isExpanded}
                    onSelect={(id) =>
                      setActiveProjectId(id === activeProjectId ? null : id)
                    }
                    onEdit={(p) => {
                      setEditingProject(p);
                      setIsProjectModalOpen(true);
                    }}
                    onDelete={handleDeleteProject}
                  />
                  {isExpanded && (
                    <div className="ml-4 pl-2 border-l border-border/20 space-y-1 mt-1">
                      {projectChats.map((session) => (
                        <ChatListItem
                          key={session.id}
                          id={String(session.id)}
                          title={session.title}
                          isActive={currentSessionId === String(session.id)}
                          onSelect={handleSelectSession}
                          onDelete={handleDeleteChat}
                          onRename={handleRenameChat}
                          onMove={handleMoveChat}
                          projects={projects}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {projects.length === 0 && (
              <div className="px-3 py-2 text-xs italic text-center text-muted-foreground/30">
                No projects.
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>

        {/* Chats Section */}
        <Collapsible open={showChats} onOpenChange={setShowChats}>
          <div className="mb-2 flex items-center justify-between px-2">
            <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground/70 transition-all hover:text-foreground cursor-pointer">
              Recents
            </CollapsibleTrigger>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleNewSessionFallback();
              }}
              className="p-0.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-all cursor-pointer"
            >
              <Plus size={14} />
            </button>
          </div>
          <CollapsibleContent className="space-y-1 px-2">
            {globalSessions.map((session) => (
              <ChatListItem
                key={session.id}
                id={String(session.id)}
                title={session.title}
                isActive={currentSessionId === String(session.id)}
                onSelect={handleSelectSession}
                onDelete={handleDeleteChat}
                onRename={handleRenameChat}
                onMove={handleMoveChat}
                projects={projects}
              />
            ))}
            {globalSessions.length === 0 && (
              <div className="px-3 py-2 text-xs italic text-center text-muted-foreground/30">
                No independent chats.
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* Profile + Status (bottom-left) */}
      <div className="pt-2 pb-1 mt-1 border-t border-sidebar-border/40">
        <ProfileMenu />
        <div className="mt-1 px-2">
          <StatusIcons />
        </div>
      </div>

      <ProjectModal
        isOpen={isProjectModalOpen}
        onClose={() => setIsProjectModalOpen(false)}
        onSubmit={handleCreateProject}
        initialData={editingProject}
        title={editingProject ? 'Edit Project' : 'New Project'}
      />

      <ConfirmDialog
        open={!!projectPendingDelete}
        title="Delete project?"
        description={
          projectPendingDelete
            ? `"${projectPendingDelete.name}" will be deleted. Chats inside will be moved out, not deleted.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDeleteProject}
        onCancel={() => setProjectPendingDelete(null)}
      />
    </aside>
  );
};

export default Sidebar;
