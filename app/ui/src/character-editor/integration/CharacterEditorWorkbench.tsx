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
    <div className="relative flex min-h-full flex-col overflow-hidden rounded-[24px] border border-[color:var(--app-border)] bg-[var(--app-bg-elevated)] font-sans text-[var(--app-text)] shadow-[var(--app-shadow-soft)] select-none">
        {/* HEADER */}
        <div className="z-10 flex h-20 items-center justify-between border-b border-[color:var(--app-border)] bg-[var(--app-bg-panel)] px-8">
           <div className="flex items-center gap-4">
              <div className="rounded-2xl border border-[color:var(--app-border-strong)] bg-[color:var(--app-accent-soft)] p-3 shadow-[var(--app-shadow-glow)]">
                 <Package className="h-6 w-6 text-[var(--app-accent)]" />
              </div>
              <div className="flex flex-col">
                 <h1 className="ce-display text-[var(--app-text)]">Character Editor Workbench</h1>
                 <p className="ce-label text-[var(--app-text-muted)]">{options.identity_key || 'UNREGISTERED_SYSTEM'}</p>
              </div>
           </div>
        </div>

        {/* CONTENT */}
        <Tabs defaultValue="general" className="flex-1 flex flex-col p-8 gap-8 overflow-hidden">
           <TabsList className="w-fit rounded-2xl border border-[color:var(--app-border)] bg-[var(--app-bg-panel-strong)] p-1">
              <TabsTrigger value="general" className="ce-control rounded-xl px-6 py-2 flex items-center gap-2">
                 <Settings className="w-3.5 h-3.5" /> General
              </TabsTrigger>
              <TabsTrigger value="controls" className="ce-control rounded-xl px-6 py-2 flex items-center gap-2">
                 <Sliders className="w-3.5 h-3.5" /> Controls
              </TabsTrigger>
              <TabsTrigger value="export" className="ce-control rounded-xl px-6 py-2 flex items-center gap-2">
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
