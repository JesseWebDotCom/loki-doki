import React from 'react';
import { Zap, CircleCheck, CircleDashed, Loader2 } from 'lucide-react';

interface Phase {
  id: string;
  label: string;
  status: 'idle' | 'active' | 'done' | 'failed';
}

interface TimelineProps {
  phases: Phase[];
}

const ExecutionTimeline: React.FC<TimelineProps> = ({ phases }) => {
  return (
    <div className="space-y-6">
      {phases.map((phase) => (
        <div key={phase.id} className={`flex items-center gap-4 transition-all duration-300 ${
          phase.status === 'active' ? 'opacity-100 scale-102' : 'opacity-40'
        }`}>
          <div className="relative">
            {phase.status === 'done' ? (
              <CircleCheck className="w-4 h-4 text-green-500" />
            ) : phase.status === 'active' ? (
              <div className="relative">
                <Loader2 className="w-4 h-4 text-electric animate-spin" />
                <div className="absolute inset-0 bg-electric/20 rounded-full blur-sm animate-pulse" />
              </div>
            ) : (
              <CircleDashed className="w-4 h-4 text-gray-700" />
            )}
          </div>
          
          <div className="flex flex-col">
            <span className={`text-sm font-semibold tracking-tight ${
              phase.status === 'active' ? 'text-white' : 'text-gray-400'
            }`}>
              {phase.label}
            </span>
            {phase.status === 'active' && (
              <span className="text-[10px] text-electric uppercase tracking-widest font-bold animate-pulse">
                Processing...
              </span>
            )}
          </div>

          {phase.status === 'done' && <Zap size={14} className="text-yellow-500 ml-auto" />}
        </div>
      ))}
    </div>
  );
};

export default ExecutionTimeline;
