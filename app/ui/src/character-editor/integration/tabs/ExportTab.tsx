import React from 'react';
import { Package, Save, Download } from 'lucide-react';
import { Button } from "@/character-editor/components/ui/button";

export const ExportTab: React.FC<{ options: any; onSave: () => void; onExport: () => void }> = ({ onSave, onExport }) => {
  return (
    <div className="space-y-6">
       <div className="grid grid-cols-2 gap-4">
         <Button onClick={onSave} className="flex h-12 items-center gap-2 border-none bg-[var(--app-accent)] text-xs font-black uppercase text-white hover:bg-[var(--app-accent-strong)]">
            <Save className="w-4 h-4" /> Save Local
         </Button>
         <Button onClick={onExport} variant="outline" className="flex h-12 items-center gap-2 border-[color:var(--app-border-strong)] text-xs font-black uppercase text-[var(--app-accent)] hover:bg-[color:var(--app-accent-soft)]">
            <Download className="w-4 h-4" /> Export JSON
         </Button>
       </div>
    </div>
  );
};
