import React, { useState } from 'react';
import { Brain, Check, Clock3, Copy, FlaskConical, Play, Sparkles, Wrench } from 'lucide-react';

import { runV2Prototype } from '../../lib/api';
import type { V2RunResponse } from '../../lib/api-types';
import V2MemoryPanel from './V2MemoryPanel';
import V2SkillsExplorer from './V2SkillsExplorer';

const SAMPLE_PROMPT = 'hello and how do you spell restaurant';
type DevTab = 'request' | 'skills';

/**
 * Pull a "Produced by" badge line out of a v2 run so the reader can see
 * — at a glance — which subsystem actually wrote the response. The
 * options are mutually exclusive in priority order:
 *
 *   1. Fast-lane match → answered by the deterministic fast lane.
 *   2. LLM used      → synthesized by the LLM fallback.
 *   3. Skill executed  → answered by the named skill (we surface the
 *      capability, handler, mechanism, and confidence so it's obvious
 *      whether the route was strong, borderline, or a guess).
 *   4. Nothing useful  → flag it loudly so we don't ship a blank reply.
 */
const buildSourceBadges = (result: V2RunResponse): string[] => {
  const badges: string[] = [];

  if (result.fast_lane.matched) {
    badges.push(`🚀 fast-lane: \`${result.fast_lane.capability ?? 'unknown'}\``);
    return badges;
  }

  const primaryChunk = result.request_spec.chunks.find(
    (chunk) => chunk.role === 'primary_request',
  );
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
    const reason = result.request_spec.llm_reason ?? 'fallback';
    const model = result.request_spec.llm_model;
    // Surface the actual model tag (e.g. qwen3:4b-instruct-2507-q4_K_M)
    // when the real Ollama path ran. When llm_model is null/undefined
    // the deterministic stub answered (this is the test/dev mode where
    // CONFIG.llm_enabled is False).
    badges.push(`🧠 llm: \`${model ?? 'stub (no model)'}\``);
    badges.push(`↳ reason: \`${reason}\``);
    badges.push(`↳ skill attempted: \`${capability}\` via \`${handler}\``);
    if (mechanism) badges.push(`↳ mechanism: \`${mechanism}\``);
    if (typeof confidence === 'number') {
      badges.push(`↳ route confidence: ${confidence.toFixed(2)}`);
    }
    return badges;
  }

  if (capability === 'direct_chat') {
    badges.push('⚠️ direct_chat (echo) — no skill matched and LLM did not run');
    return badges;
  }

  if (success === false) {
    badges.push(`❌ skill failed: \`${capability}\` via \`${handler}\``);
    return badges;
  }

  if (!outputText) {
    badges.push(`⚠️ skill returned empty: \`${capability}\` via \`${handler}\``);
    return badges;
  }

  badges.push(`🛠️ skill: \`${capability}\` via \`${handler}\``);
  if (mechanism) badges.push(`↳ mechanism: \`${mechanism}\``);
  if (typeof confidence === 'number') {
    badges.push(`↳ route confidence: ${confidence.toFixed(2)}`);
  }
  return badges;
};

/**
 * Build a markdown blob containing the user prompt, the v2 trace, and the
 * final response so the user can paste a complete reproduction into an
 * issue / chat. Kept here (not in a util module) because it is the only
 * caller and lives close to the data shape it consumes.
 */
const buildCopyBlob = (prompt: string, result: V2RunResponse): string => {
  const lines: string[] = [];
  lines.push('# v2 prototype run');
  lines.push('');
  lines.push('## Produced by');
  for (const badge of buildSourceBadges(result)) {
    lines.push(`- ${badge}`);
  }
  lines.push('');
  lines.push('## Prompt');
  lines.push('```');
  lines.push(prompt);
  lines.push('```');
  lines.push('');
  lines.push('## Response');
  lines.push('```');
  lines.push(result.response.output_text || '(empty)');
  lines.push('```');
  lines.push('');
  lines.push(`Trace total: ${result.trace_summary.total_timing_ms.toFixed(2)} ms`);
  lines.push(`Slowest step: ${result.trace_summary.slowest_step_name || 'n/a'}`);
  lines.push(
    `LLM: ${
      result.request_spec.llm_used
        ? `used (${result.request_spec.llm_model ?? 'stub'} / ${result.request_spec.llm_reason ?? 'fallback'})`
        : 'skipped'
    }`,
  );
  lines.push('');
  lines.push('## Trace');
  for (const step of result.trace.steps) {
    lines.push(
      `- **${step.name}** [${step.status}] ${step.timing_ms.toFixed(2)} ms`,
    );
    if (step.details && Object.keys(step.details).length > 0) {
      lines.push('  ```json');
      const formatted = JSON.stringify(step.details, null, 2)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n');
      lines.push(formatted);
      lines.push('  ```');
    }
  }
  return lines.join('\n');
};

