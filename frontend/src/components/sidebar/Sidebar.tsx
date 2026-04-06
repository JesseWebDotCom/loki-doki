import React, { useState, useEffect } from 'react';
import { Ghost, MessageSquare, Settings, Brain, History, Plus, Trash2 } from 'lucide-react';
import ExecutionTimeline from './ExecutionTimeline';
import StatusMetrics from './StatusMetrics';
import DecompositionPanel from './DecompositionPanel';
import { Link, useLocation } from 'react-router-dom';
import { getSessions, deleteSession, clearChatMemory } from '../../lib/api';
import type { PipelineState } from '../../pages/ChatPage';

interface SidebarProps {
  phase: PipelineState['phase'];
  pipeline?: PipelineState;
  onNewSession?: () => void;
  onSelectSession?: (sessionId: string) => void;
  currentSessionId?: string;
}

const Sidebar: React.FC<SidebarProps> = ({ phase, pipeline, onNewSession, onSelectSession, currentSessionId }) => {
  const location = useLocation();
  const isChat = location.pathname === '/';
  const isSettings = location.pathname === '/settings';
  const isMemory = location.pathname === '/memory';
  const [sessions, setSessions] = useState<string[]>([]);
  const [showSessions, setShowSessions] = useState(false);

  useEffect(() => {
    if (isChat) {
      loadSessions();
    }
  }, [isChat]);

  const loadSessions = async () => {
    try {
      const res = await getSessions();
      setSessions(res.sessions);
    } catch {
      // API not available
    }
  };

  const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    await deleteSession(sessionId);
    setSessions(prev => prev.filter(s => s !== sessionId));
  };

  const handleNewChat = () => {
    clearChatMemory();
    onNewSession?.();
  };

  const phases = [
    { id: 'augmentation', label: 'Augmentation', status: getStatus('augmentation', phase) },
    { id: 'decomposition', label: 'Decomposition', status: getStatus('decomposition', phase) },
    { id: 'routing', label: 'Skill Routing', status: getStatus('routing', phase) },
    { id: 'synthesis', label: 'Synthesis', status: getStatus('synthesis', phase) },
  ];

  return (
    <aside className="w-80 border-r border-sidebar-border bg-sidebar flex flex-col p-6 h-screen select-none shadow-m4 z-20">
      {/* Branding */}
      <div className="flex items-center gap-3 mb-10 px-2 group">
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
          className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-300 border ${
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
          className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-300 border ${
            isMemory
              ? 'bg-primary/10 border-primary/20 text-primary shadow-sm font-bold'
              : 'border-transparent text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <Brain size={18} />
          <span className="text-sm tracking-tight">Memory</span>
        </Link>
        <Link
          to="/settings"
          className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-300 border ${
            isSettings
              ? 'bg-primary/10 border-primary/20 text-primary shadow-sm font-bold'
              : 'border-transparent text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <Settings size={18} />
          <span className="text-sm tracking-tight">Configuration</span>
        </Link>
      </nav>

      {/* Session History (Chat page only) */}
      {isChat && (
        <div className="mb-6">
          <button
            onClick={() => setShowSessions(!showSessions)}
            className="flex items-center gap-2 w-full px-4 py-2 text-[10px] font-bold text-muted-foreground uppercase tracking-widest hover:text-foreground transition-all"
          >
            <History size={12} />
            Sessions ({sessions.length})
          </button>
          {showSessions && (
            <div className="mt-2 space-y-1 max-h-32 overflow-y-auto px-2">
              <button
                onClick={handleNewChat}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-xs font-bold text-primary bg-primary/5 border border-primary/10 hover:bg-primary/10 transition-all"
              >
                <Plus size={12} /> New Chat
              </button>
              {sessions.map(sid => (
                <div
                  key={sid}
                  onClick={() => onSelectSession?.(sid)}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono cursor-pointer transition-all ${
                    currentSessionId === sid
                      ? 'bg-primary/10 text-primary border border-primary/20'
                      : 'text-muted-foreground hover:bg-card/50 border border-transparent'
                  }`}
                >
                  <span className="truncate">{sid.slice(0, 16)}...</span>
                  <button
                    onClick={(e) => handleDeleteSession(e, sid)}
                    className="p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-all"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Execution Context */}
      <div className="flex-1 overflow-y-auto px-2 space-y-10 no-scrollbar">
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
    </aside>
  );
};

function getStatus(step: string, current: string): 'idle' | 'active' | 'done' | 'failed' {
  const order = ['augmentation', 'decomposition', 'routing', 'synthesis'];
  const currentIndex = order.indexOf(current);
  const stepIndex = order.indexOf(step);

  if (current === 'idle') return 'idle';
  if (currentIndex === stepIndex) return 'active';
  if (currentIndex > stepIndex) return 'done';
  return 'idle';
}

export default Sidebar;
