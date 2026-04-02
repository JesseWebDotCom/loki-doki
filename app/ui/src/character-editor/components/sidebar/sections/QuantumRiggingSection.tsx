import React from 'react';
import { SlidersHorizontal, Zap, Eye, RotateCcw, User, Sparkles, Activity } from 'lucide-react';
import { Button } from "@/character-editor/components/ui/button";
import { Input } from "@/character-editor/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/character-editor/components/ui/select";

interface QuantumRiggingSectionProps {
  options: any;
  updateOption: (key: any, value: any) => void;
}

export const QuantumRiggingSection: React.FC<QuantumRiggingSectionProps> = ({ options, updateOption }) => {
  if (options.style !== 'kyle_southpark') return null;

  return (
    <section id="shorthand" className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[9px] font-black text-emerald-400 uppercase tracking-[0.2em] flex items-center gap-2">
          <SlidersHorizontal className="w-2.5 h-2.5" /> Quantum Rigging Suite
        </h3>
        <Button variant="ghost" size="sm" onClick={() => updateOption('kyle_tuning', {})} className="h-6 px-2 text-[9px]">
          Reset Rig
        </Button>
      </div>

      <div className="bg-slate-950/40 p-4 rounded-2xl border border-emerald-500/10 shadow-inner space-y-5">
        {/* STATE TESTING */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-[8px] font-black text-slate-500 uppercase px-0.5">Eye State</label>
            <Select 
              value={options.kyle_tuning?.eyeStateOverride || 'auto'} 
              onValueChange={(v) => updateOption('kyle_tuning', { ...options.kyle_tuning, eyeStateOverride: v === 'auto' ? undefined : v })}
            >
              <SelectTrigger className="h-8 text-[9px] bg-slate-900 border-none rounded-lg text-emerald-400">
                <SelectValue placeholder="Auto (Live)" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-white/5 text-slate-200">
                <SelectItem value="auto">Auto (Live)</SelectItem>
                <SelectItem value="default">Default</SelectItem>
                <SelectItem value="closed">Blink</SelectItem>
                <SelectItem value="sleepy">Sleepy</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* CHASSIS */}
        <div className="space-y-4">
          <label className="text-[8px] font-black text-slate-500 uppercase flex items-center gap-1.5"><Eye className="w-3 h-3 text-emerald-500" /> Ocular Chassis</label>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex justify-between px-0.5">
                <label className="text-[8px] font-black text-slate-500 uppercase">Size</label>
                <span className="text-[8px] font-mono text-emerald-500 font-bold">{options.kyle_tuning?.eyeSize || 162}</span>
              </div>
              <Input type="range" min="50" max="250" value={options.kyle_tuning?.eyeSize || 162} onChange={(e) => updateOption('kyle_tuning', { ...options.kyle_tuning, eyeSize: parseInt(e.target.value) })} className="h-1 accent-emerald-500 bg-slate-900 border-none" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
