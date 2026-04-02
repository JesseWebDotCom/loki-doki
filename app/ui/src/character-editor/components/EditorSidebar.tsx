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
  identity: { id: 'identity', label: 'Identity Unit', icon: <Globe className="w-2.5 h-2.5" />, color: '#38bdf8', bgColor: 'rgba(56, 189, 248, 0.1)' },
  brain: { id: 'brain', label: 'Bio-Brain Controller', icon: <BrainCircuit className="w-2.5 h-2.5" />, color: '#fbbf24', bgColor: 'rgba(251, 191, 36, 0.1)' },
  voice: { id: 'voice', label: 'Neural Voice Unit', icon: <Mic className="w-2.5 h-2.5" />, color: '#38bdf8', bgColor: 'rgba(56, 189, 248, 0.1)' },
  config: { id: 'config', label: 'Manifest Config', icon: <Settings2 className="w-2.5 h-2.5" />, color: '#38bdf8', bgColor: 'rgba(56, 189, 248, 0.1)' },
  rigging: { id: 'rigging', label: 'Elite Rigging Suite', icon: <Palette className="w-2.5 h-2.5" />, color: '#f472b6', bgColor: 'rgba(244, 114, 182, 0.1)' },
  shorthand: { id: 'shorthand', label: 'Quantum Rigging', icon: <SlidersHorizontal className="w-2.5 h-2.5" />, color: '#34d399', bgColor: 'rgba(52, 211, 153, 0.1)' },
  stage: { id: 'stage', label: 'Stage Positioning', icon: <Settings2 className="w-2.5 h-2.5" />, color: '#38bdf8', bgColor: 'rgba(56, 189, 248, 0.1)' },
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
    <div className={`flex flex-col h-full overflow-hidden relative ${embedded ? 'bg-transparent border-none' : 'bg-slate-900 border-l border-white/5'}`}>
      {/* PINNED HEADER */}
      <div className={`absolute top-0 inset-x-0 h-14 backdrop-blur-3xl border-b border-white/10 z-50 flex items-center justify-between px-4 ${embedded ? 'bg-slate-950/85' : 'bg-slate-900/90'}`}>
         <div className="flex items-center gap-3">
            <div className="p-1.5 rounded-lg" style={{ backgroundColor: activeSection.bgColor, color: activeSection.color }}>{activeSection.icon}</div>
            <span className="text-[13px] font-black uppercase" style={{ color: activeSection.color }}>{activeSection.label}</span>
         </div>
         <Button onClick={handleSave} disabled={saveStatus === 'saving'} className="h-9 w-9 rounded-xl border bg-slate-800 text-slate-400">
           {saveStatus === 'saving' ? <RotateCcw className="animate-spin w-4 h-4" /> : saveStatus === 'saved' ? <ShieldCheck className="w-4 h-4 text-emerald-400" /> : <Save className="w-4 h-4" />}
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
            <h3 className="text-[9px] font-black text-sky-500 uppercase tracking-[0.2em] flex items-center gap-2 px-1">
               <Settings2 className="w-2.5 h-2.5" /> Stage Positioning
            </h3>
            <div className="grid grid-cols-2 gap-3 bg-slate-950/40 p-4 rounded-2xl border border-white/5 shadow-inner">
               <div className="space-y-2">
                  <div className="flex justify-between px-1">
                    <label className="text-[9px] font-bold text-slate-600 uppercase">Scale</label>
                    <span className="text-[9px] font-mono text-sky-500 font-bold">{options.scale}%</span>
                  </div>
                  <Input type="range" min="50" max="240" value={options.scale} onChange={(e) => updateOption('scale', parseInt(e.target.value))} className="h-1 accent-sky-500 bg-slate-800 border-none" />
               </div>
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
};

export default EditorSidebar;
