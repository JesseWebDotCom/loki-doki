import React, { useState, useEffect } from 'react';
import { Ghost, MessageSquare, Brain, Plus, FolderPlus, ChevronDown, ChevronRight } from 'lucide-react';
import ExecutionTimeline from './ExecutionTimeline';
import StatusMetrics from './StatusMetrics';
import DecompositionPanel from './DecompositionPanel';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { 
  getSessions, 
  deleteSession, 
  getProjects, 
  createProject, 
  updateProject, 
  deleteProject,
  updateSession 
} from '../../lib/api';
import type { PipelineState } from '../../pages/ChatPage';
import { 
  Collapsible, 
  CollapsibleContent, 
  CollapsibleTrigger 
} from '../ui/collapsible';
import ChatListItem from './ChatListItem';
import ProjectListItem from './ProjectListItem';
import ProjectModal from './ProjectModal';
import ProfileMenu from './ProfileMenu';
import ConfirmDialog from '../ui/ConfirmDialog';

interface SidebarProps {
  phase: PipelineState['phase'];
  pipeline?: PipelineState;
  onNewSession?: (projectId?: number) => void;
  onSelectSession?: (sessionId: string) => void;
  currentSessionId?: string;
  activeProjectId?: number | null;
  onSelectProject?: (projectId: number | null) => void;
  projectsVersion?: number;
  onProjectsChanged?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  phase,
  pipeline,
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

  // Sidebar is reused on Settings/Admin/Memory/Dev pages, where the
  // host doesn't pass onSelectSession (only ChatPage does). Without
  // a fallback, clicking a chat row on those pages was a no-op until
  // the user manually navigated back to /. Route through the chat
  // page with router state so ChatPage can pick the session up on
  // mount and load it.
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
  
