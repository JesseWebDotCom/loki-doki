import React from 'react';
import { Zap, CircleCheck, CircleDashed, Loader2 } from 'lucide-react';
import type { PipelineState } from '../../pages/ChatPage';

interface Phase {
  id: string;
  label: string;
  status: 'idle' | 'active' | 'done' | 'failed';
}

interface TimelineProps {
  phases: Phase[];
  pipeline?: PipelineState;
}

const ExecutionTimeline: React.FC<TimelineProps> = ({ phases, pipeline }) => {
  const getLatency = (phaseId: string): string | null => {
    if (!pipeline) return null;
    if (phaseId === 'decomposition' && pipeline.decomposition) {
      return `${pipeline.decomposition.latency_ms.toFixed(0)}ms`;
    }
    if (phaseId === 'synthesis' && pipeline.synthesis) {
      return `${pipeline.synthesis.latency_ms.toFixed(0)}ms`;
    }
    return null;
  };

  const getModelTag = (phaseId: string): string | null => {
    if (!pipeline) return null;
    if (phaseId === 'decomposition' && pipeline.decomposition) {
      return pipeline.decomposition.model;
    }
    if (phaseId === 'synthesis' && pipeline.synthesis) {
      return pipeline.synthesis.model;
    }
    return null;
  };

  return (
    <div className="space-y-6">
      {phases.map((phase) => {
        const latency = getLatency(phase.id);
        const model = getModelTag(phase.id);

        return (
          <div key={phase.id} className={`flex items-start gap-4 transition-all duration-300 ${
            phase.status === 'active' ? 'opacity-100 scale-102' :
            phase.status === 'done' ? 'opacity-80' : 'opacity-40'
          }`}>
            <div className="relative mt-0.5">
              {phase.status === 'done' ? (
                <CircleCheck className="w-4 h-4 text-green-500" />
              ) : phase.status === 'active' ? (
                <div className="relative">
                  <Loader2 className="w-4 h-4 text-primary animate-spin" />
                  <div className="absolute inset-0 bg-primary/20 rounded-full blur-sm animate-pulse" />
                </div>
              ) : (
                <CircleDashed className="w-4 h-4 text-gray-700" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <span className={`text-sm font-semibold tracking-tight ${
                  phase.status === 'active' ? 'text-white' :
                  phase.status === 'done' ? 'text-gray-300' : 'text-gray-400'
                }`}>
                  {phase.label}
                </span>
                {latency && (
                  <span className="text-[10px] font-mono text-primary font-bold">{latency}</span>
                )}
              </div>

              {phase.status === 'active' && (
                <span className="text-[10px] text-electric uppercase tracking-widest font-bold animate-pulse">
                  Processing...
                </span>
              )}

              {model && phase.status === 'done' && (
                <span className="text-[10px] font-mono text-muted-foreground">{model}</span>
              )}
            </div>

            {phase.status === 'done' && <Zap size={14} className="text-yellow-500 mt-0.5" />}
          </div>
        );
      })}

      {pipeline && pipeline.totalLatencyMs > 0 && (
        <div className="pt-4 border-t border-border/10 flex items-center justify-between px-1">
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">Total</span>
          <span className="text-xs font-mono text-primary font-bold">
            {pipeline.totalLatencyMs.toFixed(0)}ms
          </span>
        </div>
      )}
    </div>
  );
};

export default ExecutionTimeline;
