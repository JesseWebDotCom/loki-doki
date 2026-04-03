import React from 'react';
import { Settings, Globe, Shield } from 'lucide-react';
import { Input } from "@/character-editor/components/ui/input";

export const GeneralTab: React.FC<{ options: any; updateOption: (k: any, v: any) => void }> = ({ options, updateOption }) => {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
           <label className="text-xs font-bold uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>Character Name</label>
           <Input value={options.name || ''} onChange={(e) => updateOption('name', e.target.value)} className="h-10 border-[color:var(--app-border)] bg-[var(--app-bg-panel-strong)] text-[var(--app-text)]" />
        </div>
      </div>
    </div>
  );
};
