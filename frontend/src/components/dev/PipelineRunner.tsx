import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Cpu,
  Gauge,
  Globe,
  Grid3x3,
  Mic,
  Play,
  Route as RouteIcon,
  Sparkles,
  Type,
  Volume2,
  Wrench,
  X as XIcon,
  Zap,
} from 'lucide-react';

import {
  getBenchmarkCorpus,
  getSystemInfo,
  runBenchmarkMatrix,
  runPipeline,
  warmLlmModel,
} from '../../lib/api';
import type {
  BenchmarkCorpusCategory,
  BenchmarkCorpusPrompt,
  MatrixConfigInput,
  MatrixConfigResult,
  MatrixResponse,
  MatrixRun,
  PipelineRunOptions,
  PipelineRunResponse,
} from '../../lib/api';
import type { SystemInfo } from '../../lib/api-types';
import DevSkillsExplorer from './DevSkillsExplorer';
import MemoryPanel from './MemoryPanel';

interface CanonicalPreset {
  id: string;
  label: string;
  description: string;
  prompt: string;
  Icon: React.ComponentType<{ size?: number }>;
}

const CANONICAL_PRESETS: CanonicalPreset[] = [
  {
    id: 'fast_lane',
    label: 'Fast lane',
    description: 'Greeting · deterministic path, no LLM expected',
    prompt: 'Hello',
    Icon: Zap,
  },
  {
    id: 'lookup',
    label: 'Lookup',
    description: 'Factual lookup · exercises resolve + skills',
    prompt: 'Who is Corey Feldman',
    Icon: BookOpen,
  },
  {
    id: 'web_search',
    label: 'Web search',
    description: 'Unknown term · should fall back to web search',
    prompt: 'What is Claude Mythos',
    Icon: Globe,
  },
];

const DEFAULT_PROMPT = CANONICAL_PRESETS[0].prompt;

type DevTab = 'benchmark' | 'skills';
type BenchmarkMode = 'single' | 'matrix';
type ReasoningMode = 'auto' | 'fast' | 'thinking';
type ResponseMode = 'standard' | 'rich' | 'deep';

interface VoiceOption {
  voice_id: string;
  display_name: string;
  description: string;
}

type StageKey = 'parse' | 'route' | 'skill' | 'llm';
type StageState = 'on' | 'off' | 'auto';

interface BenchmarkVariant {
  id: string;
  title: string;
  blurb: string;
  stages: Record<StageKey, StageState>;
  options: PipelineRunOptions;
}

const STAGE_ORDER: StageKey[] = ['parse', 'route', 'skill', 'llm'];

const STAGE_META: Record<StageKey, { label: string; Icon: React.ComponentType<{ size?: number }> }> = {
  parse: { label: 'Parse', Icon: Type },
  route: { label: 'Route', Icon: RouteIcon },
  skill: { label: 'Skill', Icon: Wrench },
  llm: { label: 'LLM', Icon: Brain },
};

// Segmented-bar buckets. Each trace step rolls up into one of these so
// the App row shows a proportional breakdown of where time went.
interface StageGroup {
  key: string;
  label: string;
  color: string;
  legendColor: string;
  steps: string[];
}

const STAGE_GROUPS: StageGroup[] = [
  {
    key: 'input',
    label: 'Input',
    color: 'bg-violet-400/70',
    legendColor: 'bg-violet-400',
    steps: ['normalize', 'signals', 'parse', 'split', 'extract', 'canonicalize', 'constraints'],
  },
  {
    key: 'route',
    label: 'Route',
    color: 'bg-cyan-400/70',
    legendColor: 'bg-cyan-400',
    steps: ['fast_lane', 'route', 'select_implementation', 'derive_flags', 'goal_inference'],
  },
  {
    key: 'skill',
    label: 'Skill',
    color: 'bg-emerald-400/70',
    legendColor: 'bg-emerald-400',
    steps: ['resolve', 'execute', 'request_spec', 'loop_execute_search'],
  },
  {
    key: 'memory',
    label: 'Memory',
    color: 'bg-amber-400/70',
    legendColor: 'bg-amber-400',
    steps: ['memory_read', 'memory_write'],
  },
  {
    key: 'synthesis',
    label: 'Synthesis',
    color: 'bg-rose-400/70',
    legendColor: 'bg-rose-400',
    steps: ['media_augment', 'combine', 'llm'],
  },
];

const STEP_TO_GROUP: Record<string, StageGroup> = (() => {
  const map: Record<string, StageGroup> = {};
  for (const g of STAGE_GROUPS) for (const s of g.steps) map[s] = g;
  return map;
})();

interface StageBreakdown {
  groupKey: string;
  label: string;
  color: string;
  legendColor: string;
  ms: number;
}

const computeStageBreakdownFromSteps = (
  steps: ReadonlyArray<{ name: string; timing_ms: number }>,
): StageBreakdown[] => {
  const totals = new Map<string, number>();
  for (const step of steps) {
    const group = STEP_TO_GROUP[step.name];
    const key = group?.key ?? 'other';
    totals.set(key, (totals.get(key) ?? 0) + (step.timing_ms || 0));
  }
  const out: StageBreakdown[] = [];
  for (const group of STAGE_GROUPS) {
    const ms = totals.get(group.key) ?? 0;
    if (ms > 0) {
      out.push({
        groupKey: group.key,
        label: group.label,
        color: group.color,
        legendColor: group.legendColor,
        ms,
      });
    }
  }
  const other = totals.get('other');
  if (other && other > 0) {
    out.push({
      groupKey: 'other',
      label: 'Other',
      color: 'bg-muted/60',
      legendColor: 'bg-muted-foreground',
      ms: other,
    });
  }
  return out;
};

const computeStageBreakdown = (result: PipelineRunResponse): StageBreakdown[] =>
  computeStageBreakdownFromSteps(result.trace.steps);


type RunStatus = 'idle' | 'running' | 'done' | 'error';

