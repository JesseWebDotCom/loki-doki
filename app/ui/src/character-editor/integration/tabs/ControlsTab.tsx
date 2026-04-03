import React from 'react';
import { Sliders, Activity, Zap } from 'lucide-react';
import { Button } from "@/character-editor/components/ui/button";

export const ControlsTab: React.FC<{ options: any; sendToBrain: (e: any) => void }> = ({ options, sendToBrain }) => {
  return (
    <div className="space-y-6">
       <div className="grid grid-cols-3 gap-3">
         <Button onClick={() => sendToBrain({ type: 'RESET_IDLE' })} className="h-10 border border-emerald-500/20 bg-emerald-500/10 text-xs font-black uppercase text-emerald-400 hover:bg-emerald-500/18">Wake</Button>
         <Button onClick={() => sendToBrain({ type: 'FORCE_THINKING' })} className="h-10 border border-[color:var(--app-border-strong)] bg-[color:var(--app-accent-soft)] text-xs font-black uppercase text-[var(--app-accent)] hover:bg-[color:var(--app-accent-soft)]/80">Think</Button>
         <Button onClick={() => sendToBrain({ type: 'FORCE_SLEEP' })} className="h-10 border border-indigo-500/20 bg-indigo-500/10 text-xs font-black uppercase text-indigo-300 hover:bg-indigo-500/18">Sleep</Button>
       </div>
    </div>
  );
};
