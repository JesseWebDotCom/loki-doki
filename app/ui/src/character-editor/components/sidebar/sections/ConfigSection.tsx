import React from 'react';
import { Globe, BrainCircuit } from 'lucide-react';
import { Input } from "@/character-editor/components/ui/input";
import VoiceModelControl from '@/character-editor/components/VoiceModelControl';

interface ConfigSectionProps {
  options: any;
  updateOption: (key: any, value: any) => void;
}

export const ConfigSection: React.FC<ConfigSectionProps> = ({ options, updateOption }) => {
  return (
    <section id="config" className="space-y-4">
      <h3 className="ce-title flex items-center gap-2 px-1 pt-2 text-[var(--app-icon-primary)]">
        <Globe className="w-3 h-3" /> Identity Configuration
      </h3>
      <div className="space-y-4 rounded-2xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] p-4 shadow-[var(--app-shadow-soft)]">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="ce-micro px-0.5 text-[var(--app-text-muted)]">Character Name</label>
            <Input 
              className="h-8 border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px] font-bold text-[var(--app-text)]" 
              placeholder="e.g. Avery" 
              value={options.name || ''}
              onChange={(e) => updateOption('name', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="ce-micro px-0.5 text-[var(--app-text-muted)]">Unique ID</label>
            <Input 
              className="h-8 border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px] font-mono font-bold text-[var(--app-icon-primary)]" 
              placeholder="avery_avataaars" 
              value={options.identity_key || ''}
              onChange={(e) => updateOption('identity_key', e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="ce-micro flex items-center gap-1.5 px-0.5 text-[var(--app-text-muted)]">
            <BrainCircuit className="w-2.5 h-2.5" /> Persona Prompt
          </label>
          <textarea 
            className="h-20 w-full resize-none rounded-xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] p-3 text-[10px] font-medium text-[var(--app-text)] outline-none" 
            placeholder="System Instructions..."
            value={options.persona_prompt || ''}
            onChange={(e) => updateOption('persona_prompt', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label className="ce-micro px-0.5 text-[var(--app-text-muted)]">Vocal Identity (Piper)</label>
          <VoiceModelControl options={options} updateOption={updateOption} compact />
        </div>
      </div>
    </section>
  );
};
