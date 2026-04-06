import React, { useState } from 'react';
import { Loader2, Brain, Route, Sparkles, Layers, ChevronRight, CircleCheck, Copy, Check } from 'lucide-react';
import type { PipelineState } from '../../pages/ChatPage';
import { formatDuration } from '../../lib/utils';

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
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const currentPhase = pipeline.phase;
  if (currentPhase === 'idle') return null;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const decompMs = pipeline.decomposition?.latency_ms ?? 0;
    const routingMs = pipeline.routing?.latency_ms ?? 0;
    const synthMs = pipeline.synthesis?.latency_ms ?? 0;
    const lines = [
      `Pipeline: ${pipeline.totalLatencyMs > 0 ? formatDuration(pipeline.totalLatencyMs) : 'in progress'}`,
      `  Augmenting context`,
      `  Decomposing intent  ${decompMs > 0 ? formatDuration(decompMs) : ''}`.trimEnd(),
      `  Routing to skills  ${routingMs > 0 ? formatDuration(routingMs) : ''}`.trimEnd(),
      `  Synthesizing response  ${synthMs > 0 ? formatDuration(synthMs) : ''}`.trimEnd(),
    ];
    if (pipeline.routing) {
      const r = pipeline.routing;
      if (r.routing_log.length === 0) {
        lines.push(`Skills: LLM-only (no skills routed)`);
      } else {
        lines.push(`Skills: ${r.skills_resolved} resolved, ${r.skills_failed} failed`);
        for (const entry of r.routing_log) {
          const ms = entry.latency_ms ? ` ${formatDuration(entry.latency_ms)}` : '';
          const mech = entry.mechanism ? ` via ${entry.mechanism}` : '';
          lines.push(`    - [${entry.status}] ${entry.intent}${mech}${ms}`);
          if (entry.status !== 'success' && entry.mechanism_log) {
            for (const m of entry.mechanism_log as Array<Record<string, any>>) {
              const err = m?.error ? ` — ${m.error}` : '';
              lines.push(`        · ${m?.method ?? '?'} [${m?.status ?? '?'}]${err}`);
            }
          }
        }
      }
    } else {
      lines.push(`Skills: LLM-only (no routing phase)`);
    }
    if (pipeline.decomposition) {
      lines.push(`Model: ${pipeline.decomposition.model}`);
      lines.push(`Reasoning: ${pipeline.decomposition.reasoning_complexity}`);
      for (const a of pipeline.decomposition.asks) {
        lines.push(`  - [${a.intent}] ${a.distilled_query}`);
      }
    }
    if (pipeline.synthesis?.response) {
      lines.push(`Response: ${pipeline.synthesis.response}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const isCompleted = currentPhase === 'completed';
  const currentIndex = isCompleted
    ? PHASE_ORDER.length
    : PHASE_ORDER.indexOf(currentPhase as keyof typeof PHASE_CONFIG);
  const activeConfig = isCompleted
    ? PHASE_CONFIG.synthesis
    : PHASE_CONFIG[currentPhase as keyof typeof PHASE_CONFIG];
  const ActiveIcon = activeConfig?.icon;

  return (
    <div className={`flex w-full justify-start ${isCompleted ? 'mb-2' : 'mb-8'}`}>
      <div className="max-w-[80%] rounded-2xl px-6 py-4 border border-border/40 bg-card/50 backdrop-blur-sm">
        {!isCompleted && (
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              assistant
            </span>
          </div>
        )}

        {/* Collapsed: current status (clickable) */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-3 w-full py-1.5 text-left group cursor-pointer"
        >
          <ChevronRight
            size={12}
            className={`text-muted-foreground transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
          {isCompleted ? (
            <CircleCheck size={14} className="text-green-500" />
          ) : (
            <Loader2 size={14} className={`${activeConfig.color} animate-spin`} />
          )}
          {ActiveIcon && <ActiveIcon size={14} className={isCompleted ? 'text-green-500' : activeConfig.color} />}
          <span className={`text-sm font-medium tracking-tight ${isCompleted ? 'text-muted-foreground' : 'text-foreground'}`}>
            {isCompleted ? 'Pipeline complete' : activeConfig.label}
          </span>
          {isCompleted ? (
            <span className="text-[10px] text-green-500 font-bold uppercase tracking-widest ml-auto">
              {pipeline.totalLatencyMs > 0 ? formatDuration(pipeline.totalLatencyMs) : 'Done'}
            </span>
          ) : (
            <span className="text-[10px] text-primary font-bold uppercase tracking-widest animate-pulse ml-auto">
              {currentIndex + 1}/{PHASE_ORDER.length}
            </span>
          )}
        </button>

        {/* Expanded: full phase list */}
        <div
          className={`overflow-hidden transition-all duration-300 ${
            expanded ? 'max-h-60 opacity-100 mt-2' : 'max-h-0 opacity-0'
          }`}
        >
          <div className="flex items-center justify-end pt-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-card/60"
              aria-label="Copy pipeline status"
            >
              {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="flex flex-col gap-2 border-t border-border/30 pt-2">
            {PHASE_ORDER.map((phase, idx) => {
              const config = PHASE_CONFIG[phase];
              const Icon = config.icon;

              const isActive = phase === currentPhase;
              const isDone = idx < currentIndex;
              const isPending = idx > currentIndex;

              return (
                <React.Fragment key={phase}>
                <div
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
                      {formatDuration(pipeline.decomposition.latency_ms)}
                    </span>
                  )}

                  {isDone && pipeline.routing && phase === 'routing' && (
                    <span className="text-[10px] text-muted-foreground font-mono ml-auto">
                      {pipeline.routing.routing_log.length === 0
                        ? 'LLM-only'
                        : `${pipeline.routing.skills_resolved}✓ ${pipeline.routing.skills_failed}✗ · ${formatDuration(pipeline.routing.latency_ms)}`}
                    </span>
                  )}

                  {isDone && pipeline.synthesis && phase === 'synthesis' && (
                    <span className="text-[10px] text-muted-foreground font-mono ml-auto">
                      {formatDuration(pipeline.synthesis.latency_ms)}
                    </span>
                  )}
                </div>

                {phase === 'routing' && pipeline.routing && (idx <= currentIndex) && (
                  pipeline.routing.routing_log.length === 0 ? (
                    <div className="ml-8 text-[11px] text-muted-foreground italic">
                      LLM-only response (no skills routed)
                    </div>
                  ) : (
                    <div className="ml-8 flex flex-col gap-1 border-l border-border/30 pl-3">
                      {pipeline.routing.routing_log.map((entry) => {
                        const ok = entry.status === 'success';
                        const noSkill = entry.status === 'no_skill';
                        const dotColor = ok ? 'bg-green-500' : noSkill ? 'bg-gray-500' : 'bg-red-500';
                        const failureDetail = !ok && entry.mechanism_log
                          ? (entry.mechanism_log as Array<Record<string, any>>)
                              .map(m => `${m?.method ?? '?'} [${m?.status ?? '?'}]${m?.error ? ` — ${m.error}` : ''}`)
                              .join('\n')
                          : '';
                        const tooltip = ok
                          ? entry.mechanism ?? ''
                          : (failureDetail || entry.status);
                        return (
                          <div
                            key={entry.ask_id}
                            className="flex items-center gap-2 text-[11px]"
                            title={tooltip}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
                            <span className="font-mono text-muted-foreground truncate">
                              {entry.intent}
                              {entry.mechanism ? ` · ${entry.mechanism}` : ''}
                            </span>
                            <span className="ml-auto font-mono text-muted-foreground/70 shrink-0">
                              {entry.latency_ms ? formatDuration(entry.latency_ms) : '—'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )
                )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ThinkingIndicator;
