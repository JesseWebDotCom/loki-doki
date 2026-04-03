import React from 'react';
import { FlaskConical, Settings, SlidersHorizontal } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/character-editor/components/ui/tabs";

import { useCharacter } from '@/character-editor/context/CharacterContext';
import { GeneralTab } from './tabs/GeneralTab';
import { SettingsTab } from './tabs/SettingsTab';
import { TestTab } from './tabs/TestTab';

const CharacterEditorWorkbench: React.FC = () => {
  const { options, updateOption } = useCharacter();

  return (
    <div className="relative flex min-h-full flex-col overflow-hidden rounded-[24px] border border-[color:var(--app-border)] bg-[var(--app-bg-elevated)] font-sans text-[var(--app-text)] shadow-[var(--app-shadow-soft)] select-none">
        <Tabs defaultValue="general" className="flex flex-1 flex-col gap-6 p-8 overflow-hidden">
           <TabsList className="w-fit rounded-2xl border border-[color:var(--app-border)] bg-[var(--app-bg-panel-strong)] p-1">
              <TabsTrigger value="general" className="ce-control rounded-xl px-6 py-2 flex items-center gap-2">
                 <Settings className="w-3.5 h-3.5" /> General
              </TabsTrigger>
              <TabsTrigger value="settings" className="ce-control rounded-xl px-6 py-2 flex items-center gap-2">
                 <SlidersHorizontal className="w-3.5 h-3.5" /> Settings
              </TabsTrigger>
              <TabsTrigger value="test" className="ce-control rounded-xl px-6 py-2 flex items-center gap-2">
                 <FlaskConical className="w-3.5 h-3.5" /> Test
              </TabsTrigger>
           </TabsList>

           <div className="flex-1 overflow-y-auto pr-4 -mr-4">
              <TabsContent value="general" className="mt-0 ring-0 outline-none">
                 <GeneralTab options={options} updateOption={updateOption} />
              </TabsContent>
              <TabsContent value="settings" className="mt-0 ring-0 outline-none">
                 <SettingsTab />
              </TabsContent>
              <TabsContent value="test" className="mt-0 ring-0 outline-none">
                 <TestTab />
              </TabsContent>
           </div>
        </Tabs>
    </div>
  );
};

export default CharacterEditorWorkbench;
