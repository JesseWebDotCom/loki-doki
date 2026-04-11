import React, { startTransition, useDeferredValue, useEffect, useState } from 'react';
import { CheckCircle2, ChevronRight, Play, Search, Wrench } from 'lucide-react';

import { getV2Skills, runV2Skill } from '../../lib/api';
import type { V2SkillEntry, V2SkillRunResponse, V2SkillsResponse } from '../../lib/api-types';

const DEFAULT_MESSAGE = 'hello';

const V2SkillsExplorer: React.FC = () => {
  const [skills, setSkills] = useState<V2SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [selectedCapability, setSelectedCapability] = useState<string>('');
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [paramsText, setParamsText] = useState('{}');
  const [resolvedTarget, setResolvedTarget] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<V2SkillRunResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response: V2SkillsResponse = await getV2Skills();
        if (cancelled) return;
        setSkills(response.skills);
        if (response.skills.length > 0) {
          setSelectedCapability((current) => current || response.skills[0].capability);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load v2 skills.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredSkills = skills.filter((skill) => {
    const needle = deferredQuery.trim().toLowerCase();
    if (!needle) return true;
    return (
      skill.capability.toLowerCase().includes(needle)
      || skill.description.toLowerCase().includes(needle)
      || skill.selected_handler.toLowerCase().includes(needle)
    );
  });

  const selectedSkill = filteredSkills.find((skill) => skill.capability === selectedCapability)
    ?? skills.find((skill) => skill.capability === selectedCapability)
    ?? filteredSkills[0]
    ?? null;

  useEffect(() => {
    if (!selectedSkill) return;
    setSelectedCapability(selectedSkill.capability);
    if (!message || message === DEFAULT_MESSAGE) {
      setMessage(selectedSkill.examples[0] || DEFAULT_MESSAGE);
    }
  }, [selectedSkill, message]);

  const runSkill = async () => {
    if (!selectedSkill) return;
    setRunError(null);
    setRunning(true);
    try {
      const parsed = paramsText.trim() ? JSON.parse(paramsText) as Record<string, unknown> : {};
      const response = await runV2Skill(selectedSkill.capability, message, parsed, resolvedTarget || undefined);
      setRunResult(response);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Skill run failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5 shadow-m1">
      <div className="flex items-center gap-2 border-b border-border/10 pb-4">
        <Wrench className="h-5 w-5 text-primary" />
        <h3 className="text-lg font-bold tracking-tight">V2 Skills Explorer</h3>
        <span className="ml-auto rounded-md border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-primary">
          {skills.length} capabilities
        </span>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-3">
          <label className="flex items-center gap-2 rounded-xl border border-border/30 bg-background/50 px-3 py-2">
            <Search size={14} className="text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => {
                const next = event.target.value;
                startTransition(() => setQuery(next));
              }}
              placeholder="Search capabilities, descriptions, handlers…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </label>

          <div className="max-h-[30rem] overflow-y-auto rounded-xl border border-border/20 bg-background/30">
            {loading && <div className="p-4 text-xs italic text-muted-foreground">Loading skills…</div>}
            {error && <div className="p-4 text-xs text-red-300">{error}</div>}
            {!loading && !error && filteredSkills.map((skill) => {
              const active = selectedSkill?.capability === skill.capability;
              return (
                <button
                  key={skill.capability}
                  onClick={() => {
                    setSelectedCapability(skill.capability);
                    setMessage(skill.examples[0] || DEFAULT_MESSAGE);
                    setRunResult(null);
                    setRunError(null);
                  }}
                  className={`w-full border-b border-border/10 p-3 text-left transition-colors last:border-b-0 ${
                    active ? 'bg-primary/10' : 'hover:bg-card/50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-semibold">{skill.capability}</div>
                    {active && <CheckCircle2 size={14} className="text-primary" />}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">{skill.selected_handler}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-4">
          {!selectedSkill && (
            <div className="rounded-xl border border-border/20 bg-background/40 p-4 text-sm text-muted-foreground">
              Pick a capability to inspect it.
            </div>
          )}

          {selectedSkill && (
            <>
              <div className="rounded-xl border border-border/20 bg-background/40 p-4">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-bold">{selectedSkill.capability}</div>
                  <ChevronRight size={14} className="text-muted-foreground" />
                  <div className="text-xs text-muted-foreground">{selectedSkill.selected_handler}</div>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{selectedSkill.description}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedSkill.examples.map((example) => (
                    <button
                      key={example}
                      onClick={() => setMessage(example)}
                      className="rounded-lg border border-border/30 bg-card/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-all hover:border-primary/40 hover:text-primary"
                    >
                      {example}
                    </button>
                  ))}
                </div>
                <div className="mt-3 space-y-2">
                  {selectedSkill.implementations.map((implementation) => (
                    <div key={implementation.id} className="rounded-lg border border-border/20 bg-card/40 px-3 py-2 text-[11px] text-muted-foreground">
                      {implementation.id} · {implementation.handler_name} · p{implementation.priority}
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-border/20 bg-background/40 p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Direct Skill Test</div>
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  rows={3}
                  className="mt-3 w-full resize-none rounded-xl border border-border/30 bg-card/50 p-3 text-sm outline-none focus:border-primary/40 focus:ring-4 focus:ring-primary/5"
                  placeholder="Message passed as chunk_text"
                />
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <input
                    value={resolvedTarget}
                    onChange={(event) => setResolvedTarget(event.target.value)}
                    className="rounded-xl border border-border/30 bg-card/50 px-3 py-2 text-sm outline-none focus:border-primary/40 focus:ring-4 focus:ring-primary/5"
                    placeholder="Optional resolved_target override"
                  />
                  <button
                    onClick={() => void runSkill()}
                    disabled={running}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-white transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Play size={14} />
                    {running ? 'Running…' : 'Run Selected Skill'}
                  </button>
                </div>
                <textarea
                  value={paramsText}
                  onChange={(event) => setParamsText(event.target.value)}
                  rows={5}
                  className="mt-3 w-full resize-none rounded-xl border border-border/30 bg-card/50 p-3 font-mono text-[12px] outline-none focus:border-primary/40 focus:ring-4 focus:ring-primary/5"
                  placeholder='Optional params JSON, e.g. {"topic":"technology"}'
                />
                {runError && <div className="mt-3 rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-xs text-red-300">{runError}</div>}
                {runResult && (
                  <div className="mt-3 rounded-xl border border-border/20 bg-card/40 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                        Result · {runResult.execution.success ? 'success' : 'failure'}
                      </div>
                      <div className="rounded-lg border border-border/20 bg-background/50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-primary">
                        {runResult.timing_ms.toFixed(2)} ms
                      </div>
                    </div>
                    <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Response</div>
                      <div className="mt-2 text-sm font-medium text-foreground">
                        {runResult.execution.output_text || <span className="italic text-muted-foreground">No output</span>}
                      </div>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <div className="rounded-lg border border-border/20 bg-background/50 p-3">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Capability</div>
                        <div className="mt-1 text-xs text-foreground">{runResult.capability}</div>
                      </div>
                      <div className="rounded-lg border border-border/20 bg-background/50 p-3">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Handler</div>
                        <div className="mt-1 break-all text-xs text-foreground">{runResult.handler_name}</div>
                      </div>
                      <div className="rounded-lg border border-border/20 bg-background/50 p-3">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Attempts</div>
                        <div className="mt-1 text-xs text-foreground">{runResult.execution.attempts}</div>
                      </div>
                    </div>
                    <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                      {JSON.stringify(runResult, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default V2SkillsExplorer;
