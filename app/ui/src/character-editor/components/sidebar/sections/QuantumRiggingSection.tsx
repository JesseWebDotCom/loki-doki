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
        <h3 className="ce-title flex items-center gap-2 text-[var(--app-icon-success)]">
          <SlidersHorizontal className="w-2.5 h-2.5" /> Quantum Rigging Suite
        </h3>
        <Button variant="ghost" size="sm" onClick={() => updateOption('kyle_tuning', {})} className="h-6 px-2 text-[9px]">
          Reset Rig
        </Button>
      </div>

      <div className="space-y-5 rounded-2xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] p-4 shadow-[var(--app-shadow-soft)]">
        {/* STATE TESTING */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="ce-micro px-0.5 text-[var(--app-text-muted)]">Eye State</label>
            <Select 
              value={options.kyle_tuning?.eyeStateOverride || 'auto'} 
              onValueChange={(v) => updateOption('kyle_tuning', { ...options.kyle_tuning, eyeStateOverride: v === 'auto' ? undefined : v })}
            >
              <SelectTrigger className="h-8 rounded-lg border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[9px] text-[var(--app-icon-success)]">
                <SelectValue placeholder="Auto (Live)" />
              </SelectTrigger>
              <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
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
          <label className="ce-micro flex items-center gap-1.5 text-[var(--app-text-muted)]"><Eye className="w-3 h-3 text-[var(--app-icon-success)]" /> Ocular Chassis</label>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex justify-between px-0.5">
                <label className="ce-micro text-[var(--app-text-muted)]">Size</label>
                <span className="text-[8px] font-mono font-bold text-[var(--app-icon-success)]">{options.kyle_tuning?.eyeSize || 162}</span>
              </div>
              <Input type="range" min="50" max="250" value={options.kyle_tuning?.eyeSize || 162} onChange={(e) => updateOption('kyle_tuning', { ...options.kyle_tuning, eyeSize: parseInt(e.target.value) })} className="h-1 border-none bg-[color:var(--app-bg-panel-strong)] accent-[var(--app-icon-success)]" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
