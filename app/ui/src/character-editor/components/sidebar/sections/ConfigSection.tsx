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
      <h3 className="text-[10px] font-black text-sky-400 uppercase tracking-[0.2em] flex items-center gap-2 px-1 pt-2">
        <Globe className="w-3 h-3" /> Identity Configuration
      </h3>
      <div className="bg-slate-950/40 p-4 rounded-2xl border border-white/5 shadow-inner space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-[8px] font-black text-slate-500 uppercase px-0.5">Character Name</label>
            <Input 
              className="bg-slate-900 border-none h-8 text-[10px] text-white font-bold" 
              placeholder="e.g. Avery" 
              value={options.name || ''}
              onChange={(e) => updateOption('name', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[8px] font-black text-slate-500 uppercase px-0.5">Unique ID</label>
            <Input 
              className="bg-slate-900 border-none h-8 text-[10px] text-sky-400 font-mono font-bold" 
              placeholder="avery_avataaars" 
              value={options.identity_key || ''}
              onChange={(e) => updateOption('identity_key', e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-[8px] font-black text-slate-500 uppercase px-0.5 flex items-center gap-1.5">
            <BrainCircuit className="w-2.5 h-2.5" /> Persona Prompt
          </label>
          <textarea 
            className="w-full bg-slate-900 border-none rounded-xl p-3 text-[10px] text-slate-300 font-medium h-20 outline-none resize-none" 
            placeholder="System Instructions..."
            value={options.persona_prompt || ''}
            onChange={(e) => updateOption('persona_prompt', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-[8px] font-black text-slate-500 uppercase px-0.5">Vocal Identity (Piper)</label>
          <VoiceModelControl options={options} updateOption={updateOption} compact />
        </div>
      </div>
    </section>
  );
};
