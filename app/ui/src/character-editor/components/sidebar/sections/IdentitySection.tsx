import React from 'react';
import { Globe, Sparkles } from 'lucide-react';
import { Button } from "@/character-editor/components/ui/button";

interface IdentitySectionProps {
  options: any;
  updateOption: (key: any, value: any) => void;
  resetToSeed: (seed: string) => void;
}

export const IdentitySection: React.FC<IdentitySectionProps> = ({ options, resetToSeed }) => {
  return (
    <section id="identity" className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <h3 className="flex items-center gap-2 text-[9px] font-black uppercase text-[var(--app-accent)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>
          <Globe className="w-2.5 h-2.5" /> Identity Unit
        </h3>
        <Button 
          onClick={() => resetToSeed(Math.random().toString(36).substring(7))} 
          variant="ghost" 
          className="h-6 rounded-lg px-2 text-[9px] font-bold text-[var(--app-accent)] hover:bg-[color:var(--app-accent-soft)]"
        >
          <Sparkles className="w-2.5 h-2.5 mr-1" /> Reroll
        </Button>
      </div>
      <div className="rounded-2xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] p-2.5 shadow-[var(--app-shadow-soft)]">
        <div className="rounded-xl border border-[color:var(--app-border-strong)] bg-[color:var(--app-bg-panel-strong)] px-3 py-3">
          <div className="text-[8px] font-black uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-micro-letter-spacing)" }}>Active Character</div>
          <div className="mt-1 text-sm font-black text-[var(--app-text)]">{options.name || 'Character'}</div>
          <div className="mt-1 text-[10px] uppercase text-[var(--app-accent)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>{options.identity_key || options.seed}</div>
        </div>
      </div>
    </section>
  );
};
