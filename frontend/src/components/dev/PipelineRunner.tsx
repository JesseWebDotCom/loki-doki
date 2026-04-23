import React, { useEffect, useState } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Cpu,
  Gauge,
  Mic,
  Play,
  Sparkles,
  Volume2,
  Wrench,
} from 'lucide-react';

import { getSystemInfo, runPipeline } from '../../lib/api';
import type { PipelineRunOptions, PipelineRunResponse } from '../../lib/api';
import type { SystemInfo } from '../../lib/api-types';
import DevSkillsExplorer from './DevSkillsExplorer';
import MemoryPanel from './MemoryPanel';

const SAMPLE_PROMPT = 'Compare whether we should keep deterministic routing or switch to an LLM router on Raspberry Pi 5.';

type DevTab = 'benchmark' | 'skills';
type ReasoningMode = 'auto' | 'fast' | 'thinking';
type ResponseMode = 'standard' | 'rich' | 'deep';

interface VoiceOption {
  voice_id: string;
  display_name: string;
  description: string;
}

interface BenchmarkVariant {
  id: string;
  title: string;
  blurb: string;
  options: PipelineRunOptions;
}

interface BenchmarkRun {
  variant: BenchmarkVariant;
  result: PipelineRunResponse;
}

const buildSourceBadges = (result: PipelineRunResponse): string[] => {
  const badges: string[] = [];

  if (result.fast_lane.matched) {
    badges.push(`fast lane · ${result.fast_lane.capability ?? 'unknown'}`);
    return badges;
  }

  const primaryChunk = result.request_spec.chunks.find((chunk) => chunk.role === 'primary_request');
  const primaryExecution = primaryChunk
    ? result.executions.find((exec) => exec.capability === primaryChunk.capability)
    : result.executions[0];
  const capability = primaryChunk?.capability ?? primaryExecution?.capability ?? 'unknown';
  const handler = primaryChunk?.handler_name ?? primaryExecution?.handler_name ?? '?';
  const confidence = primaryChunk?.confidence;
  const mechanism = primaryExecution?.raw_result?.mechanism_used as string | undefined;
  const success = primaryExecution?.success ?? primaryChunk?.success;
  const outputText = result.response.output_text?.trim() ?? '';

  if (result.request_spec.llm_used) {
    badges.push(`llm · ${result.request_spec.llm_model ?? 'stub'}`);
    badges.push(`reason · ${result.request_spec.llm_reason ?? 'fallback'}`);
    badges.push(`route · ${capability} via ${handler}`);
    if (mechanism) badges.push(`mechanism · ${mechanism}`);
    if (typeof confidence === 'number') badges.push(`confidence · ${(confidence * 100).toFixed(0)}%`);
    return badges;
  }

  if (capability === 'direct_chat') {
    badges.push('direct_chat fallback');
    return badges;
  }

  if (success === false) {
    badges.push(`skill failed · ${capability}`);
    return badges;
  }

  if (!outputText) {
    badges.push(`empty output · ${capability}`);
    return badges;
  }

  badges.push(`skill · ${capability}`);
  badges.push(`handler · ${handler}`);
  if (mechanism) badges.push(`mechanism · ${mechanism}`);
  if (typeof confidence === 'number') badges.push(`confidence · ${(confidence * 100).toFixed(0)}%`);
  return badges;
};

const buildCopyBlob = (
  prompt: string,
  run: BenchmarkRun,
  voiceId: string,
  reasoningMode: ReasoningMode,
  responseMode: ResponseMode,
): string => {
  const lines: string[] = [];
  lines.push(`# benchmark run · ${run.variant.title}`);
  lines.push('');
  lines.push(`Prompt: ${prompt}`);
  lines.push(`Voice: ${voiceId || 'default'}`);
  lines.push(`Reasoning mode: ${reasoningMode}`);
  lines.push(`Response mode: ${responseMode}`);
  lines.push(`Total time: ${run.result.trace_summary.total_timing_ms.toFixed(2)} ms`);
  lines.push(`LLM used: ${run.result.request_spec.llm_used ? 'yes' : 'no'}`);
  lines.push(`LLM model: ${run.result.request_spec.llm_model ?? 'n/a'}`);
  lines.push(`LLM reason: ${run.result.request_spec.llm_reason ?? 'n/a'}`);
  lines.push('');
  lines.push('## Badges');
  for (const badge of buildSourceBadges(run.result)) {
    lines.push(`- ${badge}`);
  }
  lines.push('');
  lines.push('## Response');
  lines.push('```');
  lines.push(run.result.response.output_text || '(empty)');
  lines.push('```');
  lines.push('');
  lines.push('## Trace');
  for (const step of run.result.trace.steps) {
    lines.push(`- ${step.name} [${step.status}] ${step.timing_ms.toFixed(2)} ms`);
  }
  return lines.join('\n');
};

