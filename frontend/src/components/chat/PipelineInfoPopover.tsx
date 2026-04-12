import React, { useMemo, useState } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  Layers,
  Loader2,
  Route,
  Sparkles,
} from 'lucide-react';
import type { PipelineState } from '../../pages/ChatPage';
import { formatDuration } from '../../lib/utils';

interface Props {
  pipeline: PipelineState;
  currentPhase?: PipelineState['phase'];
}

const phaseRows = [
  { key: 'augmentation', label: 'Warming Up', icon: Layers, color: 'text-blue-400' },
  { key: 'decomposition', label: 'Planning', icon: Brain, color: 'text-purple-400' },
  { key: 'routing', label: 'Checking Sources', icon: Route, color: 'text-amber-400' },
  { key: 'synthesis', label: 'Wrapping Up', icon: Sparkles, color: 'text-green-400' },
] as const;

function humanizeToken(value: string | null | undefined): string {
  if (!value) return 'a tool';
  return value
    .replace(/^knowledge_/, '')
    .replace(/^micro_/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\bwiki\b/gi, 'Wikipedia')
    .replace(/\bollm\b/gi, 'model')
    .replace(/\bapi\b/gi, 'API')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildUserSteps(pipeline: PipelineState): Array<{
  key: string;
  label: string;
  detail?: string;
  time?: string;
  icon: (typeof phaseRows)[number]['icon'];
  color: string;
}> {
  const steps: Array<{
    key: string;
    label: string;
    detail?: string;
    time?: string;
    icon: (typeof phaseRows)[number]['icon'];
    color: string;
  }> = [];

  if (pipeline.augmentation?.latency_ms != null) {
    steps.push({
      key: 'augmentation',
      label: 'Warming Up',
      detail: pipeline.augmentation.relevant_facts > 0
        ? `augmentation · ${pipeline.augmentation.relevant_facts} memory hit${pipeline.augmentation.relevant_facts === 1 ? '' : 's'}`
        : 'augmentation · current chat',
      time: formatDuration(pipeline.augmentation.latency_ms),
      icon: Layers,
      color: 'text-blue-400',
    });
  }

  if (pipeline.microFastLane?.hit) {
    steps.push({
      key: 'quick-match',
      label: 'Planning',
      detail: pipeline.microFastLane.category
        ? `micro fast lane · ${humanizeToken(pipeline.microFastLane.category)}`
        : 'micro fast lane',
      time: formatDuration(pipeline.microFastLane.latency_ms),
      icon: Brain,
      color: 'text-purple-400',
    });
  } else if (pipeline.decomposition?.latency_ms != null) {
    steps.push({
      key: 'decomposition',
      label: 'Planning',
      detail: `decomposer · ${pipeline.decomposition.reasoning_complexity}`,
      time: formatDuration(pipeline.decomposition.latency_ms),
      icon: Brain,
      color: 'text-purple-400',
    });
  }

  if (pipeline.routing?.latency_ms != null && pipeline.routing.routing_log.length > 0) {
    const successfulSkills = pipeline.routing.routing_log
      .filter((entry) => entry.status === 'success')
      .map((entry) => humanizeToken(entry.skill_id ?? entry.intent));
    steps.push({
      key: 'routing',
      label: successfulSkills.length > 0
        ? 'Checking Sources'
        : 'Checking Sources',
      detail: successfulSkills.length > 0
        ? `routing · ${successfulSkills.join(' + ')}`
        : 'routing · no match',
      time: formatDuration(pipeline.routing.latency_ms),
      icon: Route,
      color: 'text-amber-400',
    });
  }

  if (pipeline.synthesis?.latency_ms != null) {
    steps.push({
      key: 'synthesis',
      label: 'Wrapping Up',
      detail: `synthesis · ${pipeline.synthesis.model}`,
      time: formatDuration(pipeline.synthesis.latency_ms),
      icon: Sparkles,
      color: 'text-green-400',
    });
  }

  return steps;
}

function buildLiveSteps(
  pipeline: PipelineState,
  currentPhase: PipelineState['phase'],
): Array<{
  key: string;
  label: string;
  detail?: string;
  time?: string;
  icon: (typeof phaseRows)[number]['icon'];
  color: string;
}> {
  const steps = buildUserSteps(pipeline);

  if (!steps.some((step) => step.key === 'augmentation') && currentPhase !== 'idle') {
    steps.push({
      key: 'augmentation',
      label: 'Warming Up',
      detail: 'augmentation',
      icon: Layers,
      color: 'text-blue-400',
    });
  }

  if (
    !steps.some((step) => step.key === 'decomposition' || step.key === 'quick-match') &&
    ['decomposition', 'routing', 'synthesis', 'completed'].includes(currentPhase)
  ) {
    steps.push({
      key: 'decomposition',
      label: 'Planning',
      detail: 'decomposer',
      icon: Brain,
      color: 'text-purple-400',
    });
  }

  if (
    !steps.some((step) => step.key === 'routing') &&
    ['routing', 'synthesis', 'completed'].includes(currentPhase)
  ) {
    steps.push({
      key: 'routing',
      label: 'Checking Sources',
      detail: 'routing',
      icon: Route,
      color: 'text-amber-400',
    });
  }

  if (
    !steps.some((step) => step.key === 'synthesis') &&
    ['synthesis', 'completed'].includes(currentPhase)
  ) {
    steps.push({
      key: 'synthesis',
      label: 'Wrapping Up',
      detail: 'synthesis',
      icon: Sparkles,
      color: 'text-green-400',
    });
  }

  const order = ['augmentation', 'quick-match', 'decomposition', 'routing', 'synthesis'];
  return steps.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

const PipelineInfoPopover: React.FC<Props> = ({ pipeline, currentPhase = 'completed' }) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const isLive = currentPhase !== 'completed';
  const fastLaneHit = pipeline.microFastLane?.hit === true;
  const userSteps = useMemo(
    () => (isLive ? buildLiveSteps(pipeline, currentPhase) : buildUserSteps(pipeline)),
    [currentPhase, isLive, pipeline],
  );
  const totalLabel = pipeline.totalLatencyMs > 0
    ? `Thought for ${formatDuration(pipeline.totalLatencyMs)}`
    : isLive
      ? 'Thinking...'
      : 'Pipeline complete';

  const stepCount = userSteps.length;

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const augMs = pipeline.augmentation?.latency_ms ?? 0;
    const decompMs = pipeline.decomposition?.latency_ms ?? 0;
    const routingMs = pipeline.routing?.latency_ms ?? 0;
    const synthMs = pipeline.synthesis?.latency_ms ?? 0;
    const lines: string[] = [
      `Pipeline: ${pipeline.totalLatencyMs > 0 ? formatDuration(pipeline.totalLatencyMs) : 'completed'}`,
      `  Warming Up${augMs > 0 ? `  ${formatDuration(augMs)}` : ''}`,
      `  Planning${fastLaneHit ? '  skipped' : decompMs > 0 ? `  ${formatDuration(decompMs)}` : ''}`,
      `  Route${
        fastLaneHit
          ? '  skipped'
          : pipeline.routing
            ? pipeline.routing.routing_log.length === 0
              ? '  LLM-only'
              : `  ${pipeline.routing.skills_resolved}✓ ${pipeline.routing.skills_failed}✗ ${formatDuration(routingMs)}`
            : ''
      }`,
      `  Wrapping Up${synthMs > 0 ? `  ${formatDuration(synthMs)}` : ''}`,
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
    <div className="w-full">
      <button
        type="button"
        aria-label={totalLabel}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-3 rounded-[1.65rem] bg-onyx px-5 py-4 text-left transition-colors hover:bg-onyx-1 cursor-pointer"
      >
        {isLive ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-green-500" />
        ) : (
          <CircleCheck size={14} className="shrink-0 text-green-500" />
        )}
        <span className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight text-foreground">
          {totalLabel}
        </span>
        <span className="shrink-0 text-[11px] font-bold uppercase tracking-[0.18em] text-foreground/70">
          {stepCount} step{stepCount === 1 ? '' : 's'}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-foreground/70 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="px-2 py-3">
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

          <div className="mt-2 flex flex-col gap-3">
            {userSteps.map((step) => {
              const Icon = step.icon;
              const isActive = isLive && (
                (step.key === 'augmentation' && currentPhase === 'augmentation') ||
                ((step.key === 'decomposition' || step.key === 'quick-match') && currentPhase === 'decomposition') ||
                (step.key === 'routing' && currentPhase === 'routing') ||
                (step.key === 'synthesis' && currentPhase === 'synthesis')
              );
              return (
                <div key={step.key} className="flex items-start gap-3 text-[11px]">
                  <Icon size={12} className={`mt-0.5 shrink-0 ${step.color}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground/90">{step.label}</span>
                      {step.time && (
                        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{step.time}</span>
                      )}
                      {isActive && (
                        <span className="ml-2 text-[10px] font-bold uppercase tracking-widest text-primary">Active</span>
                      )}
                    </div>
                    {step.detail && (
                      <div className="mt-0.5 text-[12px] text-muted-foreground">{step.detail}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 border-t border-border/30 pt-3">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Used
            </div>
            {!pipeline.routing || pipeline.routing.routing_log.length === 0 ? (
              <div className="text-[11px] italic text-muted-foreground">
                {isLive ? 'routing · no match' : 'Built-in knowledge'}
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
                    ? 'used'
                    : noSkill
                      ? 'not used'
                      : disabled
                        ? 'unavailable'
                        : 'missed';

                  return (
                    <div key={entry.ask_id} className="flex flex-col gap-0.5 text-[11px]">
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                        <span className="text-sm text-foreground/90">{humanizeToken(skillName)}</span>
                        {statusLabel !== 'used' && (
                          <span className="text-[11px] text-muted-foreground/70">{statusLabel}</span>
                        )}
                        <span className="ml-auto font-mono text-muted-foreground/70">
                          {entry.latency_ms ? formatDuration(entry.latency_ms) : '—'}
                        </span>
                      </div>
                      <div className="pl-3.5 text-[12px] text-muted-foreground/70">
                        {entry.mechanism
                          ? `Looked up through ${humanizeToken(entry.mechanism)}`
                          : `Used for ${humanizeToken(entry.intent)}`}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default PipelineInfoPopover;