const statusClasses: Record<string, string> = {
  done: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  matched: 'border-cyan-400/20 bg-cyan-400/10 text-cyan-300',
  bypassed: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
};

const V2PrototypeRunner: React.FC = () => {
  const [message, setMessage] = useState(SAMPLE_PROMPT);
  const [result, setResult] = useState<V2RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<DevTab>('request');
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [needPreference, setNeedPreference] = useState(true);
  const [needSocial, setNeedSocial] = useState(true);
  // Bumped after every successful run so V2MemoryPanel re-fetches the
  // dev store dump and the user immediately sees the side-effects of
  // their last run.
  const [memoryRefreshNonce, setMemoryRefreshNonce] = useState(0);

  const handleCopyRun = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(buildCopyBlob(message, result));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      // Clipboard API can fail in non-secure contexts; surface a tiny
      // hint instead of leaving the user wondering. We reuse the run
      // error slot so we don't add a new one just for copy failures.
      setError(err instanceof Error ? `Copy failed: ${err.message}` : 'Copy failed.');
    }
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const next = await runV2Prototype(message, {
        memory_enabled: memoryEnabled,
        need_preference: needPreference,
        need_social: needSocial,
      });
      setResult(next);
      if (memoryEnabled) {
        setMemoryRefreshNonce((n) => n + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Prototype run failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/30 bg-card/50 p-2 shadow-m1">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setActiveTab('request')}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition-all ${
              activeTab === 'request'
                ? 'bg-primary text-white shadow-sm'
                : 'border border-border/30 bg-background/40 text-muted-foreground hover:border-primary/30 hover:text-foreground'
            }`}
          >
            <FlaskConical size={16} />
            Request
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
        <V2SkillsExplorer />
      ) : (
        <>
          <div className="rounded-xl border border-border/30 bg-card/50 p-5 shadow-m1">
            <div className="flex items-center gap-2 border-b border-border/10 pb-4">
              <FlaskConical className="h-5 w-5 text-primary" />
              <h3 className="text-lg font-bold tracking-tight">V2 Request Prototype</h3>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Runs the isolated `v2/` deterministic request pipeline without touching the main chat orchestrator.
            </p>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={4}
              className="mt-4 w-full resize-none rounded-xl border border-border/40 bg-background/60 p-4 text-sm focus:outline-none focus:border-primary/40 focus:ring-4 focus:ring-primary/5"
              placeholder="Type a prototype request..."
            />
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={() => void run()}
                disabled={running || !message.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-white transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play size={14} />
                {running ? 'Running…' : 'Run Prototype'}
              </button>
              <button
                onClick={() => setMessage(SAMPLE_PROMPT)}
                className="inline-flex items-center gap-2 rounded-lg border border-border/40 bg-card/50 px-4 py-2 text-xs font-bold transition-all hover:border-border/70 hover:bg-card"
              >
                <Sparkles size={14} />
                Load Example
              </button>
            </div>
            <div className="mt-4 rounded-xl border border-border/30 bg-background/30 p-3">
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                <Brain size={12} />
                Memory (M0–M3)
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={memoryEnabled}
                    onChange={(event) => setMemoryEnabled(event.target.checked)}
                  />
                  <span className="font-bold">Enable memory</span>
                  <span className="text-muted-foreground">(uses dev test store)</span>
                </label>
                <label className={`flex items-center gap-2 ${!memoryEnabled ? 'opacity-50' : ''}`}>
                  <input
                    type="checkbox"
                    checked={needPreference}
                    disabled={!memoryEnabled}
                    onChange={(event) => setNeedPreference(event.target.checked)}
                  />
                  <span>need_preference (Tier 4)</span>
                </label>
                <label className={`flex items-center gap-2 ${!memoryEnabled ? 'opacity-50' : ''}`}>
                  <input
                    type="checkbox"
                    checked={needSocial}
                    disabled={!memoryEnabled}
                    onChange={(event) => setNeedSocial(event.target.checked)}
                  />
                  <span>need_social (Tier 5)</span>
                </label>
              </div>
              {memoryEnabled && (
                <div className="mt-2 text-[10px] italic text-muted-foreground">
                  Try: "I&apos;m allergic to peanuts" → "what am I allergic to". Or "my brother Luke loves movies" → "when is Luke visiting".
                </div>
              )}
            </div>
            {error && (
              <div className="mt-4 rounded-xl border border-red-400/30 bg-red-400/5 p-3 text-xs text-red-300">
                {error}
              </div>
            )}
          </div>

          {memoryEnabled && <V2MemoryPanel refreshNonce={memoryRefreshNonce} />}

          {result && (
            <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="rounded-xl border border-border/30 bg-card/50 p-5 shadow-m1">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Response</div>
                  <button
                    onClick={() => void handleCopyRun()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/40 bg-card/50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground transition-all hover:border-primary/40 hover:bg-primary/5 hover:text-primary active:scale-95"
                    title="Copy prompt, trace, and response as markdown"
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? 'Copied' : 'Copy run'}
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {buildSourceBadges(result).map((badge, index) => (
                    <span
                      key={`${badge}-${index}`}
                      className="rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary"
                    >
                      {badge}
                    </span>
                  ))}
                </div>
                <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm font-medium text-foreground">
                  {result.response.output_text || <span className="italic text-muted-foreground">No output</span>}
                </div>

                {memoryEnabled && (() => {
                  const writeStep = result.trace.steps.find((s) => s.name === 'memory_write');
                  const readStep = result.trace.steps.find((s) => s.name === 'memory_read');
                  const writeDetails = (writeStep?.details ?? {}) as Record<string, unknown>;
                  const readDetails = (readStep?.details ?? {}) as Record<string, unknown>;
                  const accepted = (writeDetails.accepted as number) ?? 0;
                  const rejected = (writeDetails.rejected as number) ?? 0;
                  const acceptedSummary = (writeDetails.accepted_summary as Array<Record<string, unknown>>) ?? [];
                  const rejectedSummary = (writeDetails.rejected_summary as Array<Record<string, unknown>>) ?? [];
                  const slotsAssembled = (readDetails.slots_assembled as string[]) ?? [];
                  const userFactsChars = (readDetails.user_facts_chars as number) ?? 0;
                  const socialContextChars = (readDetails.social_context_chars as number) ?? 0;
                  const memorySlots =
                    (result.request_spec.context as Record<string, unknown> | undefined)?.memory_slots as
                      | Record<string, string>
                      | undefined;

                  return (
                    <div className="mt-3 rounded-xl border border-violet-400/30 bg-violet-400/5 p-4">
                      <div className="flex items-center gap-2">
                        <Brain size={14} className="text-violet-300" />
                        <div className="text-[10px] font-bold uppercase tracking-widest text-violet-300">
                          Memory activity
                        </div>
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2 text-[11px]">
                        <div>
                          <div className="font-bold text-violet-200">Write path</div>
                          <div className="text-muted-foreground">
                            accepted={accepted} · rejected={rejected}
                          </div>
                          {acceptedSummary.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                              {acceptedSummary.map((row, i) => (
                                <li key={i} className="text-emerald-300">
                                  ✓ {String(row.subject)} {String(row.predicate)}={String(row.value)} (T{String(row.tier ?? '?')})
                                </li>
                              ))}
                            </ul>
                          )}
                          {rejectedSummary.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                              {rejectedSummary.map((row, i) => (
                                <li key={i} className="text-amber-300">
                                  ✗ {String(row.subject || '?')} {String(row.predicate || '?')} — denied at {String(row.denied_at)}: {String(row.reason)}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div>
                          <div className="font-bold text-violet-200">Read path</div>
                          <div className="text-muted-foreground">
                            slots: {slotsAssembled.length === 0 ? '(none)' : slotsAssembled.join(', ')}
                          </div>
                          <div className="text-muted-foreground">
                            user_facts: {userFactsChars} chars · social_context: {socialContextChars} chars
                          </div>
                          {memorySlots?.user_facts && (
                            <div className="mt-1 rounded border border-border/20 bg-card/40 px-2 py-1 font-mono text-[10px] text-foreground">
                              {memorySlots.user_facts}
                            </div>
                          )}
                          {memorySlots?.social_context && (
                            <div className="mt-1 rounded border border-border/20 bg-card/40 px-2 py-1 font-mono text-[10px] text-foreground">
                              {memorySlots.social_context}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-border/20 bg-background/40 p-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Normalized</div>
                    <div className="mt-2 text-xs">{result.normalized.cleaned_text}</div>
                  </div>
                  <div className="rounded-xl border border-border/20 bg-background/40 p-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Fast Lane</div>
                    <div className="mt-2 text-xs">
                      {result.fast_lane.matched ? `Matched ${result.fast_lane.capability}` : `Bypassed (${result.fast_lane.reason ?? 'no match'})`}
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-xl border border-border/20 bg-background/40 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Parsed</div>
                  <div className="mt-2 text-xs text-muted-foreground">{result.parsed.token_count} tokens</div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {result.parsed.tokens.map((token) => (
                      <span key={token} className="rounded-md border border-border/30 bg-card/60 px-2 py-0.5 text-[10px]">
                        {token}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-4">
                  <div className="rounded-xl border border-border/20 bg-background/40 p-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Trace Total</div>
                    <div className="mt-2 text-sm font-medium">{result.trace_summary.total_timing_ms.toFixed(2)} ms</div>
                  </div>
                  <div className="rounded-xl border border-border/20 bg-background/40 p-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Bottleneck</div>
                    <div className="mt-2 text-sm font-medium">{result.trace_summary.slowest_step_name || 'n/a'}</div>
                  </div>
                  <div className="rounded-xl border border-border/20 bg-background/40 p-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">RequestSpec</div>
                    <div className="mt-2 text-sm font-medium">{result.request_spec.chunks.length} chunks</div>
                  </div>
                  <div className="rounded-xl border border-border/20 bg-background/40 p-3">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">LLM</div>
                    <div className="mt-2 text-sm font-medium">
                      {result.request_spec.llm_used
                        ? `${result.request_spec.llm_model ?? 'stub'} (${result.request_spec.llm_reason ?? 'fallback'})`
                        : 'skipped'}
                    </div>
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  {result.chunks.map((chunk, index) => {
                    const extraction = result.extractions.find((item) => item.chunk_index === chunk.index);
                    const route = result.routes.find((item) => item.chunk_index === chunk.index);
                    const implementation = result.implementations.find((item) => item.chunk_index === chunk.index);
                    const resolution = result.resolutions.find((item) => item.chunk_index === chunk.index);
                    const execution = result.executions.find((item) => item.chunk_index === chunk.index);
                    const routeTrace = result.trace.steps.find((step) => step.name === 'route')?.details?.chunks as Array<Record<string, unknown>> | undefined;
                    const implementationTrace = result.trace.steps.find((step) => step.name === 'select_implementation')?.details?.chunks as Array<Record<string, unknown>> | undefined;
                    const resolveTrace = result.trace.steps.find((step) => step.name === 'resolve')?.details?.chunks as Array<Record<string, unknown>> | undefined;
                    const executeTrace = result.trace.steps.find((step) => step.name === 'execute')?.details?.chunks as Array<Record<string, unknown>> | undefined;
                    const routeTiming = Number(routeTrace?.find((item) => item.chunk_index === chunk.index)?.timing_ms ?? 0);
                    const implementationTiming = Number(implementationTrace?.find((item) => item.chunk_index === chunk.index)?.timing_ms ?? 0);
                    const resolveTiming = Number(resolveTrace?.find((item) => item.chunk_index === chunk.index)?.timing_ms ?? 0);
                    const executeTiming = Number(executeTrace?.find((item) => item.chunk_index === chunk.index)?.timing_ms ?? 0);
                    return (
                      <div key={chunk.index} className="rounded-xl border border-border/20 bg-background/40 p-3">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Chunk {index + 1}</div>
                        <div className="mt-2 text-sm font-medium">{chunk.text}</div>
                        <div className="mt-3 grid gap-2 md:grid-cols-4">
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Extract</div>
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              refs: {(extraction?.references ?? []).join(', ') || 'none'}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              predicates: {(extraction?.predicates ?? []).join(', ') || 'none'}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Route / Resolve</div>
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              {route?.capability ?? 'none'} ({((route?.confidence ?? 0) * 100).toFixed(0)}%) · {routeTiming.toFixed(2)} ms
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              matched on {(routeTrace?.find((item) => item.chunk_index === chunk.index)?.matched_text as string | undefined) ?? 'n/a'}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Implementation</div>
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              {implementation?.handler_name ?? 'none'} · {implementationTiming.toFixed(2)} ms
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {(implementation?.implementation_id ?? 'n/a')} (p{implementation?.priority ?? 0})
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {implementation?.candidate_count ?? 0} candidates
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Resolve</div>
                            <div className="text-[11px] text-muted-foreground">
                              {resolution?.resolved_target ?? 'none'} via {resolution?.source ?? 'none'} · {resolveTiming.toFixed(2)} ms
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Execute</div>
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              {execution?.output_text ?? 'no output'} · {executeTiming.toFixed(2)} ms
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-border/30 bg-card/50 p-5 shadow-m1">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Trace</div>
                  <div className="text-[10px] text-muted-foreground">
                    Total {result.trace.steps.reduce((sum, step) => sum + step.timing_ms, 0).toFixed(2)} ms
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  {result.trace.steps.map((step, index) => (
                    <div key={`${step.name}-${index}`} className="rounded-xl border border-border/20 bg-background/40 p-3">
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
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default V2PrototypeRunner;
