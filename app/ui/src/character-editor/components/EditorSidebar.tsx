import React from 'react';
import { Settings2, Globe, BrainCircuit, Mic, Palette, SlidersHorizontal, RotateCcw, ShieldCheck, Save } from 'lucide-react';
import { Button } from "@/character-editor/components/ui/button";
import { ScrollArea } from "@/character-editor/components/ui/scroll-area";
import { Input } from "@/character-editor/components/ui/input";
import { useCharacter } from '../context/CharacterContext';
import { useAudio } from '../context/AudioContext';
import { useVoice } from '../context/VoiceContext';

import { IdentitySection } from './sidebar/sections/IdentitySection';
import { BrainSection } from './sidebar/sections/BrainSection';
import { VoiceSection } from './sidebar/sections/VoiceSection';
import { ConfigSection } from './sidebar/sections/ConfigSection';
import { RiggingSection } from './sidebar/sections/RiggingSection';
import { QuantumRiggingSection } from './sidebar/sections/QuantumRiggingSection';

const SECTION_MAP: Record<string, { id: string; label: string; icon: React.ReactNode; color: string; bgColor: string }> = {
  identity: { id: 'identity', label: 'Identity Unit', icon: <Globe className="w-2.5 h-2.5" />, color: 'var(--app-icon-primary)', bgColor: 'color-mix(in srgb, var(--app-icon-primary) 12%, transparent)' },
  brain: { id: 'brain', label: 'Bio-Brain Controller', icon: <BrainCircuit className="w-2.5 h-2.5" />, color: 'var(--app-icon-warm)', bgColor: 'color-mix(in srgb, var(--app-icon-warm) 12%, transparent)' },
  voice: { id: 'voice', label: 'Neural Voice Unit', icon: <Mic className="w-2.5 h-2.5" />, color: 'var(--app-icon-primary)', bgColor: 'color-mix(in srgb, var(--app-icon-primary) 12%, transparent)' },
  config: { id: 'config', label: 'Manifest Config', icon: <Settings2 className="w-2.5 h-2.5" />, color: 'var(--app-icon-primary)', bgColor: 'color-mix(in srgb, var(--app-icon-primary) 12%, transparent)' },
  rigging: { id: 'rigging', label: 'Elite Rigging Suite', icon: <Palette className="w-2.5 h-2.5" />, color: 'var(--app-icon-pink)', bgColor: 'color-mix(in srgb, var(--app-icon-pink) 12%, transparent)' },
  shorthand: { id: 'shorthand', label: 'Quantum Rigging', icon: <SlidersHorizontal className="w-2.5 h-2.5" />, color: 'var(--app-icon-success)', bgColor: 'color-mix(in srgb, var(--app-icon-success) 12%, transparent)' },
  stage: { id: 'stage', label: 'Stage Positioning', icon: <Settings2 className="w-2.5 h-2.5" />, color: 'var(--app-icon-primary)', bgColor: 'color-mix(in srgb, var(--app-icon-primary) 12%, transparent)' },
};

const EditorSidebar: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const { options, updateOption, resetToSeed, brain, sendToBrain, saveManifest } = useCharacter();
  const audio = useAudio();
  const voice = useVoice();
  const [saveStatus, setSaveStatus] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [activeSection, setActiveSection] = React.useState(SECTION_MAP.identity);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const handleSave = async () => {
    setSaveStatus('saving');
    const success = await saveManifest();
    setSaveStatus(success ? 'saved' : 'error');
    setTimeout(() => setSaveStatus('idle'), 2000);
  };

  const bodyState = typeof brain.value === 'string' ? brain.value : 'body' in brain.value ? String(brain.value.body) : 'active';

  return (
    <div className={`relative flex h-full flex-col overflow-hidden ${embedded ? 'bg-transparent border-none' : 'border-l border-[color:var(--app-border)] bg-[var(--app-bg-panel)]'}`}>
      {/* PINNED HEADER */}
      <div className={`absolute inset-x-0 top-0 z-50 flex h-14 items-center justify-between border-b border-[color:var(--app-border)] px-4 backdrop-blur-3xl ${embedded ? 'bg-[color:var(--app-bg-panel-strong)]/85' : 'bg-[color:var(--app-bg-panel)]/92'}`}>
         <div className="flex items-center gap-3">
            <div className="p-1.5 rounded-lg" style={{ backgroundColor: activeSection.bgColor, color: activeSection.color }}>{activeSection.icon}</div>
            <span className="ce-title" style={{ color: activeSection.color }}>{activeSection.label}</span>
         </div>
         <Button onClick={handleSave} disabled={saveStatus === 'saving'} className="h-9 w-9 rounded-xl border border-[color:var(--app-border)] bg-[var(--app-bg-panel-strong)] text-[var(--app-text-muted)]">
           {saveStatus === 'saving' ? <RotateCcw className="animate-spin w-4 h-4" /> : saveStatus === 'saved' ? <ShieldCheck className="w-4 h-4 text-[var(--app-icon-success)]" /> : <Save className="w-4 h-4" />}
         </Button>
      </div>

      <ScrollArea ref={scrollRef} className="flex-1">
        <div className="flex flex-col pt-20 pb-32 p-4 space-y-6">
          <IdentitySection options={options} updateOption={updateOption} resetToSeed={resetToSeed} />
          <BrainSection 
            {...audio} 
            bodyState={bodyState} 
            sendToBrain={sendToBrain} 
          />
          <VoiceSection {...voice} />
          <ConfigSection options={options} updateOption={updateOption} />
          <RiggingSection options={options} updateOption={updateOption} resetToSeed={resetToSeed} />
          <QuantumRiggingSection options={options} updateOption={updateOption} />

          {/* STAGE POSITIONING */}
          <section id="stage" className="space-y-3 pb-12">
            <h3 className="ce-title flex items-center gap-2 px-1 text-[var(--app-icon-primary)]">
               <Settings2 className="w-2.5 h-2.5" /> Stage Positioning
            </h3>
            <div className="grid grid-cols-2 gap-3 rounded-2xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] p-4 shadow-inner">
               <div className="space-y-2">
                  <div className="flex justify-between px-1">
                    <label className="ce-label text-[var(--app-text-muted)]">Scale</label>
                    <span className="text-[9px] font-mono font-bold text-[var(--app-accent)]">{options.scale}%</span>
                  </div>
                  <Input type="range" min="50" max="240" value={options.scale} onChange={(e) => updateOption('scale', parseInt(e.target.value))} className="h-1 border-none bg-[var(--app-bg-panel)] accent-[var(--app-accent)]" />
               </div>
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
};

export default EditorSidebar;
