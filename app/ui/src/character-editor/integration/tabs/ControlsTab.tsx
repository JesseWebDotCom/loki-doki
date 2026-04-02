import React from 'react';
import { Sliders, Activity, Zap } from 'lucide-react';
import { Button } from "@/character-editor/components/ui/button";

export const ControlsTab: React.FC<{ options: any; sendToBrain: (e: any) => void }> = ({ options, sendToBrain }) => {
  return (
    <div className="space-y-6">
       <div className="grid grid-cols-3 gap-3">
         <Button onClick={() => sendToBrain({ type: 'RESET_IDLE' })} className="bg-emerald-500/10 text-emerald-500 h-10 uppercase text-xs font-black">Wake</Button>
         <Button onClick={() => sendToBrain({ type: 'FORCE_THINKING' })} className="bg-sky-500/10 text-sky-500 h-10 uppercase text-xs font-black">Think</Button>
         <Button onClick={() => sendToBrain({ type: 'FORCE_SLEEP' })} className="bg-indigo-500/10 text-indigo-500 h-10 uppercase text-xs font-black">Sleep</Button>
       </div>
    </div>
  );
};
