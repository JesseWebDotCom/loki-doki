import React, { useEffect, useState } from 'react';
import { Check, Clock3, Copy, FlaskConical, Play, Sparkles } from 'lucide-react';

import { getV2PrototypeStatus, runV2Prototype } from '../../lib/api';
import type { V2RunResponse, V2StatusResponse } from '../../lib/api-types';
import V2SkillsExplorer from './V2SkillsExplorer';
import V2PrototypeStatusPanel from './V2PrototypeStatusPanel';

const SAMPLE_PROMPT = 'hello and how do you spell restaurant';

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
    `Gemma: ${
      result.request_spec.gemma_used
        ? `used (${result.request_spec.gemma_reason ?? 'fallback'})`
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
  const [status, setStatus] = useState<V2StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [copied, setCopied] = useState(false);

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

  useEffect(() => {
    let cancelled = false;
    const loadStatus = async () => {
      setLoadingStatus(true);
      setStatusError(null);
      try {
        const next = await getV2PrototypeStatus();
        if (!cancelled) setStatus(next);
      } catch (err) {
        if (!cancelled) {
          setStatusError(err instanceof Error ? err.message : 'Failed to load v2 status.');
        }
      } finally {
        if (!cancelled) setLoadingStatus(false);
      }
    };
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const next = await runV2Prototype(message);
      setResult(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Prototype run failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <V2PrototypeStatusPanel loading={loadingStatus} error={statusError} status={status} />
      <V2SkillsExplorer />

      <div className="rounded-xl border border-border/30 bg-card/50 p-5 shadow-m1">
        <div className="flex items-center gap-2 border-b border-border/10 pb-4">
          <FlaskConical className="h-5 w-5 text-primary" />
          <h3 className="text-lg font-bold tracking-tight">V2 Request Prototype</h3>
          <span className="ml-auto rounded-md border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-primary">
            Phase 1
          </span>
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
        {error && (
          <div className="mt-4 rounded-xl border border-red-400/30 bg-red-400/5 p-3 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>

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
            <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm font-medium text-foreground">
              {result.response.output_text || <span className="italic text-muted-foreground">No output</span>}
            </div>

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
              <div className="mt-2 text-xs text-muted-foreground">
                {result.parsed.token_count} tokens
              </div>
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
                <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Gemma</div>
                <div className="mt-2 text-sm font-medium">
                  {result.request_spec.gemma_used ? `used (${result.request_spec.gemma_reason ?? 'fallback'})` : 'skipped'}
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
    </div>
  );
};

export default V2PrototypeRunner;
