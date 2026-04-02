import React from 'react';
import { Package, Settings, Sliders, Globe, Save, Download, ChevronRight, Activity } from 'lucide-react';
import { Button } from "@/character-editor/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/character-editor/components/ui/tabs";
import { useCharacter } from '../context/CharacterContext';

import { GeneralTab } from './tabs/GeneralTab';
import { ControlsTab } from './tabs/ControlsTab';
import { ExportTab } from './tabs/ExportTab';

const CharacterEditorWorkbench: React.FC = () => {
  const { options, updateOption, resetToSeed, brain, sendToBrain, saveManifest } = useCharacter();
  
  const handleExport = () => {
    const data = JSON.stringify(options, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${options.identity_key || options.seed}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-full flex-col bg-slate-950 font-sans select-none relative overflow-hidden rounded-[24px] border border-white/5">
        {/* HEADER */}
        <div className="h-20 bg-slate-900 border-b border-white/5 flex items-center justify-between px-8 z-10">
           <div className="flex items-center gap-4">
              <div className="p-3 bg-sky-500/10 rounded-2xl border border-sky-500/20 shadow-lg shadow-sky-500/5">
                 <Package className="w-6 h-6 text-sky-400" />
              </div>
              <div className="flex flex-col">
                 <h1 className="text-xl font-black text-slate-100 uppercase tracking-tight">Character Editor Workbench</h1>
                 <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{options.identity_key || 'UNREGISTERED_SYSTEM'}</p>
              </div>
           </div>
        </div>

        {/* CONTENT */}
        <Tabs defaultValue="general" className="flex-1 flex flex-col p-8 gap-8 overflow-hidden">
           <TabsList className="bg-slate-900/50 border border-white/5 p-1 rounded-2xl w-fit">
              <TabsTrigger value="general" className="px-6 py-2 rounded-xl text-xs font-black uppercase flex items-center gap-2">
                 <Settings className="w-3.5 h-3.5" /> General
              </TabsTrigger>
              <TabsTrigger value="controls" className="px-6 py-2 rounded-xl text-xs font-black uppercase flex items-center gap-2">
                 <Sliders className="w-3.5 h-3.5" /> Controls
              </TabsTrigger>
              <TabsTrigger value="export" className="px-6 py-2 rounded-xl text-xs font-black uppercase flex items-center gap-2">
                 <Package className="w-3.5 h-3.5" /> Export
              </TabsTrigger>
           </TabsList>

           <div className="flex-1 overflow-y-auto pr-4 -mr-4">
              <TabsContent value="general" className="mt-0 ring-0 outline-none">
                 <GeneralTab options={options} updateOption={updateOption} />
              </TabsContent>
              <TabsContent value="controls" className="mt-0 ring-0 outline-none">
                 <ControlsTab options={options} sendToBrain={sendToBrain} />
              </TabsContent>
              <TabsContent value="export" className="mt-0 ring-0 outline-none">
                 <ExportTab options={options} onSave={saveManifest} onExport={handleExport} />
              </TabsContent>
           </div>
        </Tabs>
    </div>
  );
};

export default CharacterEditorWorkbench;
