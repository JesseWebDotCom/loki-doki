import React, { useCallback, useEffect, useState } from 'react';
import { Brain, Database, RefreshCw, Trash2, Users, FileText, History } from 'lucide-react';

import { dumpMemory, resetMemory } from '../../lib/api';
import type { MemoryDumpResponse } from '../../lib/api-types';

interface Props {
  /**
   * Bumped by the parent every time a Run completes so the panel
   * automatically refreshes itself without the user having to click
   * Refresh manually. Avoids stale state right after a write.
   */
  refreshNonce: number;
}

const MemoryPanel: React.FC<Props> = ({ refreshNonce }) => {
  const [dump, setDump] = useState<MemoryDumpResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await dumpMemory();
      setDump(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Memory dump failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshNonce]);

  const handleReset = async () => {
    setResetting(true);
    setError(null);
    try {
      await resetMemory();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Memory reset failed.');
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/30 bg-card/50 p-5 shadow-m1">
      <div className="flex items-center gap-2 border-b border-border/10 pb-3">
        <Database className="h-5 w-5 text-primary" />
        <h3 className="text-sm font-bold tracking-tight">Dev Memory Store</h3>
        <span className="ml-2 rounded-md border border-border/30 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
          {dump ? `owner ${dump.owner_user_id}` : '…'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/40 bg-card/50 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground transition-all hover:border-primary/40 hover:text-primary disabled:opacity-40"
            title="Re-fetch the dev memory store contents"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={() => void handleReset()}
            disabled={resetting}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-400/30 bg-red-400/5 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-red-300 transition-all hover:bg-red-400/10 disabled:opacity-40"
            title="Wipe the dev memory store and start fresh"
          >
            <Trash2 size={12} />
            {resetting ? 'Resetting…' : 'Reset'}
          </button>
        </div>
      </div>

      {dump && (
        <div className="mt-2 text-[10px] text-muted-foreground">
          Backed by <code className="rounded bg-card/60 px-1.5 py-0.5">{dump.db_path}</code> — separate from prod.
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-red-400/30 bg-red-400/5 p-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {dump && (
        <>
          <div className="mt-4 grid grid-cols-4 gap-3">
            <SummaryCell icon={<FileText size={12} />} label="Active facts" count={dump.summary.active_fact_count} tone="emerald" />
            <SummaryCell icon={<History size={12} />} label="Superseded" count={dump.summary.superseded_fact_count} tone="amber" />
            <SummaryCell icon={<Users size={12} />} label="People" count={dump.summary.person_count} tone="sky" />
            <SummaryCell icon={<Brain size={12} />} label="Relationships" count={dump.summary.relationship_count} tone="violet" />
          </div>

          <Section title="Active facts">
            {dump.active_facts.length === 0 ? (
              <EmptyHint message="No facts yet. Try toggling memory on and asking 'I&apos;m allergic to peanuts' or 'my favorite color is blue'." />
            ) : (
              <ul className="mt-2 space-y-1 text-[11px]">
                {dump.active_facts.map((row) => (
                  <li key={row.id} className="flex items-center gap-2 rounded border border-border/20 bg-background/40 px-2 py-1">
                    <code className="text-[10px] text-muted-foreground">{row.subject}</code>
                    <span className="font-bold text-foreground">{row.predicate}</span>
                    <span className="text-muted-foreground">=</span>
                    <span className="text-foreground">{row.value}</span>
                    <span className="ml-auto text-[9px] text-muted-foreground">
                      conf {row.confidence.toFixed(2)} · obs {row.observation_count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {dump.superseded_facts.length > 0 && (
            <Section title="Superseded facts">
              <ul className="mt-2 space-y-1 text-[11px]">
                {dump.superseded_facts.map((row) => (
                  <li key={row.id} className="flex items-center gap-2 rounded border border-amber-400/20 bg-amber-400/5 px-2 py-1 text-amber-200/80">
                    <code className="text-[10px]">{row.subject}</code>
                    <span className="font-bold">{row.predicate}</span>
                    <span>=</span>
                    <span className="line-through">{row.value}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="People">
            {dump.people.length === 0 ? (
              <EmptyHint message="No people yet. Try 'my brother Luke loves movies' or 'my boss is being weird'." />
            ) : (
              <ul className="mt-2 space-y-1 text-[11px]">
                {dump.people.map((person) => {
                  const personRels = dump.relationships
                    .filter((r) => r.person_id === person.id)
                    .map((r) => r.relation_label);
                  return (
                    <li key={person.id} className="flex items-center gap-2 rounded border border-border/20 bg-background/40 px-2 py-1">
                      <span className="font-bold text-foreground">
                        {person.name || person.handle || `#${person.id}`}
                      </span>
                      {person.provisional ? (
                        <span className="rounded border border-amber-400/30 bg-amber-400/5 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-amber-300">
                          provisional
                        </span>
                      ) : null}
                      {personRels.length > 0 && (
                        <span className="text-muted-foreground">{personRels.join(' / ')}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
};

const SummaryCell: React.FC<{
  icon: React.ReactNode;
  label: string;
  count: number;
  tone: 'emerald' | 'amber' | 'sky' | 'violet';
}> = ({ icon, label, count, tone }) => {
  const toneClass: Record<typeof tone, string> = {
    emerald: 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300',
    amber: 'border-amber-400/20 bg-amber-400/5 text-amber-300',
    sky: 'border-sky-400/20 bg-sky-400/5 text-sky-300',
    violet: 'border-violet-400/20 bg-violet-400/5 text-violet-300',
  };
  return (
    <div className={`rounded-lg border p-2 ${toneClass[tone]}`}>
      <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest opacity-80">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-lg font-bold">{count}</div>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="mt-4">
    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{title}</div>
    {children}
  </div>
);

const EmptyHint: React.FC<{ message: string }> = ({ message }) => (
  <div className="mt-2 rounded border border-border/20 bg-background/30 p-3 text-[11px] italic text-muted-foreground">
    {message}
  </div>
);

export default MemoryPanel;
