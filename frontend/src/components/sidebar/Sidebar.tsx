import React from 'react';
import { Ghost } from 'lucide-react';
import ExecutionTimeline from './ExecutionTimeline';
import StatusMetrics from './StatusMetrics';

interface SidebarProps {
  phase: 'idle' | 'augmentation' | 'decomposition' | 'routing' | 'synthesis';
}

const Sidebar: React.FC<SidebarProps> = ({ phase }) => {
  const phases = [
    { id: 'augmentation', label: 'Augmentation', status: getStatus('augmentation', phase) },
    { id: 'decomposition', label: 'Decomposition', status: getStatus('decomposition', phase) },
    { id: 'routing', label: 'Skill Routing', status: getStatus('routing', phase) },
    { id: 'synthesis', label: 'Synthesis', status: getStatus('synthesis', phase) },
  ];

  return (
    <aside className="w-80 border-r border-gray-800/10 bg-[#090a0b] flex flex-col p-6 h-screen select-none">
      <div className="flex items-center gap-3 mb-10 px-2 group">
        <div className="p-2 rounded-xl bg-electric/10 border border-electric/20 group-hover:scale-110 transition-transform">
          <Ghost className="text-electric w-6 h-6" />
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight text-white/90 font-sans">LokiDoki</h2>
          <div className="text-[9px] font-bold text-gray-600 uppercase tracking-widest">
            Agentic Core v0.1
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 space-y-12">
        <div>
          <h3 className="text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-6 border-b border-gray-800/30 pb-2">
            Execution Timeline
          </h3>
          <ExecutionTimeline phases={phases} />
        </div>

        <div>
          <h3 className="text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-6 border-b border-gray-800/30 pb-2">
            System Metrics
          </h3>
          <StatusMetrics />
        </div>
      </div>

      <div className="mt-auto pt-6 border-t border-gray-800/30 px-2">
        <div className="text-[9px] text-gray-700 uppercase tracking-widest font-bold text-center">
          Pi 5 • Local AI Architecture
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
