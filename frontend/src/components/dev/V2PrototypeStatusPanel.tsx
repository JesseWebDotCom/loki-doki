import React from 'react';

import type { V2StatusResponse } from '../../lib/api-types';

const phaseTone: Record<string, string> = {
  complete: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  partial: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
  early: 'border-sky-400/20 bg-sky-400/10 text-sky-300',
  not_started: 'border-border/30 bg-card/60 text-muted-foreground',
};

const dependencyTone: Record<string, string> = {
  running: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  installed: 'border-sky-400/20 bg-sky-400/10 text-sky-300',
  idle: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
  fallback: 'border-orange-400/20 bg-orange-400/10 text-orange-300',
};

interface Props {
  loading: boolean;
  error: string | null;
  status: V2StatusResponse | null;
}

const V2PrototypeStatusPanel: React.FC<Props> = ({ loading, error, status }) => {
  if (loading) {
    return (
      <div className="rounded-xl border border-border/30 bg-card/50 p-5 shadow-m1">
        <div className="text-xs italic text-muted-foreground">Loading v2 implementation status…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-400/30 bg-red-400/5 p-5 shadow-m1">
        <div className="text-xs text-red-300">{error}</div>
      </div>
    );
  }

  if (!status) return null;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/30 bg-card/50 p-5 shadow-m1">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Implementation Status</div>
        <div className="mt-2 text-sm font-medium text-foreground">{status.current_focus}</div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {status.phases.map((phase) => (
            <div key={phase.id} className="rounded-xl border border-border/20 bg-background/40 p-4">
              <div className="flex items-center gap-2">
                <div className="text-xs font-bold uppercase tracking-widest text-primary">{phase.label}</div>
                <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${phaseTone[phase.status] ?? phaseTone.not_started}`}>
                  {phase.status.replace('_', ' ')}
                </span>
              </div>
              <div className="mt-2 text-sm font-medium">{phase.title}</div>
              <div className="mt-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Shipped</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {phase.completed.length > 0 ? phase.completed.join(' • ') : 'Nothing shipped in this phase yet.'}
              </div>
              <div className="mt-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Remaining</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {phase.remaining.length > 0 ? phase.remaining.join(' • ') : 'Phase is complete in the prototype.'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {status.memory && (
        <div className="rounded-xl border border-border/30 bg-card/50 p-5 shadow-m1">
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Memory Subsystem (v2)</div>
          <div className="mt-2 flex items-center gap-2">
            <div className="text-xs font-bold uppercase tracking-widest text-primary">
              {status.memory.active_phase.label} — {status.memory.active_phase.title}
            </div>
            <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${phaseTone[status.memory.active_phase.status] ?? phaseTone.not_started}`}>
              {status.memory.active_phase.status.replace('_', ' ')}
            </span>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">{status.memory.active_phase.summary}</div>

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-border/20 bg-background/40 p-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">M0 Deliverables</div>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {status.memory.active_phase.deliverables.map((item) => (
                  <li key={item}>• {item}</li>
                ))}
              </ul>
            </div>

            <div className="rounded-xl border border-border/20 bg-background/40 p-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Phase Roadmap</div>
              <ul className="mt-2 space-y-1 text-xs">
                {status.memory.phases.map((phase) => (
                  <li key={phase.id} className="flex items-center gap-2">
                    <span className="font-bold text-foreground">{phase.label}</span>
                    <span className="text-muted-foreground">{phase.title}</span>
                    <span className={`ml-auto rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest ${phaseTone[phase.status] ?? phaseTone.not_started}`}>
                      {phase.status.replace('_', ' ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-border/20 bg-background/40 p-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Seven Tiers</div>
              <ul className="mt-2 space-y-1 text-xs">
                {status.memory.tiers.map((tier) => (
                  <li key={tier.tier} className="flex flex-col">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground">T{tier.tier}</span>
                      <span className="text-foreground">{tier.title}</span>
                      <span className="ml-auto rounded-md border border-border/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
                        {tier.landing_phase}
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground">{tier.storage}</div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-xl border border-border/20 bg-background/40 p-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Prompt Slots ({status.memory.slots.worst_case_total_chars} char worst case)
              </div>
              <ul className="mt-2 space-y-1 text-xs">
                {status.memory.slots.specs.map((slot) => (
                  <li key={slot.name} className="flex items-center gap-2">
                    <code className="rounded bg-card/60 px-1.5 py-0.5 text-[10px] text-foreground">{`{${slot.name}}`}</code>
                    <span className="text-muted-foreground">T{slot.tier}</span>
                    <span className="text-muted-foreground">{slot.char_budget} chars</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {slot.always_present ? 'always' : 'gated'} · {slot.landing_phase}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-border/20 bg-background/40 p-4">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Scaffolding</div>
            <div className="mt-2 text-xs text-muted-foreground">
              Module: <code className="rounded bg-card/60 px-1.5 py-0.5 text-foreground">{status.memory.scaffolding.module}</code>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Submodules: {status.memory.scaffolding.submodules.map((s) => (
                <code key={s} className="ml-1 rounded bg-card/60 px-1.5 py-0.5 text-foreground">{s}</code>
              ))}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              Regression row: <code className="rounded bg-card/60 px-1.5 py-0.5 text-foreground">{status.memory.scaffolding.regression_row_id}</code>
              <span className="ml-2 text-amber-300">(currently failing — fixed in M1)</span>
            </div>
            <div className="mt-2 text-[10px] text-muted-foreground">
              Corpus fixtures: {status.memory.scaffolding.fixtures.length} files (empty in M0, populated per phase)
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border/30 bg-card/50 p-5 shadow-m1">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Dependencies</div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {status.dependencies.map((dependency) => (
            <div key={dependency.key} className="rounded-xl border border-border/20 bg-background/40 p-4">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium text-foreground">{dependency.label}</div>
                <span className={`ml-auto rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${dependencyTone[dependency.status] ?? dependencyTone.installed}`}>
                  {dependency.running ? 'running' : dependency.status.replace('_', ' ')}
                </span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-border/20 bg-card/30 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Version</div>
                  <div className="mt-1 text-xs font-medium text-foreground break-all">{dependency.version}</div>
                </div>
                <div className="rounded-lg border border-border/20 bg-card/30 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Runtime</div>
                  <div className="mt-1 text-xs font-medium text-foreground">{dependency.running ? 'Running' : 'Not running'}</div>
                </div>
              </div>
              <div className="mt-3 text-xs text-muted-foreground">{dependency.detail}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default V2PrototypeStatusPanel;
