import React from 'react';
import { Package, Save, Download } from 'lucide-react';
import { Button } from "@/character-editor/components/ui/button";

export const ExportTab: React.FC<{ options: any; onSave: () => void; onExport: () => void }> = ({ onSave, onExport }) => {
  return (
    <div className="space-y-6">
       <div className="grid grid-cols-2 gap-4">
         <Button onClick={onSave} className="bg-sky-600 hover:bg-sky-500 h-12 text-white font-black text-xs uppercase flex items-center gap-2">
            <Save className="w-4 h-4" /> Save Local
         </Button>
         <Button onClick={onExport} variant="outline" className="border-sky-500/30 text-sky-400 h-12 text-xs uppercase font-black flex items-center gap-2">
            <Download className="w-4 h-4" /> Export JSON
         </Button>
       </div>
    </div>
  );
};