interface BenchmarkRun {
  variant: BenchmarkVariant;
  status: RunStatus;
  result: PipelineRunResponse | null;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmtMs = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}s`;
  return `${Math.round(value)}ms`;
};

const fmtPct = (value: number): string => `${(value * 100).toFixed(0)}%`;

const buildSourceBadges = (result: PipelineRunResponse): string[] => {
  const badges: string[] = [];
  if (result.fast_lane.matched) {
    badges.push(`fast_lane · ${result.fast_lane.capability ?? 'unknown'}`);
    return badges;
  }
  const primaryChunk = result.request_spec.chunks.find((chunk) => chunk.role === 'primary_request');
  const primaryExecution = primaryChunk
    ? result.executions.find((exec) => exec.capability === primaryChunk.capability)
    : result.executions[0];
  const capability = primaryChunk?.capability ?? primaryExecution?.capability ?? 'unknown';
  const mechanism = primaryExecution?.raw_result?.mechanism_used as string | undefined;
  if (result.request_spec.llm_used) {
    badges.push(`llm · ${result.request_spec.llm_model ?? 'stub'}`);
    if (result.request_spec.llm_reason) badges.push(`reason · ${result.request_spec.llm_reason}`);
    badges.push(`route · ${capability}`);
    if (mechanism) badges.push(`mech · ${mechanism}`);
    return badges;
  }
  if (capability === 'direct_chat') badges.push('direct_chat fallback');
  else badges.push(`skill · ${capability}`);
  if (mechanism) badges.push(`mech · ${mechanism}`);
  return badges;
};

const statusClasses: Record<string, string> = {
  done: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  matched: 'border-cyan-400/20 bg-cyan-400/10 text-cyan-300',
  bypassed: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
};

// ---------------------------------------------------------------------------
// Shared toolbar controls
// ---------------------------------------------------------------------------

interface ToolbarProps {
  systemInfo: SystemInfo | null;
  selectedModel: string;
  setSelectedModel: (v: string) => void;
  reasoningMode: ReasoningMode;
  setReasoningMode: (v: ReasoningMode) => void;
  responseMode: ResponseMode;
  setResponseMode: (v: ResponseMode) => void;
  selectedVoice: string;
  setSelectedVoice: (v: string) => void;
  voiceOptions: VoiceOption[];
}

const BenchmarkToolbar: React.FC<ToolbarProps> = ({
  systemInfo,
  selectedModel,
  setSelectedModel,
  reasoningMode,
  setReasoningMode,
  responseMode,
  setResponseMode,
  selectedVoice,
  setSelectedVoice,
  voiceOptions,
}) => {
  const availableModels = systemInfo?.available_models ?? [];
  const selectClasses =
    'w-full rounded-md border border-border/40 bg-background/60 px-2 py-1.5 text-xs focus:border-primary/40 focus:outline-none';

  const cell = (icon: React.ReactNode, label: string, select: React.ReactNode, hint?: string) => (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1">{select}</div>
      {hint && <div className="mt-1 truncate text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-border/30 bg-background/30 px-3 py-2">
      {cell(
        <Cpu size={10} />,
        'Model',
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className={selectClasses}
        >
          {availableModels.length === 0 && <option value="">Default</option>}
          {availableModels.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>,
        systemInfo ? `fast: ${systemInfo.fast_model} · think: ${systemInfo.thinking_model}` : '',
      )}
      {cell(
        <Brain size={10} />,
        'Reasoning',
        <select
          value={reasoningMode}
          onChange={(e) => setReasoningMode(e.target.value as ReasoningMode)}
          className={selectClasses}
        >
          <option value="fast">Fast</option>
          <option value="thinking">Thinking</option>
          <option value="auto">Auto</option>
        </select>,
      )}
      {cell(
        <Sparkles size={10} />,
        'Response',
        <select
          value={responseMode}
          onChange={(e) => setResponseMode(e.target.value as ResponseMode)}
          className={selectClasses}
        >
          <option value="standard">Standard</option>
          <option value="rich">Rich</option>
          <option value="deep">Deep</option>
        </select>,
      )}
      {cell(
        <Volume2 size={10} />,
        'Voice',
        <select
          value={selectedVoice}
          onChange={(e) => setSelectedVoice(e.target.value)}
          className={selectClasses}
        >
          {voiceOptions.length === 0 && <option value="">Default</option>}
          {voiceOptions.map((v) => (
            <option key={v.voice_id} value={v.voice_id}>
              {v.display_name}
            </option>
          ))}
        </select>,
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Warm status strip — below the toolbar, explains why Run may be gated.
// ---------------------------------------------------------------------------

interface WarmStatusStripProps {
  selectedModel: string;
  warming: boolean;
  warmedModel: string | null;
  warmLatencyMs: number | null;
  warmError: string | null;
}

const WarmStatusStrip: React.FC<WarmStatusStripProps> = ({
  selectedModel,
  warming,
  warmedModel,
  warmLatencyMs,
  warmError,
}) => {
  if (!selectedModel) return null;
  const state: 'warming' | 'ready' | 'error' | 'idle' = warming
    ? 'warming'
    : warmError
      ? 'error'
      : warmedModel === selectedModel
        ? 'ready'
        : 'idle';

  const tone =
    state === 'warming'
      ? 'border-amber-400/30 bg-amber-400/5 text-amber-300'
      : state === 'error'
        ? 'border-red-400/30 bg-red-400/5 text-red-300'
        : state === 'ready'
          ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300'
          : 'border-border/30 bg-background/30 text-muted-foreground';

  const label = (() => {
    switch (state) {
      case 'warming':
        return `Warming ${selectedModel} into engine RAM…`;
      case 'error':
        return `Warm failed for ${selectedModel}: ${warmError}`;
      case 'ready':
        return warmLatencyMs != null
          ? `${selectedModel} resident · warmed in ${fmtMs(warmLatencyMs)}`
          : `${selectedModel} resident`;
      default:
        return `${selectedModel} — warming queued`;
    }
  })();

  return (
    <div
      className={`mt-2 flex items-center gap-2 rounded-md border px-3 py-1.5 text-[11px] ${tone}`}
    >
      {state === 'warming' && (
        <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
      )}
      <span className="font-mono">{label}</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Single mode — redesigned as a dense comparison row
// ---------------------------------------------------------------------------

interface SingleModeProps {
  message: string;
  setMessage: (v: string) => void;
  running: boolean;
  warming: boolean;
  onRun: () => void;
  memoryEnabled: boolean;
  setMemoryEnabled: (v: boolean) => void;
  needPreference: boolean;
  setNeedPreference: (v: boolean) => void;
  needSocial: boolean;
  setNeedSocial: (v: boolean) => void;
  runs: BenchmarkRun[];
  currentVariantId: string | null;
  onCopyRun: (run: BenchmarkRun) => void;
  copiedRunId: string | null;
  memoryRefreshNonce: number;
}

const SingleMode: React.FC<SingleModeProps> = ({
  message,
  setMessage,
  running,
  warming,
  onRun,
  memoryEnabled,
  setMemoryEnabled,
  needPreference,
  setNeedPreference,
  needSocial,
  setNeedSocial,
  runs,
  currentVariantId,
  onCopyRun,
  copiedRunId,
  memoryRefreshNonce,
}) => {
  const [openTrace, setOpenTrace] = useState<string | null>(null);

  const completed = runs.filter((r) => r.status === 'done' && r.result);

  const fastestRunId = useMemo(() => {
    if (completed.length === 0) return null;
    return completed.reduce((best, run) => {
      const cur = completed.find((r) => r.variant.id === best);
      if (!cur || !cur.result || !run.result) return run.variant.id;
      return run.result.trace_summary.total_timing_ms < cur.result.trace_summary.total_timing_ms
        ? run.variant.id
        : best;
    }, completed[0].variant.id);
  }, [completed]);

  const maxTotal = useMemo(() => {
    if (completed.length === 0) return 1;
    return Math.max(1, ...completed.map((r) => r.result?.trace_summary.total_timing_ms ?? 0));
  }, [completed]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 rounded-lg border border-border/30 bg-background/30 p-3 sm:flex-row sm:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            className="min-h-[44px] w-full resize-y rounded-md border border-border/40 bg-background/60 p-2 text-sm focus:border-primary/40 focus:outline-none"
            placeholder="Benchmark prompt…"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Presets
            </span>
            {CANONICAL_PRESETS.map((preset) => {
              const active = message.trim() === preset.prompt;
              const { Icon } = preset;
              return (
                <button
                  key={preset.id}
                  onClick={() => setMessage(preset.prompt)}
                  title={preset.description}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all ${
                    active
                      ? 'border-primary/40 bg-primary/15 text-primary'
                      : 'border-border/40 bg-card/40 text-muted-foreground hover:border-primary/30 hover:text-foreground'
                  }`}
                >
                  <Icon size={11} />
                  <span>{preset.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <button
          onClick={onRun}
          disabled={running || warming || !message.trim()}
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-bold text-white transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 sm:w-24"
          title={warming ? 'Waiting for the selected model to load into engine RAM…' : undefined}
        >
          <Play size={12} />
          {running ? 'Running…' : warming ? 'Warming…' : 'Run'}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-4 px-1 text-xs">
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={memoryEnabled}
            onChange={(e) => setMemoryEnabled(e.target.checked)}
          />
          <Mic size={11} />
          <span>Memory</span>
        </label>
        <label className={`inline-flex items-center gap-2 ${!memoryEnabled ? 'opacity-40' : ''}`}>
          <input
            type="checkbox"
            checked={needPreference}
            disabled={!memoryEnabled}
            onChange={(e) => setNeedPreference(e.target.checked)}
          />
          <span>pref</span>
        </label>
        <label className={`inline-flex items-center gap-2 ${!memoryEnabled ? 'opacity-40' : ''}`}>
          <input
            type="checkbox"
            checked={needSocial}
            disabled={!memoryEnabled}
            onChange={(e) => setNeedSocial(e.target.checked)}
          />
          <span>social</span>
        </label>
      </div>

      {memoryEnabled && <MemoryPanel refreshNonce={memoryRefreshNonce} />}

      <div className="overflow-hidden rounded-lg border border-border/30 bg-card/20">
        {runs.map((run, rowIdx) => {
          const isCurrent = currentVariantId === run.variant.id;
          const isDone = run.status === 'done' && run.result;
          const isIdle = run.status === 'idle';
          const isOpen = openTrace === run.variant.id;
          const total = run.result?.trace_summary.total_timing_ms ?? 0;
          const best = isDone && run.variant.id === fastestRunId;
          const relative = Math.max(1.5, (total / maxTotal) * 100);
          const breakdown = run.result ? computeStageBreakdown(run.result) : [];
          const totalBreakdown = breakdown.reduce((s, b) => s + b.ms, 0);
          const bottleneck = run.result?.trace_summary.slowest_step_name;
          const llmModel = run.result?.request_spec.llm_used
            ? run.result.request_spec.llm_model ?? 'stub'
            : null;
          const output = run.result?.response.output_text ?? '';
          const preview = output.length > 200 ? `${output.slice(0, 200)}…` : output;

          return (
            <div
              key={run.variant.id}
              className={rowIdx > 0 ? 'border-t border-border/20' : ''}
            >
              <div
                className={`flex items-center gap-3 px-3 py-2 transition-colors ${
                  best ? 'bg-emerald-400/5' : isCurrent ? 'bg-primary/5' : ''
                } ${isIdle ? 'opacity-50' : ''}`}
              >
                <div className="flex w-32 shrink-0 items-center gap-1.5">
                  {best ? (
                    <Zap size={11} className="shrink-0 text-emerald-400" />
                  ) : isCurrent ? (
                    <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
                  ) : (
                    <span className="w-[11px]" />
                  )}
                  <span
                    className="truncate text-xs font-bold"
                    title={run.variant.blurb}
                  >
                    {run.variant.title}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {STAGE_ORDER.map((stage) => {
                    const state = run.variant.stages[stage];
                    const { Icon, label } = STAGE_META[stage];
                    const tone =
                      state === 'on'
                        ? 'bg-primary/15 text-primary'
                        : state === 'auto'
                          ? 'bg-amber-400/10 text-amber-300 ring-1 ring-dashed ring-amber-400/40'
                          : 'bg-card/40 text-muted-foreground/40';
                    const title =
                      state === 'on'
                        ? `${label} · on`
                        : state === 'auto'
                          ? `${label} · auto`
                          : `${label} · off`;
                    return (
                      <span
                        key={stage}
                        title={title}
                        className={`flex h-5 w-5 items-center justify-center rounded ${tone}`}
                      >
                        <Icon size={10} />
                      </span>
                    );
                  })}
                </div>
                <div
                  className={`relative h-6 flex-1 overflow-hidden rounded bg-card/40 ${
                    isCurrent ? 'animate-pulse ring-1 ring-primary/40' : ''
                  }`}
                >
                  {isDone && breakdown.length > 0 && (
                    <div
                      className="absolute inset-y-0 left-0 flex overflow-hidden rounded"
                      style={{ width: `${relative}%` }}
                    >
                      {breakdown.map((seg) => {
                        const pct = (seg.ms / Math.max(1, totalBreakdown)) * 100;
                        return (
                          <div
                            key={seg.groupKey}
                            className={seg.color}
                            style={{ width: `${pct}%` }}
                            title={`${seg.label}: ${fmtMs(seg.ms)}`}
                          />
                        );
                      })}
                    </div>
                  )}
                  {isCurrent && !isDone && (
                    <div className="absolute inset-y-0 left-0 right-0 animate-pulse bg-primary/25" />
                  )}
                </div>
                <div
                  className={`w-16 shrink-0 text-right font-mono text-sm font-bold tabular-nums ${
                    best
                      ? 'text-emerald-300'
                      : isDone
                        ? 'text-foreground'
                        : 'text-muted-foreground/40'
                  }`}
                >
                  {isDone ? fmtMs(total) : isCurrent ? '…' : '—'}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => isDone && onCopyRun(run)}
                    disabled={!isDone}
                    className="inline-flex items-center rounded border border-border/40 bg-card/50 px-1.5 py-0.5 text-muted-foreground transition-all hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-30"
                    title="Copy run details"
                  >
                    {copiedRunId === run.variant.id ? (
                      <Check size={11} />
                    ) : (
                      <Copy size={11} />
                    )}
                  </button>
                  <button
                    onClick={() => isDone && setOpenTrace(isOpen ? null : run.variant.id)}
                    disabled={!isDone}
                    className="inline-flex items-center rounded border border-border/40 bg-card/50 px-1.5 py-0.5 text-muted-foreground transition-all hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-30"
                    title="Show deep trace"
                  >
                    <ChevronDown
                      size={11}
                      className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                </div>
              </div>
              {isOpen && isDone && run.result && (
                <div className="space-y-2 border-t border-border/20 bg-background/40 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                    {bottleneck && (
                      <span>
                        bottleneck:{' '}
                        <span className="font-mono text-foreground/80">{bottleneck}</span>
                      </span>
                    )}
                    {llmModel && (
                      <span>
                        model:{' '}
                        <span className="font-mono text-foreground/80">{llmModel}</span>
                      </span>
                    )}
                    {buildSourceBadges(run.result)
                      .slice(0, 3)
                      .map((badge, i) => (
                        <span
                          key={`${run.variant.id}-${i}`}
                          className="rounded border border-primary/20 bg-primary/10 px-1 py-0 text-[9px] text-primary"
                        >
                          {badge}
                        </span>
                      ))}
                  </div>
                  <div className="rounded-md border border-primary/20 bg-primary/5 p-2 text-xs text-foreground/90">
                    {preview || (
                      <span className="italic text-muted-foreground">No output</span>
                    )}
                  </div>
                  <div className="grid gap-1.5 md:grid-cols-2">
                    {run.result.trace.steps.map((step, index) => (
                      <div
                        key={`${run.variant.id}-${step.name}-${index}`}
                        className="flex items-center gap-2 rounded border border-border/20 bg-card/40 px-2 py-1 text-[10px]"
                      >
                        <span className="font-bold uppercase tracking-widest text-primary">
                          {step.name}
                        </span>
                        <span
                          className={`rounded border px-1 py-0 text-[9px] font-bold uppercase ${
                            statusClasses[step.status] ??
                            'border-border/30 bg-card/60 text-muted-foreground'
                          }`}
                        >
                          {step.status}
                        </span>
                        <span className="ml-auto inline-flex items-center gap-1 font-mono text-muted-foreground">
                          <Clock3 size={9} />
                          {fmtMs(step.timing_ms)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <BenchmarkSynthesis runs={completed} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Synthesis panel — compares completed runs below the test rows
// ---------------------------------------------------------------------------

const BenchmarkSynthesis: React.FC<{ runs: BenchmarkRun[] }> = ({ runs }) => {
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 bg-background/20 px-3 py-4 text-center text-[11px] text-muted-foreground">
        Run the benchmark to see a synthesis of the results here.
      </div>
    );
  }

  const llmRun = runs.find((r) => r.variant.id === 'llm');
  const appRun = runs.find((r) => r.variant.id === 'app');
  const llmTotal = llmRun?.result?.trace_summary.total_timing_ms ?? null;
  const appTotal = appRun?.result?.trace_summary.total_timing_ms ?? null;

  const headline = (() => {
    if (llmTotal != null && appTotal != null) {
      const delta = appTotal - llmTotal;
      const absDelta = Math.abs(delta);
      const ratio = delta === 0 ? 1 : appTotal / llmTotal;
      if (Math.abs(delta) < 5) return 'App and LLM came in within a hair of each other.';
      if (delta > 0) {
        return `App is ${fmtMs(absDelta)} slower than bare LLM (${ratio.toFixed(2)}× the latency).`;
      }
      return `App is ${fmtMs(absDelta)} faster than bare LLM (${(1 / ratio).toFixed(2)}× speedup).`;
    }
    return 'Synthesis is partial — at least one row is still missing.';
  })();

  const appBreakdown = appRun?.result ? computeStageBreakdown(appRun.result) : [];
  const appTotalBreakdown = appBreakdown.reduce((s, b) => s + b.ms, 0);
  const topStage = appBreakdown.slice().sort((a, b) => b.ms - a.ms)[0] ?? null;

  const appUsedLlm = appRun?.result?.request_spec.llm_used ?? false;
  const appReason = appRun?.result?.request_spec.llm_reason ?? null;
  const appCapability = (() => {
    if (!appRun?.result) return null;
    if (appRun.result.fast_lane.matched) return `fast_lane · ${appRun.result.fast_lane.capability ?? 'unknown'}`;
    const primary = appRun.result.request_spec.chunks.find((c) => c.role === 'primary_request');
    return primary?.capability ?? null;
  })();

  return (
    <div className="space-y-3 rounded-lg border border-border/30 bg-background/30 p-3">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        <Sparkles size={11} />
        Synthesis
      </div>
      <div className="text-sm text-foreground">{headline}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border border-border/30 bg-card/40 p-2 text-[11px]">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            LLM (bare)
          </div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums">
            {llmTotal != null ? fmtMs(llmTotal) : '—'}
          </div>
          <div className="mt-1 text-muted-foreground">
            No parsing, routing, or memory — just the model.
          </div>
        </div>
        <div className="rounded-md border border-border/30 bg-card/40 p-2 text-[11px]">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            App (full pipeline)
          </div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums">
            {appTotal != null ? fmtMs(appTotal) : '—'}
          </div>
          <div className="mt-1 text-muted-foreground">
            {appUsedLlm ? 'Ran the LLM' : 'Skipped the LLM'}
            {appReason ? ` · ${appReason}` : ''}
            {appCapability ? ` · ${appCapability}` : ''}
          </div>
        </div>
      </div>

      {appBreakdown.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            <span>App time by stage</span>
            {topStage && (
              <span className="normal-case tracking-normal text-muted-foreground">
                Heaviest stage:{' '}
                <span className="font-mono text-foreground/80">
                  {topStage.label} ({fmtMs(topStage.ms)})
                </span>
              </span>
            )}
          </div>
          <div className="flex h-4 w-full overflow-hidden rounded bg-card/40">
            {appBreakdown.map((seg) => {
              const pct = (seg.ms / Math.max(1, appTotalBreakdown)) * 100;
              return (
                <div
                  key={seg.groupKey}
                  className={seg.color}
                  style={{ width: `${pct}%` }}
                  title={`${seg.label}: ${fmtMs(seg.ms)} (${pct.toFixed(0)}%)`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            {appBreakdown.map((seg) => (
              <span key={seg.groupKey} className="inline-flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-sm ${seg.legendColor}`} />
                <span>{seg.label}</span>
                <span className="font-mono text-foreground/80">{fmtMs(seg.ms)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Matrix mode — same row layout as Single, averaged across N prompts.
// ---------------------------------------------------------------------------

interface MatrixModeProps {
  systemInfo: SystemInfo | null;
  variants: BenchmarkVariant[];
  warming: boolean;
  onError: (message: string | null) => void;
}

const MATRIX_LIMIT = 200;

const MATRIX_VARIANT_TO_LLM_MODE: Record<
  string,
  'raw_llm' | 'auto' | 'system_only' | 'force_llm'
> = {
  llm: 'raw_llm',
  app: 'auto',
};

interface VariantAggregate {
  variant: BenchmarkVariant;
  cfg: MatrixConfigResult | null;
  avgBreakdown: StageBreakdown[];
  avgTotalBreakdown: number;
  sampleCapability: string | null;
  sampleLlmUsed: boolean;
  sampleLlmModel: string | null;
  sampleFastLaneMatched: boolean;
}

const buildVariantAggregate = (
  variant: BenchmarkVariant,
  cfg: MatrixConfigResult | null,
): VariantAggregate => {
  if (!cfg || cfg.runs.length === 0) {
    return {
      variant,
      cfg,
      avgBreakdown: [],
      avgTotalBreakdown: 0,
      sampleCapability: null,
      sampleLlmUsed: false,
      sampleLlmModel: null,
      sampleFastLaneMatched: false,
    };
  }
  const sumByGroup = new Map<string, { label: string; color: string; legendColor: string; ms: number }>();
  let validCount = 0;
  for (const run of cfg.runs) {
    if (run.error) continue;
    validCount += 1;
    const perRun = computeStageBreakdownFromSteps(run.trace_steps ?? []);
    for (const seg of perRun) {
      const cur = sumByGroup.get(seg.groupKey);
      if (cur) {
        cur.ms += seg.ms;
      } else {
        sumByGroup.set(seg.groupKey, {
          label: seg.label,
          color: seg.color,
          legendColor: seg.legendColor,
          ms: seg.ms,
        });
      }
    }
  }
  const denom = Math.max(1, validCount);
  const avgBreakdown: StageBreakdown[] = Array.from(sumByGroup.entries()).map(([groupKey, seg]) => ({
    groupKey,
    label: seg.label,
    color: seg.color,
    legendColor: seg.legendColor,
    ms: seg.ms / denom,
  }));
  avgBreakdown.sort((a, b) => {
    const order = STAGE_GROUPS.findIndex((g) => g.key === a.groupKey);
    const orderB = STAGE_GROUPS.findIndex((g) => g.key === b.groupKey);
    return (order === -1 ? 99 : order) - (orderB === -1 ? 99 : orderB);
  });
  const avgTotalBreakdown = avgBreakdown.reduce((s, b) => s + b.ms, 0);
  const sample = cfg.runs.find((r) => !r.error) ?? null;
  return {
    variant,
    cfg,
    avgBreakdown,
    avgTotalBreakdown,
    sampleCapability: sample?.capability ?? null,
    sampleLlmUsed: sample?.llm_used ?? false,
    sampleLlmModel: sample?.llm_model ?? null,
    sampleFastLaneMatched: sample?.fast_lane_matched ?? false,
  };
};

const MatrixMode: React.FC<MatrixModeProps> = ({
  variants,
  warming,
  onError,
}) => {
  const [corpus, setCorpus] = useState<BenchmarkCorpusCategory[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<Record<string, boolean>>({});
  const [promptLimit, setPromptLimit] = useState<number>(20);
  const [iterations, setIterations] = useState<number>(1);
  const [result, setResult] = useState<MatrixResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [openVariantId, setOpenVariantId] = useState<string | null>(null);

  useEffect(() => {
    void getBenchmarkCorpus()
      .then((data) => {
        setCorpus(data.categories);
        // Pre-select every bundled fixture category so the tab becomes a
        // one-click "run the fixtures" button.
        const defaultSel: Record<string, boolean> = {};
        for (const entry of data.categories) defaultSel[entry.category] = true;
        setSelectedCategories(defaultSel);
      })
      .catch(() => onError('Failed to load benchmark corpus'));
  }, [onError]);

  const selectedPrompts = useMemo<BenchmarkCorpusPrompt[]>(() => {
    const out: BenchmarkCorpusPrompt[] = [];
    for (const entry of corpus) {
      if (!selectedCategories[entry.category]) continue;
      const pool = entry.prompts.slice(0, Math.max(1, promptLimit));
      for (const p of pool) out.push({ ...p, category: entry.category });
    }
    const expanded: BenchmarkCorpusPrompt[] = [];
    for (let i = 0; i < Math.max(1, iterations); i++) {
      for (const p of out) {
        expanded.push({ ...p, id: iterations > 1 ? `${p.id}#${i + 1}` : p.id });
      }
    }
    return expanded;
  }, [corpus, selectedCategories, promptLimit, iterations]);

  const totalCells = selectedPrompts.length * variants.length;
  const overLimit = totalCells > MATRIX_LIMIT;

  const handleRun = async () => {
    if (selectedPrompts.length === 0) {
      onError('Pick at least one category first.');
      return;
    }
    if (overLimit) {
      onError(`That grid is ${totalCells} runs — hard cap is ${MATRIX_LIMIT}.`);
      return;
    }
    setRunning(true);
    onError(null);
    setProgress(
      `Running ${totalCells} cells (${variants.length} rows × ${selectedPrompts.length} prompts)…`,
    );
    try {
      const configInputs: MatrixConfigInput[] = variants.map((variant) => ({
        label: variant.id,
        llm_mode: MATRIX_VARIANT_TO_LLM_MODE[variant.id] ?? 'auto',
        llm_model_override: variant.options.llm_model_override ?? null,
        reasoning_mode: variant.options.reasoning_mode ?? 'auto',
        user_mode_override: variant.options.user_mode_override ?? null,
        voice_id: variant.options.voice_id ?? null,
      }));
      const response = await runBenchmarkMatrix(selectedPrompts, configInputs);
      setResult(response);
      setProgress(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Matrix run failed.');
      setProgress(null);
    } finally {
      setRunning(false);
    }
  };

  const aggregates = useMemo<VariantAggregate[]>(() => {
    const byLabel = new Map((result?.configs ?? []).map((c) => [c.label, c]));
    return variants.map((variant) => buildVariantAggregate(variant, byLabel.get(variant.id) ?? null));
  }, [variants, result]);

  const fastestVariantId = useMemo(() => {
    const withStats = aggregates.filter((a) => a.cfg && a.cfg.stats.count > 0);
    if (withStats.length === 0) return null;
    return withStats.reduce((best, cur) => {
      if (!best) return cur.variant.id;
      const prev = withStats.find((a) => a.variant.id === best);
      if (!prev || !prev.cfg || !cur.cfg) return cur.variant.id;
      return cur.cfg.stats.p50_ms < prev.cfg.stats.p50_ms ? cur.variant.id : best;
    }, null as string | null);
  }, [aggregates]);

  const maxP50 = useMemo(() => {
    return Math.max(1, ...aggregates.map((a) => a.cfg?.stats.p50_ms ?? 0));
  }, [aggregates]);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/30 bg-background/30 p-3">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          <Grid3x3 size={11} />
          Categories
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {corpus.length === 0 && (
            <span className="text-[11px] text-muted-foreground">Loading corpus…</span>
          )}
          {corpus.map((entry) => {
            const active = selectedCategories[entry.category] ?? false;
            return (
              <button
                key={entry.category}
                onClick={() =>
                  setSelectedCategories((prev) => ({
                    ...prev,
                    [entry.category]: !prev[entry.category],
                  }))
                }
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all ${
                  active
                    ? 'border-primary/40 bg-primary/15 text-primary'
                    : 'border-border/40 bg-card/40 text-muted-foreground hover:border-primary/30 hover:text-foreground'
                }`}
                title={entry.description}
              >
                <span className="capitalize">{entry.category}</span>
                <span className="text-[9px] opacity-70">{entry.prompt_count}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px]">
          <label className="inline-flex items-center gap-2">
            <span className="uppercase tracking-widest text-muted-foreground">Prompts/category</span>
            <input
              type="number"
              min={1}
              max={20}
              value={promptLimit}
              onChange={(e) => setPromptLimit(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-16 rounded border border-border/40 bg-background/60 px-2 py-0.5 text-xs"
            />
          </label>
          <label className="inline-flex items-center gap-2">
            <span className="uppercase tracking-widest text-muted-foreground">Iterations</span>
            <input
              type="number"
              min={1}
              max={5}
              value={iterations}
              onChange={(e) => setIterations(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-16 rounded border border-border/40 bg-background/60 px-2 py-0.5 text-xs"
            />
          </label>
          <button
            onClick={() => void handleRun()}
            disabled={running || warming || totalCells === 0 || overLimit}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-white transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            title={warming ? 'Waiting for the selected model to load into engine RAM…' : undefined}
          >
            <Play size={11} />
            {running ? 'Running…' : warming ? 'Warming…' : `Run (${totalCells})`}
          </button>
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className="text-muted-foreground">Cells:</span>
            <span className={overLimit ? 'font-bold text-red-300' : 'font-bold text-foreground'}>
              {totalCells}
            </span>
            <span className="text-muted-foreground">/ {MATRIX_LIMIT}</span>
          </div>
        </div>
        {(progress || overLimit) && (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
            {progress && <span className="text-muted-foreground">{progress}</span>}
            {overLimit && (
              <span className="inline-flex items-center gap-1 text-red-300">
                <AlertTriangle size={11} />
                Over limit — shrink categories or iterations.
              </span>
            )}
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border/30 bg-card/20">
        {aggregates.map((agg, rowIdx) => {
          const { variant, cfg, avgBreakdown, avgTotalBreakdown } = agg;
          const isDone = !!cfg && cfg.stats.count > 0;
          const isCurrent = running && !isDone;
          const isIdle = !running && !cfg;
          const isOpen = openVariantId === variant.id;
          const p50 = cfg?.stats.p50_ms ?? 0;
          const best = isDone && variant.id === fastestVariantId;
          const relative = Math.max(1.5, (p50 / maxP50) * 100);
          const accuracyTone = (() => {
            if (!cfg || cfg.stats.graded_count === 0) return 'text-muted-foreground/60';
            const r = cfg.stats.accuracy_rate;
            return r >= 0.8 ? 'text-emerald-300' : r >= 0.5 ? 'text-amber-300' : 'text-red-300';
          })();

          return (
            <div key={variant.id} className={rowIdx > 0 ? 'border-t border-border/20' : ''}>
              <div
                className={`flex items-center gap-3 px-3 py-2 transition-colors ${
                  best ? 'bg-emerald-400/5' : isCurrent ? 'bg-primary/5' : ''
                } ${isIdle ? 'opacity-50' : ''}`}
              >
                <div className="flex w-32 shrink-0 items-center gap-1.5">
                  {best ? (
                    <Zap size={11} className="shrink-0 text-emerald-400" />
                  ) : isCurrent ? (
                    <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
                  ) : (
                    <span className="w-[11px]" />
                  )}
                  <span className="truncate text-xs font-bold" title={variant.blurb}>
                    {variant.title}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {STAGE_ORDER.map((stage) => {
                    const state = variant.stages[stage];
                    const { Icon, label } = STAGE_META[stage];
                    const tone =
                      state === 'on'
                        ? 'bg-primary/15 text-primary'
                        : state === 'auto'
                          ? 'bg-amber-400/10 text-amber-300 ring-1 ring-dashed ring-amber-400/40'
                          : 'bg-card/40 text-muted-foreground/40';
                    const title =
                      state === 'on'
                        ? `${label} · on`
                        : state === 'auto'
                          ? `${label} · auto`
                          : `${label} · off`;
                    return (
                      <span
                        key={stage}
                        title={title}
                        className={`flex h-5 w-5 items-center justify-center rounded ${tone}`}
                      >
                        <Icon size={10} />
                      </span>
                    );
                  })}
                </div>
                <div
                  className={`relative h-6 flex-1 overflow-hidden rounded bg-card/40 ${
                    isCurrent ? 'animate-pulse ring-1 ring-primary/40' : ''
                  }`}
                >
                  {isDone && avgBreakdown.length > 0 && (
                    <div
                      className="absolute inset-y-0 left-0 flex overflow-hidden rounded"
                      style={{ width: `${relative}%` }}
                    >
                      {avgBreakdown.map((seg) => {
                        const pct = (seg.ms / Math.max(1, avgTotalBreakdown)) * 100;
                        return (
                          <div
                            key={seg.groupKey}
                            className={seg.color}
                            style={{ width: `${pct}%` }}
                            title={`${seg.label}: ${fmtMs(seg.ms)} avg`}
                          />
                        );
                      })}
                    </div>
                  )}
                  {isCurrent && !isDone && (
                    <div className="absolute inset-y-0 left-0 right-0 animate-pulse bg-primary/25" />
                  )}
                </div>
                <div
                  className={`w-16 shrink-0 text-right font-mono text-sm font-bold tabular-nums ${
                    best
                      ? 'text-emerald-300'
                      : isDone
                        ? 'text-foreground'
                        : 'text-muted-foreground/40'
                  }`}
                  title={
                    cfg
                      ? `p50 ${fmtMs(cfg.stats.p50_ms)} · mean ${fmtMs(cfg.stats.mean_ms)} · p95 ${fmtMs(cfg.stats.p95_ms)}`
                      : undefined
                  }
                >
                  {isDone ? fmtMs(p50) : isCurrent ? '…' : '—'}
                </div>
                <div
                  className={`w-20 shrink-0 text-right font-mono text-[11px] tabular-nums ${accuracyTone}`}
                  title={
                    cfg && cfg.stats.graded_count > 0
                      ? `${cfg.stats.correct_count}/${cfg.stats.graded_count} graded`
                      : 'No graded prompts'
                  }
                >
                  {cfg && cfg.stats.graded_count > 0 ? (
                    <>
                      <span className="font-bold">{fmtPct(cfg.stats.accuracy_rate)}</span>
                      <span className="ml-1 text-muted-foreground">
                        {cfg.stats.correct_count}/{cfg.stats.graded_count}
                      </span>
                    </>
                  ) : (
                    <span>—</span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => isDone && setOpenVariantId(isOpen ? null : variant.id)}
                    disabled={!isDone}
                    className="inline-flex items-center rounded border border-border/40 bg-card/50 px-1.5 py-0.5 text-muted-foreground transition-all hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-30"
                    title="Show per-prompt runs"
                  >
                    <ChevronDown
                      size={11}
                      className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                </div>
              </div>
              {isOpen && cfg && (
                <div className="space-y-2 border-t border-border/20 bg-background/40 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                    <span>
                      prompts: <span className="font-mono text-foreground/80">{cfg.runs.length}</span>
                    </span>
                    <span>
                      errors:{' '}
                      <span
                        className={`font-mono ${cfg.stats.errors > 0 ? 'text-red-300' : 'text-foreground/80'}`}
                      >
                        {cfg.stats.errors}
                      </span>
                    </span>
                    <span>
                      fast-lane:{' '}
                      <span className="font-mono text-foreground/80">
                        {cfg.runs.filter((r) => r.fast_lane_matched).length}/{cfg.runs.length}
                      </span>
                    </span>
                    <span>
                      p50 <span className="font-mono text-foreground/80">{fmtMs(cfg.stats.p50_ms)}</span>{' '}
                      · p95 <span className="font-mono text-foreground/80">{fmtMs(cfg.stats.p95_ms)}</span>{' '}
                      · mean <span className="font-mono text-foreground/80">{fmtMs(cfg.stats.mean_ms)}</span>
                    </span>
                  </div>
                  <CategoryHeatmap cfg={cfg} />
                  <RunList cfg={cfg} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <MatrixSynthesis aggregates={aggregates} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Matrix synthesis — LLM vs App comparison across all N prompts.
// ---------------------------------------------------------------------------

const MatrixSynthesis: React.FC<{ aggregates: VariantAggregate[] }> = ({ aggregates }) => {
  const hasAny = aggregates.some((a) => a.cfg && a.cfg.stats.count > 0);
  if (!hasAny) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 bg-background/20 px-3 py-4 text-center text-[11px] text-muted-foreground">
        Run the matrix to see a synthesis of the results here.
      </div>
    );
  }

  const llm = aggregates.find((a) => a.variant.id === 'llm') ?? null;
  const app = aggregates.find((a) => a.variant.id === 'app') ?? null;
  const llmP50 = llm?.cfg?.stats.p50_ms ?? null;
  const appP50 = app?.cfg?.stats.p50_ms ?? null;

  const headline = (() => {
    if (llmP50 != null && appP50 != null) {
      const delta = appP50 - llmP50;
      const absDelta = Math.abs(delta);
      const ratio = delta === 0 ? 1 : appP50 / llmP50;
      if (Math.abs(delta) < 5) return 'App and LLM came in within a hair of each other (p50).';
      if (delta > 0) {
        return `App is ${fmtMs(absDelta)} slower than bare LLM at p50 (${ratio.toFixed(2)}× the latency).`;
      }
      return `App is ${fmtMs(absDelta)} faster than bare LLM at p50 (${(1 / ratio).toFixed(2)}× speedup).`;
    }
    return 'Synthesis is partial — at least one row is still missing.';
  })();

  const appBreakdown = app?.avgBreakdown ?? [];
  const appTotalBreakdown = app?.avgTotalBreakdown ?? 0;
  const topStage = appBreakdown.slice().sort((a, b) => b.ms - a.ms)[0] ?? null;

  const renderAccuracy = (agg: VariantAggregate | null) => {
    if (!agg?.cfg || agg.cfg.stats.graded_count === 0) {
      return <span className="text-muted-foreground/60">n/a</span>;
    }
    const r = agg.cfg.stats.accuracy_rate;
    const tone = r >= 0.8 ? 'text-emerald-300' : r >= 0.5 ? 'text-amber-300' : 'text-red-300';
    return (
      <>
        <span className={`font-bold ${tone}`}>{fmtPct(r)}</span>
        <span className="ml-1 text-muted-foreground">
          ({agg.cfg.stats.correct_count}/{agg.cfg.stats.graded_count})
        </span>
      </>
    );
  };

  return (
    <div className="space-y-3 rounded-lg border border-border/30 bg-background/30 p-3">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        <Sparkles size={11} />
        Synthesis
      </div>
      <div className="text-sm text-foreground">{headline}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border border-border/30 bg-card/40 p-2 text-[11px]">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            LLM (bare) — p50
          </div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums">
            {llmP50 != null ? fmtMs(llmP50) : '—'}
          </div>
          <div className="mt-1 text-muted-foreground">
            No parsing, routing, or memory — just the model.
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>Accuracy:</span>
            <span className="font-mono">{renderAccuracy(llm)}</span>
          </div>
        </div>
        <div className="rounded-md border border-border/30 bg-card/40 p-2 text-[11px]">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            App (full pipeline) — p50
          </div>
          <div className="mt-1 font-mono text-lg font-bold tabular-nums">
            {appP50 != null ? fmtMs(appP50) : '—'}
          </div>
          <div className="mt-1 text-muted-foreground">
            {app?.sampleFastLaneMatched
              ? 'Fast-lane engaged on at least one prompt'
              : app?.sampleLlmUsed
                ? 'Ran the LLM on the sampled prompt'
                : 'Pipeline completed'}
            {app?.sampleCapability ? ` · ${app.sampleCapability}` : ''}
            {app?.sampleLlmModel ? ` · ${app.sampleLlmModel}` : ''}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>Accuracy:</span>
            <span className="font-mono">{renderAccuracy(app)}</span>
          </div>
        </div>
      </div>

      {appBreakdown.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            <span>App time by stage (avg per prompt)</span>
            {topStage && (
              <span className="normal-case tracking-normal text-muted-foreground">
                Heaviest stage:{' '}
                <span className="font-mono text-foreground/80">
                  {topStage.label} ({fmtMs(topStage.ms)})
                </span>
              </span>
            )}
          </div>
          <div className="flex h-4 w-full overflow-hidden rounded bg-card/40">
            {appBreakdown.map((seg) => {
              const pct = (seg.ms / Math.max(1, appTotalBreakdown)) * 100;
              return (
                <div
                  key={seg.groupKey}
                  className={seg.color}
                  style={{ width: `${pct}%` }}
                  title={`${seg.label}: ${fmtMs(seg.ms)} (${pct.toFixed(0)}%)`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            {appBreakdown.map((seg) => (
              <span key={seg.groupKey} className="inline-flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-sm ${seg.legendColor}`} />
                <span>{seg.label}</span>
                <span className="font-mono text-foreground/80">{fmtMs(seg.ms)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// Per-config breakdown by category + run list
const CategoryHeatmap: React.FC<{ cfg: MatrixConfigResult }> = ({ cfg }) => {
  const byCat = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const run of cfg.runs) {
      if (run.error) continue;
      const key = run.category || 'uncategorized';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(run.total_timing_ms);
    }
    return Array.from(map.entries()).map(([category, timings]) => {
      const sorted = [...timings].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)] || 0;
      const mean = timings.reduce((s, v) => s + v, 0) / (timings.length || 1);
      return { category, count: timings.length, p50, mean };
    });
  }, [cfg]);

  if (byCat.length === 0) return null;

  const maxP50 = Math.max(...byCat.map((c) => c.p50), 1);
  return (
    <div className="mb-3">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        By category (p50 latency)
      </div>
      <div className="space-y-1">
        {byCat.map((entry) => (
          <div key={entry.category} className="flex items-center gap-2 text-[11px]">
            <div className="w-24 truncate font-mono text-muted-foreground">{entry.category}</div>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-card/40">
              <div
                className="h-full bg-primary/60"
                style={{ width: `${(entry.p50 / maxP50) * 100}%` }}
              />
            </div>
            <div className="w-14 text-right font-mono">{fmtMs(entry.p50)}</div>
            <div className="w-10 text-right font-mono text-muted-foreground">n={entry.count}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const RunList: React.FC<{ cfg: MatrixConfigResult }> = ({ cfg }) => {
  // Sort so the failed/incorrect runs float to the top — that's the
  // signal the user actually wants to eyeball after a grading pass.
  // Graded+incorrect first, then errors, then the rest by desc latency.
  const sorted = useMemo(() => {
    const score = (r: MatrixRun) => {
      if (r.graded && r.correct === false) return 0;
      if (r.error) return 1;
      if (!r.graded) return 2;
      return 3;
    };
    return [...cfg.runs].sort((a, b) => {
      const diff = score(a) - score(b);
      if (diff !== 0) return diff;
      return b.total_timing_ms - a.total_timing_ms;
    });
  }, [cfg]);
  return (
    <div className="max-h-96 overflow-y-auto rounded border border-border/20">
      <table className="w-full text-[10px]">
        <thead className="sticky top-0 bg-background/80 uppercase tracking-widest text-muted-foreground">
          <tr>
            <th className="w-6 px-2 py-1" />
            <th className="px-2 py-1 text-left">Prompt</th>
            <th className="px-2 py-1 text-left">Category</th>
            <th className="px-2 py-1 text-right">ms</th>
            <th className="px-2 py-1 text-left">Answer</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((run) => {
            const gradedBadge = (() => {
              if (!run.graded) {
                return (
                  <span
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-card/40 text-[9px] text-muted-foreground"
                    title="Ungraded — no expected keywords"
                  >
                    –
                  </span>
                );
              }
              if (run.correct) {
                return (
                  <span
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300"
                    title={`Matched: ${run.matches.join(', ')}`}
                  >
                    <Check size={10} />
                  </span>
                );
              }
              return (
                <span
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-400/15 text-red-300"
                  title={
                    run.expected
                      ? `Expected any of: ${run.expected.any_of.join(', ')}` +
                        (run.min_match > 1 ? ` (min ${run.min_match})` : '')
                      : 'Incorrect'
                  }
                >
                  <XIcon size={10} />
                </span>
              );
            })();
            return (
              <tr key={run.prompt_id} className="border-t border-border/10 align-top">
                <td className="px-2 py-1">{gradedBadge}</td>
                <td className="max-w-[280px] px-2 py-1 font-mono" title={run.prompt}>
                  <div className="truncate font-bold text-foreground/80">{run.prompt_id}</div>
                  <div className="truncate text-muted-foreground">{run.prompt}</div>
                </td>
                <td className="px-2 py-1 font-mono text-muted-foreground">
                  {run.category || '—'}
                </td>
                <td
                  className={`px-2 py-1 text-right font-mono ${
                    run.error ? 'text-red-300' : ''
                  }`}
                >
                  {fmtMs(run.total_timing_ms)}
                </td>
                <td className="max-w-[480px] px-2 py-1">
                  {run.error ? (
                    <span className="text-red-300">{run.error}</span>
                  ) : (
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-1">
                        {run.fast_lane_matched && (
                          <span className="rounded border border-cyan-400/20 bg-cyan-400/10 px-1 py-0 text-[9px] text-cyan-300">
                            fast
                          </span>
                        )}
                        {run.llm_used && (
                          <span className="rounded border border-primary/20 bg-primary/10 px-1 py-0 text-[9px] text-primary">
                            llm
                            {run.llm_model ? ` · ${run.llm_model}` : ''}
                          </span>
                        )}
                        {run.capability && (
                          <span className="rounded border border-border/30 bg-background/40 px-1 py-0 text-[9px] text-muted-foreground">
                            {run.capability}
                          </span>
                        )}
                      </div>
                      <div
                        className="whitespace-pre-wrap break-words text-foreground/90"
                        title={run.output_text || '(empty)'}
                      >
                        {run.output_text || (
                          <span className="italic text-muted-foreground">empty</span>
                        )}
                      </div>
                      {run.graded && !run.correct && run.expected && (
                        <div className="text-[9px] text-red-300/90">
                          expected any of:{' '}
                          <span className="font-mono">
                            {run.expected.any_of.join(' · ')}
                          </span>
                          {run.min_match > 1 ? ` (min ${run.min_match})` : ''}
                        </div>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

const PipelineRunner: React.FC = () => {
  const [activeTab, setActiveTab] = useState<DevTab>('benchmark');
  const [mode, setMode] = useState<BenchmarkMode>('single');
  const [message, setMessage] = useState(DEFAULT_PROMPT);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedVoice, setSelectedVoice] = useState('');
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>('fast');
  const [responseMode, setResponseMode] = useState<ResponseMode>('rich');
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [needPreference, setNeedPreference] = useState(true);
  const [needSocial, setNeedSocial] = useState(true);
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [currentVariantId, setCurrentVariantId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedRunId, setCopiedRunId] = useState<string | null>(null);
  const [memoryRefreshNonce, setMemoryRefreshNonce] = useState(0);
  // Warm-state: the local LLM engine only warms the fast model at boot;
  // any other model loads synchronously on first inference and can stall
  // a benchmark by 30s+. We fire a 1-token completion after the user
  // picks a model and gate the Run buttons on it so the reported timings
  // reflect steady-state rather than cold-load cost.
  const [warmedModel, setWarmedModel] = useState<string | null>(null);
  const [warming, setWarming] = useState(false);
  const [warmLatencyMs, setWarmLatencyMs] = useState<number | null>(null);
  const [warmError, setWarmError] = useState<string | null>(null);

  useEffect(() => {
    void getSystemInfo()
      .then((info) => {
        setSystemInfo(info);
        setSelectedModel(info.thinking_model || info.fast_model || '');
      })
      .catch(() => {});
    void fetch('/api/v1/audio/voices', { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const voices = (data?.voices ?? []) as VoiceOption[];
        setVoiceOptions(voices);
        if (voices.length > 0) {
          setSelectedVoice((current) => current || voices[0].voice_id);
        }
      })
      .catch(() => {});
  }, []);

  // Warm the engine every time the user picks a model. We keep the
  // last successfully-warmed name in state so we don't re-warm on every
  // re-render, but we DO re-warm when the user switches back to a
  // model they previously warmed — the engine only keeps one model
  // resident, so returning to an old choice means it was evicted.
  useEffect(() => {
    if (!selectedModel) return;
    let cancelled = false;
    setWarming(true);
    setWarmError(null);
    setWarmLatencyMs(null);
    setWarmedModel(null);
    void warmLlmModel(selectedModel)
      .then((res) => {
        if (cancelled) return;
        setWarmLatencyMs(res.latency_ms);
        if (res.ok) {
          setWarmedModel(res.model);
        } else {
          setWarmError(res.error || 'Warm failed.');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setWarmError(err instanceof Error ? err.message : 'Warm failed.');
      })
      .finally(() => {
        if (!cancelled) setWarming(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedModel]);

  const variants = useMemo<BenchmarkVariant[]>(() => {
    const shared: Pick<PipelineRunOptions, 'memory_enabled' | 'need_preference' | 'need_social' | 'voice_id'> = {
      memory_enabled: memoryEnabled,
      need_preference: needPreference,
      need_social: needSocial,
      voice_id: selectedVoice || undefined,
    };
    return [
      {
        id: 'llm',
        title: 'LLM',
        blurb: 'Bare model — prompt goes straight to the LLM, no pipeline',
        stages: { parse: 'off', route: 'off', skill: 'off', llm: 'on' },
        options: {
          ...shared,
          memory_enabled: false,
          benchmark_label: 'llm',
          llm_mode: 'raw_llm',
          llm_model_override: selectedModel || undefined,
          reasoning_mode: reasoningMode,
        },
      },
      {
        id: 'app',
        title: 'App',
        blurb: 'Full pipeline — parse, route, skill, synthesis (LLM auto-decides)',
        stages: { parse: 'on', route: 'on', skill: 'on', llm: 'auto' },
        options: {
          ...shared,
          benchmark_label: 'app',
          llm_mode: 'auto',
          llm_model_override: selectedModel || undefined,
          reasoning_mode: reasoningMode,
          user_mode_override: responseMode,
        },
      },
    ];
  }, [memoryEnabled, needPreference, needSocial, selectedVoice, selectedModel, reasoningMode, responseMode]);

  useEffect(() => {
    // Keep the planned rows in sync with the current variant config whenever
    // the user is not in the middle of a run. This means the two rows show
    // up greyed-out before the first run, and the stage icons reflect the
    // current toolbar settings.
    if (running) return;
    setRuns((prev) => {
      const byId = new Map(prev.map((r) => [r.variant.id, r]));
      return variants.map((variant) => {
        const existing = byId.get(variant.id);
        if (existing && existing.status === 'done') {
          return { ...existing, variant };
        }
        return { variant, status: 'idle', result: null };
      });
    });
  }, [variants, running]);

  const handleCopyRun = async (run: BenchmarkRun) => {
    if (!run.result) return;
    const payload = [
      `# ${run.variant.title}`,
      `Prompt: ${message}`,
      `Total: ${run.result.trace_summary.total_timing_ms.toFixed(2)} ms`,
      `LLM: ${run.result.request_spec.llm_used ? run.result.request_spec.llm_model ?? 'stub' : 'off'}`,
      `Reason: ${run.result.request_spec.llm_reason ?? 'n/a'}`,
      '',
      '## Response',
      run.result.response.output_text || '(empty)',
      '',
      '## Trace',
      ...run.result.trace.steps.map(
        (s) => `- ${s.name} [${s.status}] ${s.timing_ms.toFixed(2)} ms`,
      ),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedRunId(run.variant.id);
      window.setTimeout(() => setCopiedRunId(null), 1500);
    } catch (copyErr) {
      setError(copyErr instanceof Error ? `Copy failed: ${copyErr.message}` : 'Copy failed.');
    }
  };

  const runSingleBenchmark = async () => {
    setRunning(true);
    setError(null);
    // Seed all variants as pending so the rows stay visible during the run.
    setRuns(variants.map((variant) => ({ variant, status: 'idle', result: null })));
    try {
      for (const variant of variants) {
        setCurrentVariantId(variant.id);
        setRuns((prev) =>
          prev.map((r) =>
            r.variant.id === variant.id ? { ...r, status: 'running', result: null } : r,
          ),
        );
        try {
          const result = await runPipeline(message, variant.options);
          setRuns((prev) =>
            prev.map((r) =>
              r.variant.id === variant.id ? { variant, status: 'done', result } : r,
            ),
          );
        } catch (variantError) {
          const msg = variantError instanceof Error ? variantError.message : 'Variant failed.';
          setRuns((prev) =>
            prev.map((r) =>
              r.variant.id === variant.id
                ? { variant, status: 'error', result: null, error: msg }
                : r,
            ),
          );
          setError(msg);
        }
      }
      if (memoryEnabled) setMemoryRefreshNonce((v) => v + 1);
    } finally {
      setCurrentVariantId(null);
      setRunning(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/30 bg-card/50 p-3 shadow-m1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex gap-1 rounded-md border border-border/30 bg-background/40 p-0.5">
          {(['benchmark', 'skills'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-bold transition-all ${
                activeTab === t
                  ? 'bg-primary text-white'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'benchmark' ? <Gauge size={11} /> : <Wrench size={11} />}
              {t === 'benchmark' ? 'Benchmark' : 'Skills'}
            </button>
          ))}
        </div>
        {activeTab === 'benchmark' && (
          <div className="inline-flex gap-1 rounded-md border border-border/30 bg-background/40 p-0.5">
            {(['single', 'matrix'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-bold transition-all ${
                  mode === m
                    ? 'bg-primary text-white'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'single' ? <Zap size={11} /> : <Grid3x3 size={11} />}
                {m === 'single' ? 'Single' : 'Matrix'}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeTab === 'skills' ? (
        <div className="mt-3">
          <DevSkillsExplorer />
        </div>
      ) : (
        <>
          <div className="mt-3">
            <BenchmarkToolbar
              systemInfo={systemInfo}
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              reasoningMode={reasoningMode}
              setReasoningMode={setReasoningMode}
              responseMode={responseMode}
              setResponseMode={setResponseMode}
              selectedVoice={selectedVoice}
              setSelectedVoice={setSelectedVoice}
              voiceOptions={voiceOptions}
            />
          </div>

          <WarmStatusStrip
            selectedModel={selectedModel}
            warming={warming}
            warmedModel={warmedModel}
            warmLatencyMs={warmLatencyMs}
            warmError={warmError}
          />

          <div className="mt-3">
            {mode === 'single' ? (
              <SingleMode
                message={message}
                setMessage={setMessage}
                running={running}
                warming={warming}
                onRun={() => void runSingleBenchmark()}
                memoryEnabled={memoryEnabled}
                setMemoryEnabled={setMemoryEnabled}
                needPreference={needPreference}
                setNeedPreference={setNeedPreference}
                needSocial={needSocial}
                setNeedSocial={setNeedSocial}
                runs={runs}
                currentVariantId={currentVariantId}
                onCopyRun={handleCopyRun}
                copiedRunId={copiedRunId}
                memoryRefreshNonce={memoryRefreshNonce}
              />
            ) : (
              <MatrixMode
                systemInfo={systemInfo}
                variants={variants}
                warming={warming}
                onError={setError}
              />
            )}
          </div>

          {error && (
            <div className="mt-3 rounded-md border border-red-400/30 bg-red-400/5 px-3 py-2 text-[11px] text-red-300">
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default PipelineRunner;