  const [showChats, setShowChats] = useState(() => localStorage.getItem('ld-show-chats') !== 'false');
  const [showProjects, setShowProjects] = useState(() => localStorage.getItem('ld-show-projects') !== 'false');
  
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
      // sRes.details contains the full session objects from the backend
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
    // Backend convention: project_id=0 means "remove from project"
    await updateSession(id, { project_id: projectId ?? 0 });
    loadData();
  };

  // Either driven by parent (ChatPage lifts it for the landing view) or
  // managed locally (e.g. on the Memory page where Sidebar is reused).
  const [localActiveProjectId, setLocalActiveProjectId] = useState<number | null>(null);
  const activeProjectId = activeProjectIdProp ?? localActiveProjectId;
  const setActiveProjectId = (id: number | null) => {
    if (onSelectProject) onSelectProject(id);
    else setLocalActiveProjectId(id);
  };

  // Global chats are those without a project_id
  const globalSessions = sessions.filter(s => !s.project_id);

  const phases = [
    { id: 'augmentation', label: 'Augmentation', status: getStatus('augmentation', phase) },
    { id: 'decomposition', label: 'Decomposition', status: getStatus('decomposition', phase) },
    { id: 'routing', label: 'Skill Routing', status: getStatus('routing', phase) },
    { id: 'synthesis', label: 'Synthesis', status: getStatus('synthesis', phase) },
  ];

  return (
    <aside className="w-80 border-r border-sidebar-border bg-sidebar flex flex-col px-3 py-6 h-screen select-none shadow-m4 z-20 overflow-hidden">
      {/* Branding */}
      <div className="flex items-center gap-3 mb-10 px-1 group">
        <div className="p-2.5 rounded-lg bg-primary/10 border border-primary/20 group-hover:scale-110 transition-transform shadow-m2 text-primary">
          <Ghost className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight text-sidebar-foreground font-sans">LokiDoki</h2>
          <div className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest">
            Agentic Core v0.2
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="space-y-2 mb-6">
        <Link
          to="/"
          className={`flex items-center gap-3 px-3 py-3 rounded-lg transition-all duration-300 border ${
            isChat
              ? 'bg-primary/10 border-primary/20 text-primary shadow-sm font-bold'
              : 'border-transparent text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <MessageSquare size={18} />
          <span className="text-sm tracking-tight">Agentic Chat</span>
        </Link>
        <Link
          to="/memory"
          className={`flex items-center gap-3 px-3 py-3 rounded-lg transition-all duration-300 border ${
            isMemory
              ? 'bg-primary/10 border-primary/20 text-primary shadow-sm font-bold'
              : 'border-transparent text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <Brain size={18} />
          <span className="text-sm tracking-tight">Memory</span>
        </Link>
      </nav>

      {/* Main Content Area (Scrollable) */}
      <div className="flex-1 overflow-y-auto no-scrollbar space-y-6 pb-6">
        
        {/* Projects Section */}
        <Collapsible open={showProjects} onOpenChange={setShowProjects}>
          <div className="flex items-center justify-between px-1 mb-2">
            <CollapsibleTrigger className="flex items-center gap-2 text-[10px] font-bold text-muted-foreground uppercase tracking-widest hover:text-foreground transition-all">
              {showProjects ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
              Projects ({projects.length})
            </CollapsibleTrigger>
            <button 
              onClick={(e) => { e.stopPropagation(); setEditingProject(null); setIsProjectModalOpen(true); }}
              className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-all"
            >
              <FolderPlus size={14} />
            </button>
          </div>
          <CollapsibleContent className="space-y-1 px-1">
            {projects.map(project => {
              const projectChats = sessions.filter(s => s.project_id === project.id);
              const isExpanded = activeProjectId === project.id;
              
              return (
                <div key={project.id} className="space-y-1">
                  <ProjectListItem 
                    project={project}
                    isActive={isExpanded}
                    onSelect={(id) => setActiveProjectId(id === activeProjectId ? null : id)}
                    onEdit={(p) => { setEditingProject(p); setIsProjectModalOpen(true); }}
                    onDelete={handleDeleteProject}
                  />
                  {isExpanded && (
                    <div className="ml-4 pl-2 border-l border-border/20 space-y-1 mt-1">
                      {projectChats.map(session => (
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

        {/* Chats Section (Independent) */}
        <Collapsible open={showChats} onOpenChange={setShowChats}>
          <div className="flex items-center justify-between px-2 mb-2">
            <CollapsibleTrigger className="flex items-center gap-2 text-[10px] font-bold text-muted-foreground uppercase tracking-widest hover:text-foreground transition-all">
              {showChats ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
              Chats ({globalSessions.length})
            </CollapsibleTrigger>
            <button 
              onClick={(e) => { e.stopPropagation(); handleNewSessionFallback(); }}
              className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-all"
            >
              <Plus size={14} />
            </button>
          </div>
          <CollapsibleContent className="space-y-1 px-2">
            {globalSessions.map(session => (
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

        {/* Execution Context (Visualizer) */}
        <div className="pt-4 border-t border-border/10 space-y-10">
          <div>
            <h3 className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-6 border-b border-border/10 pb-2">
              Execution Timeline
            </h3>
            <ExecutionTimeline phases={phases} pipeline={pipeline} />
          </div>

          {pipeline?.decomposition && (
            <div>
              <h3 className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-6 border-b border-border/10 pb-2">
                Decomposition Log
              </h3>
              <DecompositionPanel data={pipeline.decomposition} />
            </div>
          )}

          <div>
            <h3 className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-6 border-b border-border/10 pb-2">
              System Metrics
            </h3>
            <StatusMetrics pipeline={pipeline} />
          </div>
        </div>
      </div>

      {/* Profile (bottom-left) */}
      <div className="pt-3 mt-2 border-t border-sidebar-border/40">
        <ProfileMenu />
      </div>

      <ProjectModal
        isOpen={isProjectModalOpen}
        onClose={() => setIsProjectModalOpen(false)}
        onSubmit={handleCreateProject}
        initialData={editingProject}
        title={editingProject ? "Edit Project" : "New Project"}
      />

      <ConfirmDialog
        open={!!projectPendingDelete}
        title="Delete project?"
        description={projectPendingDelete ? `"${projectPendingDelete.name}" will be deleted. Chats inside will be moved out, not deleted.` : ''}
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDeleteProject}
        onCancel={() => setProjectPendingDelete(null)}
      />
    </aside>
  );
};

function getStatus(step: string, current: string): 'idle' | 'active' | 'done' | 'failed' {
  const order = ['idle', 'augmentation', 'decomposition', 'routing', 'synthesis', 'completed'];
  const currentIndex = order.indexOf(current);
  const stepIndex = order.indexOf(step);

  if (current === 'idle') return 'idle';
  if (currentIndex === stepIndex) return 'active';
  if (currentIndex > stepIndex) return 'done';
  return 'idle';
}

export default Sidebar;
