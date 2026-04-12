import React, { useMemo, useState } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  Layers,
  Route,
  Sparkles,
} from 'lucide-react';
import type { PipelineState } from '../../pages/ChatPage';
import { formatDuration } from '../../lib/utils';

interface Props {
  pipeline: PipelineState;
}

const phaseRows = [
  { key: 'augmentation', label: 'Augment', icon: Layers, color: 'text-blue-400' },
  { key: 'decomposition', label: 'Decompose', icon: Brain, color: 'text-purple-400' },
  { key: 'routing', label: 'Route', icon: Route, color: 'text-amber-400' },
  { key: 'synthesis', label: 'Synthesize', icon: Sparkles, color: 'text-green-400' },
] as const;

const PipelineInfoPopover: React.FC<Props> = ({ pipeline }) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const fastLaneHit = pipeline.microFastLane?.hit === true;
  const totalLabel = pipeline.totalLatencyMs > 0
    ? `Thought for ${formatDuration(pipeline.totalLatencyMs)}`
    : 'Pipeline complete';

  const stepCount = useMemo(
    () => phaseRows.filter((row) => !(fastLaneHit && (row.key === 'decomposition' || row.key === 'routing'))).length,
    [fastLaneHit],
  );

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const augMs = pipeline.augmentation?.latency_ms ?? 0;
    const decompMs = pipeline.decomposition?.latency_ms ?? 0;
    const routingMs = pipeline.routing?.latency_ms ?? 0;
    const synthMs = pipeline.synthesis?.latency_ms ?? 0;
    const lines: string[] = [
      `Pipeline: ${pipeline.totalLatencyMs > 0 ? formatDuration(pipeline.totalLatencyMs) : 'completed'}`,
      `  Augment${augMs > 0 ? `  ${formatDuration(augMs)}` : ''}`,
      `  Decompose${fastLaneHit ? '  skipped' : decompMs > 0 ? `  ${formatDuration(decompMs)}` : ''}`,
      `  Route${
        fastLaneHit
          ? '  skipped'
          : pipeline.routing
            ? pipeline.routing.routing_log.length === 0
              ? '  LLM-only'
              : `  ${pipeline.routing.skills_resolved}✓ ${pipeline.routing.skills_failed}✗ ${formatDuration(routingMs)}`
            : ''
      }`,
      `  Synthesize${synthMs > 0 ? `  ${formatDuration(synthMs)}` : ''}`,
    ];

    if (pipeline.routing && pipeline.routing.routing_log.length > 0) {
      for (const entry of pipeline.routing.routing_log) {
        const ms = entry.latency_ms ? ` ${formatDuration(entry.latency_ms)}` : '';
        lines.push(
          `    - [${entry.status}] ${entry.intent}${entry.mechanism ? ` · ${entry.mechanism}` : ''}${ms}`,
        );
      }
    }

    if (pipeline.decomposition) {
      lines.push(`Model: ${pipeline.decomposition.model}`);
      lines.push(`Reasoning: ${pipeline.decomposition.reasoning_complexity}`);
    }

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard failures
    }
  };

  return (
    <div className="rounded-2xl border border-border/30 bg-muted/20">
      <button
        type="button"
        aria-label={totalLabel}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-card/50 cursor-pointer"
      >
        <CircleCheck size={14} className="shrink-0 text-green-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-foreground/90">
          {totalLabel}
        </span>
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          {stepCount} steps
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-muted-foreground transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="border-t border-border/30 px-3 py-3">
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:bg-card/60 hover:text-foreground cursor-pointer"
              aria-label="Copy pipeline summary"
            >
              {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <div className="mt-2 flex flex-col gap-2">
            {phaseRows.map((row) => {
              const Icon = row.icon;
              const isSkipped = fastLaneHit && (row.key === 'decomposition' || row.key === 'routing');
              const value = row.key === 'augmentation'
                ? pipeline.augmentation?.latency_ms
                : row.key === 'decomposition'
                  ? pipeline.decomposition?.latency_ms
                  : row.key === 'routing'
                    ? pipeline.routing?.latency_ms
                    : pipeline.synthesis?.latency_ms;

              const summary = row.key === 'routing' && pipeline.routing && !fastLaneHit
                ? pipeline.routing.routing_log.length === 0
                  ? 'LLM-only'
                  : `${pipeline.routing.skills_resolved}✓ ${pipeline.routing.skills_failed}✗ · ${formatDuration(pipeline.routing.latency_ms)}`
                : isSkipped
                  ? 'skipped'
                  : value && value > 0
                    ? formatDuration(value)
                    : '';

              return (
                <div key={row.key} className={`flex items-center gap-2 text-[11px] ${isSkipped ? 'opacity-40' : ''}`}>
                  <Icon size={12} className={isSkipped ? 'text-muted-foreground' : row.color} />
                  <span className="text-foreground/80">{row.label}</span>
                  {summary && (
                    <span className={`ml-auto font-mono ${summary === 'skipped' ? 'italic text-muted-foreground/60' : 'text-muted-foreground'}`}>
                      {summary}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-3 border-t border-border/30 pt-3">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Skills
            </div>
            {!pipeline.routing || pipeline.routing.routing_log.length === 0 ? (
              <div className="text-[11px] italic text-muted-foreground">
                No skills called — answered from model knowledge
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {pipeline.routing.routing_log.map((entry) => {
                  const ok = entry.status === 'success';
                  const noSkill = entry.status === 'no_skill';
                  const disabled = entry.status === 'disabled';
                  const dot = ok
                    ? 'bg-green-500'
                    : noSkill
                      ? 'bg-gray-500'
                      : disabled
                        ? 'bg-amber-500'
                        : 'bg-red-500';
                  const skillName = entry.skill_id || (noSkill ? 'no match' : '—');
                  const statusLabel = ok
                    ? 'ok'
                    : noSkill
                      ? 'no skill'
                      : disabled
                        ? 'disabled'
                        : 'failed';

                  return (
                    <div key={entry.ask_id} className="flex flex-col gap-0.5 text-[11px]">
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                        <span className="font-mono text-foreground/90">{skillName}</span>
                        <span className="font-mono text-muted-foreground/70">[{statusLabel}]</span>
                        <span className="ml-auto font-mono text-muted-foreground/70">
                          {entry.latency_ms ? formatDuration(entry.latency_ms) : '—'}
                        </span>
                      </div>
                      <div className="pl-3.5 font-mono text-muted-foreground/70">
                        {entry.intent}
                        {entry.mechanism ? ` · ${entry.mechanism}` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {pipeline.decomposition && (
            <div className="mt-3 border-t border-border/30 pt-3 font-mono text-[10px] text-muted-foreground">
              {pipeline.decomposition.model} · {pipeline.decomposition.reasoning_complexity}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default PipelineInfoPopover;
