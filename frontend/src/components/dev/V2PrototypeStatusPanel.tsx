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
