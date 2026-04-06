import React from 'react';
import { Loader2, Brain, Route, Sparkles, Layers } from 'lucide-react';
import type { PipelineState } from '../../pages/ChatPage';

interface ThinkingIndicatorProps {
  pipeline: PipelineState;
}

const PHASE_CONFIG = {
  augmentation: { label: 'Augmenting context', icon: Layers, color: 'text-blue-400' },
  decomposition: { label: 'Decomposing intent', icon: Brain, color: 'text-purple-400' },
  routing: { label: 'Routing to skills', icon: Route, color: 'text-amber-400' },
  synthesis: { label: 'Synthesizing response', icon: Sparkles, color: 'text-green-400' },
} as const;

const PHASE_ORDER: Array<keyof typeof PHASE_CONFIG> = ['augmentation', 'decomposition', 'routing', 'synthesis'];

const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({ pipeline }) => {
  const currentPhase = pipeline.phase;
  if (currentPhase === 'idle') return null;

  const currentIndex = PHASE_ORDER.indexOf(currentPhase as keyof typeof PHASE_CONFIG);

  return (
    <div className="flex w-full mb-8 justify-start">
      <div className="max-w-[80%] rounded-2xl px-6 py-4 border border-border/40 bg-card/50 backdrop-blur-sm">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            assistant
          </span>
          <Loader2 size={12} className="text-primary animate-spin" />
        </div>

        <div className="flex flex-col gap-2">
          {PHASE_ORDER.map((phase, idx) => {
            const config = PHASE_CONFIG[phase];
            const Icon = config.icon;

            const isActive = phase === currentPhase;
            const isDone = idx < currentIndex;
            const isPending = idx > currentIndex;

            return (
              <div
                key={phase}
                className={`flex items-center gap-3 transition-all duration-300 ${
                  isPending ? 'opacity-30' : isActive ? 'opacity-100' : 'opacity-60'
                }`}
              >
                <div className="w-5 flex justify-center">
                  {isActive ? (
                    <Loader2 size={14} className={`${config.color} animate-spin`} />
                  ) : isDone ? (
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                  ) : (
                    <div className="w-2 h-2 rounded-full bg-gray-600" />
                  )}
                </div>

                <Icon size={14} className={isDone ? 'text-green-500' : isActive ? config.color : 'text-gray-600'} />

                <span className={`text-sm font-medium tracking-tight ${
                  isActive ? 'text-foreground' : isDone ? 'text-muted-foreground' : 'text-gray-600'
                }`}>
                  {config.label}
                </span>

                {isActive && (
                  <span className="text-[10px] text-primary font-bold uppercase tracking-widest animate-pulse ml-auto">
                    Active
                  </span>
                )}

                {isDone && pipeline.decomposition && phase === 'decomposition' && (
                  <span className="text-[10px] text-muted-foreground font-mono ml-auto">
                    {pipeline.decomposition.latency_ms.toFixed(0)}ms
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ThinkingIndicator;
