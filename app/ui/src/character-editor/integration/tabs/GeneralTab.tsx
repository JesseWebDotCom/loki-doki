import React from 'react';
import { Settings, Globe, Shield } from 'lucide-react';
import { Input } from "@/character-editor/components/ui/input";

export const GeneralTab: React.FC<{ options: any; updateOption: (k: any, v: any) => void }> = ({ options, updateOption }) => {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
           <label className="text-xs font-bold text-slate-500 uppercase">Character Name</label>
           <Input value={options.name || ''} onChange={(e) => updateOption('name', e.target.value)} className="bg-slate-900 border-none h-10 text-white" />
        </div>
      </div>
    </div>
  );
};