const metricTone = (winner: boolean): string =>
  winner
    ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
    : 'border-border/20 bg-background/40 text-foreground';

const statusClasses: Record<string, string> = {
  done: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  matched: 'border-cyan-400/20 bg-cyan-400/10 text-cyan-300',
  bypassed: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
};

const PipelineRunner: React.FC = () => {
  const [activeTab, setActiveTab] = useState<DevTab>('benchmark');
  const [message, setMessage] = useState(SAMPLE_PROMPT);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedVoice, setSelectedVoice] = useState('');
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>('fast');
  const [responseMode, setResponseMode] = useState<ResponseMode>('rich');
  const [includeAutoBaseline, setIncludeAutoBaseline] = useState(true);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [needPreference, setNeedPreference] = useState(true);
  const [needSocial, setNeedSocial] = useState(true);
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedRunId, setCopiedRunId] = useState<string | null>(null);
  const [memoryRefreshNonce, setMemoryRefreshNonce] = useState(0);

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

  const availableModels = systemInfo?.available_models ?? [];
  const fastestRunId = runs.reduce<string | null>((best, run) => {
    if (!best) return run.variant.id;
    const current = runs.find((entry) => entry.variant.id === best);
    if (!current) return run.variant.id;
    return run.result.trace_summary.total_timing_ms < current.result.trace_summary.total_timing_ms
      ? run.variant.id
      : best;
  }, null);

  const buildVariants = (): BenchmarkVariant[] => {
    const responseOverride = responseMode === 'standard' ? 'standard' : responseMode;
    const shared: Pick<PipelineRunOptions, 'memory_enabled' | 'need_preference' | 'need_social' | 'voice_id'> = {
      memory_enabled: memoryEnabled,
      need_preference: needPreference,
      need_social: needSocial,
      voice_id: selectedVoice || undefined,
    };

    const variants: BenchmarkVariant[] = [
      {
        id: 'system',
        title: 'System Only',
        blurb: 'Deterministic path only. No synthesis LLM.',
        options: {
          ...shared,
          benchmark_label: 'system_only',
          llm_mode: 'system_only',
          reasoning_mode: 'fast',
          user_mode_override: 'standard',
        },
      },
      {
        id: 'llm',
        title: 'Forced LLM',
        blurb: 'Always synthesize with the selected model.',
        options: {
          ...shared,
          benchmark_label: 'force_llm',
          llm_mode: 'force_llm',
          llm_model_override: selectedModel || undefined,
          reasoning_mode: reasoningMode,
          user_mode_override: responseOverride,
        },
      },
    ];

    if (includeAutoBaseline) {
      variants.push({
        id: 'auto',
        title: 'Current Auto',
        blurb: 'Current product behavior with normal LLM decision rules.',
        options: {
          ...shared,
          benchmark_label: 'current_auto',
          llm_mode: 'auto',
          llm_model_override: selectedModel || undefined,
          reasoning_mode: reasoningMode,
          user_mode_override: responseOverride,
        },
      });
    }

    return variants;
  };

  const handleCopyRun = async (run: BenchmarkRun) => {
    try {
      await navigator.clipboard.writeText(
        buildCopyBlob(message, run, selectedVoice, reasoningMode, responseMode),
      );
      setCopiedRunId(run.variant.id);
      window.setTimeout(() => setCopiedRunId(null), 1500);
    } catch (copyError) {
      setError(copyError instanceof Error ? `Copy failed: ${copyError.message}` : 'Copy failed.');
    }
  };

  const runBenchmark = async () => {
    setRunning(true);
    setError(null);
    setRuns([]);
    const nextRuns: BenchmarkRun[] = [];

    try {
      for (const variant of buildVariants()) {
        const result = await runPipeline(message, variant.options);
        nextRuns.push({ variant, result });
        setRuns([...nextRuns]);
      }
      if (memoryEnabled) {
        setMemoryRefreshNonce((value) => value + 1);
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Benchmark failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/30 bg-card/50 p-2 shadow-m1">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setActiveTab('benchmark')}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition-all ${
              activeTab === 'benchmark'
                ? 'bg-primary text-white shadow-sm'
                : 'border border-border/30 bg-background/40 text-muted-foreground hover:border-primary/30 hover:text-foreground'
            }`}
          >
            <Gauge size={16} />
            Benchmark
          </button>
          <button
            onClick={() => setActiveTab('skills')}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition-all ${
              activeTab === 'skills'
                ? 'bg-primary text-white shadow-sm'
                : 'border border-border/30 bg-background/40 text-muted-foreground hover:border-primary/30 hover:text-foreground'
            }`}
          >
            <Wrench size={16} />
            Skills
          </button>
        </div>
      </div>

      {activeTab === 'skills' ? (
        <DevSkillsExplorer />
      ) : (
        <>
          <div className="rounded-2xl border border-border/30 bg-card/50 p-5 shadow-m1">
            <div className="flex items-center gap-2 border-b border-border/10 pb-4">
              <Gauge className="h-5 w-5 text-primary" />
              <h3 className="text-lg font-bold tracking-tight">Pipeline Benchmark Lab</h3>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Run a clear head-to-head benchmark between the deterministic system and an LLM configuration, with the exact model,
              voice profile, and reasoning mode surfaced on every run.
            </p>

            <div className="mt-4 grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
              <div className="space-y-4">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Benchmark Prompt</div>
                  <textarea
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    rows={5}
                    className="mt-2 w-full resize-none rounded-xl border border-border/40 bg-background/60 p-4 text-sm focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/5"
                    placeholder="Type a prompt you want to benchmark..."
                  />
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-border/20 bg-background/40 p-3">
                    <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      <Cpu size={12} />
                      LLM Model
                    </label>
                    <select
                      value={selectedModel}
                      onChange={(event) => setSelectedModel(event.target.value)}
                      className="mt-2 w-full rounded-lg border border-border/40 bg-card/50 p-2 text-sm focus:border-primary/40 focus:outline-none"
                    >
                      {availableModels.length === 0 && <option value="">Use current configured model</option>}
                      {availableModels.map((model) => (
                        <option key={model.name} value={model.name}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      Fast: {systemInfo?.fast_model ?? '...'} · Thinking: {systemInfo?.thinking_model ?? '...'}
                    </div>
                  </div>

                  <div className="rounded-xl border border-border/20 bg-background/40 p-3">
                    <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      <Brain size={12} />
                      Reasoning
                    </label>
                    <select
                      value={reasoningMode}
                      onChange={(event) => setReasoningMode(event.target.value as ReasoningMode)}
                      className="mt-2 w-full rounded-lg border border-border/40 bg-card/50 p-2 text-sm focus:border-primary/40 focus:outline-none"
                    >
                      <option value="fast">Fast</option>
                      <option value="thinking">Thinking</option>
                      <option value="auto">Auto</option>
                    </select>
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      Lets the forced LLM run target fast or thinking behavior.
                    </div>
                  </div>

                  <div className="rounded-xl border border-border/20 bg-background/40 p-3">
                    <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      <Sparkles size={12} />
                      Response Mode
                    </label>
                    <select
                      value={responseMode}
                      onChange={(event) => setResponseMode(event.target.value as ResponseMode)}
                      className="mt-2 w-full rounded-lg border border-border/40 bg-card/50 p-2 text-sm focus:border-primary/40 focus:outline-none"
                    >
                      <option value="standard">Standard</option>
                      <option value="rich">Rich</option>
                      <option value="deep">Deep</option>
                    </select>
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      Controls the response shape for LLM-driven runs.
                    </div>
                  </div>

                  <div className="rounded-xl border border-border/20 bg-background/40 p-3">
                    <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      <Volume2 size={12} />
                      Voice
                    </label>
                    <select
                      value={selectedVoice}
                      onChange={(event) => setSelectedVoice(event.target.value)}
                      className="mt-2 w-full rounded-lg border border-border/40 bg-card/50 p-2 text-sm focus:border-primary/40 focus:outline-none"
                    >
                      {voiceOptions.length === 0 && <option value="">Default voice</option>}
                      {voiceOptions.map((voice) => (
                        <option key={voice.voice_id} value={voice.voice_id}>
                          {voice.display_name}
                        </option>
                      ))}
                    </select>
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      Tagged onto the benchmark profile for voice-aware repros.
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-primary">Benchmark Plan</div>
                <div className="mt-3 space-y-3 text-sm">
                  <div className="rounded-xl border border-primary/20 bg-background/50 p-3">
                    <div className="font-bold text-foreground">1. System Only</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Deterministic routing and response path only. Best for seeing your local non-LLM floor.
                    </div>
                  </div>
                  <div className="rounded-xl border border-primary/20 bg-background/50 p-3">
                    <div className="font-bold text-foreground">2. Forced LLM</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Uses {selectedModel || 'the selected model'} with {reasoningMode} reasoning and {responseMode} output mode.
                    </div>
                  </div>
                  {includeAutoBaseline && (
                    <div className="rounded-xl border border-primary/20 bg-background/50 p-3">
                      <div className="font-bold text-foreground">3. Current Auto</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Preserves the app’s existing decision logic so you can see whether your manual LLM choice actually helps.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={() => void runBenchmark()}
                disabled={running || !message.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-white transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play size={14} />
                {running ? 'Benchmarking…' : 'Run Benchmark'}
              </button>
              <button
                onClick={() => setMessage(SAMPLE_PROMPT)}
                className="inline-flex items-center gap-2 rounded-lg border border-border/40 bg-card/50 px-4 py-2 text-xs font-bold transition-all hover:border-border/70 hover:bg-card"
              >
                <Sparkles size={14} />
                Load Example
              </button>
              <label className="inline-flex items-center gap-2 rounded-lg border border-border/30 bg-background/30 px-3 py-2 text-xs">
                <input
                  type="checkbox"
                  checked={includeAutoBaseline}
                  onChange={(event) => setIncludeAutoBaseline(event.target.checked)}
                />
                Include current auto baseline
              </label>
            </div>

            <div className="mt-4 rounded-xl border border-border/30 bg-background/30 p-3">
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                <Mic size={12} />
                Memory Controls
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={memoryEnabled}
                    onChange={(event) => setMemoryEnabled(event.target.checked)}
                  />
                  <span className="font-bold">Enable memory</span>
                </label>
                <label className={`flex items-center gap-2 ${!memoryEnabled ? 'opacity-50' : ''}`}>
                  <input
                    type="checkbox"
                    checked={needPreference}
                    disabled={!memoryEnabled}
                    onChange={(event) => setNeedPreference(event.target.checked)}
                  />
                  <span>need_preference</span>
                </label>
                <label className={`flex items-center gap-2 ${!memoryEnabled ? 'opacity-50' : ''}`}>
                  <input
                    type="checkbox"
                    checked={needSocial}
                    disabled={!memoryEnabled}
                    onChange={(event) => setNeedSocial(event.target.checked)}
                  />
                  <span>need_social</span>
                </label>
              </div>
            </div>

            {error && (
              <div className="mt-4 rounded-xl border border-red-400/30 bg-red-400/5 p-3 text-xs text-red-300">
                {error}
              </div>
            )}
          </div>

          {memoryEnabled && <MemoryPanel refreshNonce={memoryRefreshNonce} />}

          {runs.length > 0 && (
            <>
              <div className="grid gap-4 md:grid-cols-3">
                {runs.map((run) => {
                  const total = run.result.trace_summary.total_timing_ms;
                  const best = run.variant.id === fastestRunId;
                  return (
                    <div key={run.variant.id} className={`rounded-2xl border p-4 shadow-m1 ${metricTone(best)}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs font-bold uppercase tracking-widest text-primary">{run.variant.title}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{run.variant.blurb}</div>
                        </div>
                        {best && (
                          <span className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-emerald-300">
                            Fastest
                          </span>
                        )}
                      </div>
                      <div className="mt-4 text-3xl font-black tracking-tight">{total.toFixed(0)} ms</div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        {run.result.request_spec.llm_used
                          ? `${run.result.request_spec.llm_model ?? 'stub'} · ${run.result.request_spec.llm_reason ?? 'fallback'}`
                          : 'No LLM synthesis'}
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded-lg border border-border/20 bg-card/40 p-2">
                          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Slowest</div>
                          <div className="mt-1 font-medium">{run.result.trace_summary.slowest_step_name || 'n/a'}</div>
                        </div>
                        <div className="rounded-lg border border-border/20 bg-card/40 p-2">
                          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Output</div>
                          <div className="mt-1 font-medium">{run.result.response.output_text ? 'Produced' : 'Empty'}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="grid gap-4 xl:grid-cols-3">
                {runs.map((run) => (
                  <div key={run.variant.id} className="rounded-2xl border border-border/30 bg-card/50 p-5 shadow-m1">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-widest text-primary">{run.variant.title}</div>
                        <h4 className="mt-1 text-lg font-bold tracking-tight">{run.variant.blurb}</h4>
                      </div>
                      <button
                        onClick={() => void handleCopyRun(run)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border/40 bg-card/50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground transition-all hover:border-primary/40 hover:bg-primary/5 hover:text-primary active:scale-95"
                      >
                        {copiedRunId === run.variant.id ? <Check size={12} /> : <Copy size={12} />}
                        {copiedRunId === run.variant.id ? 'Copied' : 'Copy'}
                      </button>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1.5">
                      <span className="rounded-md border border-border/30 bg-background/40 px-2 py-0.5 text-[10px] font-mono">
                        voice: {selectedVoice || 'default'}
                      </span>
                      <span className="rounded-md border border-border/30 bg-background/40 px-2 py-0.5 text-[10px] font-mono">
                        reasoning: {run.variant.id === 'system' ? 'fast' : reasoningMode}
                      </span>
                      <span className="rounded-md border border-border/30 bg-background/40 px-2 py-0.5 text-[10px] font-mono">
                        mode: {run.variant.id === 'system' ? 'standard' : responseMode}
                      </span>
                      <span className="rounded-md border border-border/30 bg-background/40 px-2 py-0.5 text-[10px] font-mono">
                        llm: {run.result.request_spec.llm_used ? run.result.request_spec.llm_model ?? 'stub' : 'off'}
                      </span>
                    </div>

                    <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm font-medium text-foreground">
                      {run.result.response.output_text || <span className="italic text-muted-foreground">No output</span>}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {buildSourceBadges(run.result).map((badge, index) => (
                        <span
                          key={`${run.variant.id}-${index}-${badge}`}
                          className="rounded-md border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] text-primary"
                        >
                          {badge}
                        </span>
                      ))}
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-border/20 bg-background/40 p-3">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total</div>
                        <div className="mt-2 text-sm font-medium">{run.result.trace_summary.total_timing_ms.toFixed(2)} ms</div>
                      </div>
                      <div className="rounded-xl border border-border/20 bg-background/40 p-3">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Bottleneck</div>
                        <div className="mt-2 text-sm font-medium">{run.result.trace_summary.slowest_step_name || 'n/a'}</div>
                      </div>
                    </div>

                    <details className="mt-4 group rounded-xl border border-border/20 bg-background/40">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-bold">
                        Deep Trace
                        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                      </summary>
                      <div className="border-t border-border/20 px-4 py-3">
                        <div className="space-y-2">
                          {run.result.trace.steps.map((step, index) => (
                            <div key={`${run.variant.id}-${step.name}-${index}`} className="rounded-xl border border-border/20 bg-card/40 p-3">
                              <div className="flex items-center gap-2">
                                <div className="text-xs font-bold uppercase tracking-widest text-primary">{step.name}</div>
                                <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${statusClasses[step.status] ?? 'border-border/30 bg-card/60 text-muted-foreground'}`}>
                                  {step.status}
                                </span>
                                <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                                  <Clock3 size={11} />
                                  {step.timing_ms.toFixed(2)} ms
                                </span>
                              </div>
                              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                                {JSON.stringify(step.details, null, 2)}
                              </pre>
                            </div>
                          ))}
                        </div>
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
};

export default PipelineRunner;
