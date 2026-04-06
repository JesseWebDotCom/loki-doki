import React from 'react';
import { Ghost, MessageSquare, Settings } from 'lucide-react';
import ExecutionTimeline from './ExecutionTimeline';
import StatusMetrics from './StatusMetrics';
import { Link, useLocation } from 'react-router-dom';

interface SidebarProps {
  phase: 'idle' | 'augmentation' | 'decomposition' | 'routing' | 'synthesis';
}

const Sidebar: React.FC<SidebarProps> = ({ phase }) => {
  const location = useLocation();
  const isChat = location.pathname === '/';
  const isSettings = location.pathname === '/settings';

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
        <div className="p-2.5 rounded-2xl bg-primary/10 border border-primary/20 group-hover:scale-110 transition-transform shadow-m2 text-primary">
          <Ghost className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight text-sidebar-foreground font-sans">LokiDoki</h2>
          <div className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest">
            Agentic Core v0.1
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="space-y-2 mb-10">
        <Link 
          to="/" 
          className={`flex items-center gap-3 px-4 py-3 rounded-2xl transition-all duration-300 border ${
            isChat 
              ? 'bg-primary/10 border-primary/20 text-primary shadow-sm font-bold' 
              : 'border-transparent text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <MessageSquare size={18} />
          <span className="text-sm tracking-tight">Agentic Chat</span>
        </Link>
        <Link 
          to="/settings" 
          className={`flex items-center gap-3 px-4 py-3 rounded-2xl transition-all duration-300 border ${
            isSettings 
              ? 'bg-primary/10 border-primary/20 text-primary shadow-sm font-bold' 
              : 'border-transparent text-muted-foreground hover:bg-card/50 hover:text-foreground'
          }`}
        >
          <Settings size={18} />
          <span className="text-sm tracking-tight">Configuration</span>
        </Link>
      </nav>

      {/* Execution Context */}
      <div className="flex-1 overflow-y-auto px-2 space-y-12 no-scrollbar">
        <div>
          <h3 className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-6 border-b border-border/10 pb-2">
            Execution Timeline
          </h3>
          <ExecutionTimeline phases={phases} />
        </div>

        <div>
          <h3 className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-6 border-b border-border/10 pb-2">
            System Metrics
          </h3>
          <StatusMetrics />
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
