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
} from '../../lib/api';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
import ChatListItem from './ChatListItem';
import ProjectListItem from './ProjectListItem';
import ProjectModal from './ProjectModal';
import ProfileMenu from './ProfileMenu';
import ConfirmDialog from '../ui/ConfirmDialog';

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
      'w-8 h-8 flex items-center justify-center rounded-md transition-colors shrink-0';
    return (
      <aside
        className="border-r border-sidebar-border bg-sidebar flex flex-col px-2 py-3 h-screen select-none shadow-m4 z-20 overflow-hidden transition-[width] duration-300 ease-in-out"
        style={{ width: '3rem' }}
      >
        <button
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          className={`group relative mb-4 text-primary hover:bg-card/50 ${slot}`}
        >
          <Ghost size={16} className="transition-opacity duration-150 group-hover:opacity-0" />
          <PanelLeftOpen size={16} className="absolute opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
        </button>
        <nav className="space-y-0.5 flex-1">
          <button
            onClick={() => handleNewSessionFallback()}
            title="New Chat"
            className={`${slot} ${
              isChat ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-primary'
            }`}
          >
            <PenLine size={16} />
          </button>
          <Link
            to="/people"
            title="People"
            className={`${slot} ${
              isPeople ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
            }`}
          >
            <Network size={16} />
          </Link>
          <Link
            to="/memory"
            title="Memory"
            className={`${slot} ${
              isMemory ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
            }`}
          >
            <Brain size={16} />
          </Link>
        </nav>
        <div className="pt-2 mt-1 border-t border-sidebar-border/40 -mx-2 px-2">
          <ProfileMenu compact />
        </div>
      </aside>
    );
  }

  // ---------------- Expanded ----------------
  return (
    <aside
      className="border-r border-sidebar-border bg-sidebar flex flex-col px-2 py-3 h-screen select-none shadow-m4 z-20 overflow-hidden transition-[width] duration-300 ease-in-out"
      style={{ width: '15rem' }}
    >
      {/* Branding + collapse toggle. Ghost icon sits in the same w-8 h-8 slot
          as every nav row so collapsing the rail leaves it visually pinned. */}
      <div className="flex items-center mb-4 group">
        <div className="w-8 h-8 flex items-center justify-center text-primary shrink-0">
          <Ghost size={16} />
        </div>
        <h2 className="flex-1 ml-1 text-sm font-bold tracking-tight text-sidebar-foreground">
          lokidoki
        </h2>
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
          className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:bg-card/50 hover:text-foreground transition-colors"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* Navigation. Each row is w-full but the icon stays in a fixed 32px slot
          flush to the left edge, matching the collapsed rail exactly. */}
      <nav className="space-y-0.5 mb-4">
        <button
          type="button"
          onClick={() => handleNewSessionFallback()}
          className={`w-full flex items-center rounded-md transition-colors text-xs font-medium ${
            isChat ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <span className="w-8 h-8 flex items-center justify-center shrink-0">
            <PenLine size={16} />
          </span>
          <span className="ml-1">New Chat</span>
        </button>
        <Link
          to="/people"
          className={`flex items-center rounded-md transition-colors text-xs font-medium ${
            isPeople ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <span className="w-8 h-8 flex items-center justify-center shrink-0">
            <Network size={16} />
          </span>
          <span className="ml-1">People</span>
        </Link>
        <Link
          to="/memory"
          className={`flex items-center rounded-md transition-colors text-xs font-medium ${
            isMemory ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <span className="w-8 h-8 flex items-center justify-center shrink-0">
            <Brain size={16} />
          </span>
          <span className="ml-1">Memory</span>
        </Link>
      </nav>

      {/* Main Content Area (Scrollable) */}
      <div className="flex-1 overflow-y-auto no-scrollbar space-y-4 pb-4">
        {/* Projects Section */}
        <Collapsible open={showProjects} onOpenChange={setShowProjects}>
          <div className="flex items-center justify-between px-2 mb-1">
            <CollapsibleTrigger className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider hover:text-foreground transition-all">
              Projects
            </CollapsibleTrigger>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditingProject(null);
                setIsProjectModalOpen(true);
              }}
              className="p-0.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-all"
            >
              <FolderPlus size={12} />
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
              <div className="text-[10px] text-muted-foreground/30 px-3 py-2 italic text-center">
                No projects.
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>

        {/* Chats Section */}
        <Collapsible open={showChats} onOpenChange={setShowChats}>
          <div className="flex items-center justify-between px-2 mb-1">
            <CollapsibleTrigger className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider hover:text-foreground transition-all">
              Recents
            </CollapsibleTrigger>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleNewSessionFallback();
              }}
              className="p-0.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-all"
            >
              <Plus size={12} />
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
              <div className="text-[10px] text-muted-foreground/30 px-3 py-2 italic text-center">
                No independent chats.
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* Profile (bottom-left) */}
      <div className="pt-2 mt-1 border-t border-sidebar-border/40">
        <ProfileMenu />
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
