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
        <h3 className="text-[9px] font-black text-sky-500 uppercase tracking-[0.2em] flex items-center gap-2">
          <Globe className="w-2.5 h-2.5" /> Identity Unit
        </h3>
        <Button 
          onClick={() => resetToSeed(Math.random().toString(36).substring(7))} 
          variant="ghost" 
          className="h-6 px-2 text-[9px] font-bold text-sky-400 hover:bg-sky-500/10 rounded-lg"
        >
          <Sparkles className="w-2.5 h-2.5 mr-1" /> Reroll
        </Button>
      </div>
      <div className="bg-slate-950/40 p-2.5 rounded-2xl border border-white/5 shadow-inner">
        <div className="rounded-xl border border-sky-500/10 bg-slate-900/70 px-3 py-3">
          <div className="text-[8px] font-black uppercase tracking-[0.18em] text-slate-500">Active Character</div>
          <div className="mt-1 text-sm font-black text-slate-100">{options.name || 'Character'}</div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-sky-400">{options.identity_key || options.seed}</div>
        </div>
      </div>
    </section>
  );
};
