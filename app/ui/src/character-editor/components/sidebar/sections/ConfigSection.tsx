import React from 'react';
import { Globe } from 'lucide-react';
import { Input } from "@/character-editor/components/ui/input";

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
        <div className="space-y-1.5">
          <label className="ce-micro px-0.5 text-[var(--app-text-muted)]">Shared Sub-ID</label>
          <Input 
            className="h-8 border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px] font-bold text-[var(--app-text)]"
            value="lokidoki"
            readOnly
          />
        </div>
      </div>
    </section>
  );
};
