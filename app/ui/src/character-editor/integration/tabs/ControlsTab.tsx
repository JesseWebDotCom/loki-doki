import React from 'react';
import { Settings2, Shapes, Sparkles } from 'lucide-react';
import { useAudio } from '@/character-editor/context/AudioContext';
import { useCharacter } from '@/character-editor/context/CharacterContext';
import { useVoice } from '@/character-editor/context/VoiceContext';
import { IdentitySection } from '@/character-editor/components/sidebar/sections/IdentitySection';
import { BrainSection } from '@/character-editor/components/sidebar/sections/BrainSection';
import { VoiceSection } from '@/character-editor/components/sidebar/sections/VoiceSection';
import { ConfigSection } from '@/character-editor/components/sidebar/sections/ConfigSection';
import { RiggingSection } from '@/character-editor/components/sidebar/sections/RiggingSection';
import { QuantumRiggingSection } from '@/character-editor/components/sidebar/sections/QuantumRiggingSection';
import { Input } from "@/character-editor/components/ui/input";
import { Button } from "@/character-editor/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/character-editor/components/ui/select";
import { FEATURED_CHARACTERS } from '@/character-editor/constants/characters';

export const ControlsTab: React.FC = () => {
  const { options, updateOption, resetToSeed, brain, sendToBrain } = useCharacter();
  const audio = useAudio();
  const voice = useVoice();
  const bodyState = typeof brain.value === 'string' ? brain.value : 'body' in brain.value ? String(brain.value.body) : 'active';
  const randomSeed = () => Math.random().toString(36).slice(2, 10);

  return (
    <div className="space-y-6">
      <section id="character-type" className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h3 className="ce-title flex items-center gap-2 text-[var(--app-icon-primary)]">
            <Shapes className="w-2.5 h-2.5" /> Character Type
          </h3>
          <Button
            onClick={() => resetToSeed(randomSeed())}
            variant="outline"
            type="button"
            className="h-8 rounded-xl border-[color:var(--app-border-strong)] bg-[color:var(--app-accent-soft)] px-3 text-[10px] font-black uppercase tracking-[0.18em] text-[var(--app-text)] hover:bg-[color:var(--app-accent-soft)]/80"
          >
            <Sparkles className="mr-2 h-3.5 w-3.5" />
            Random Seed
          </Button>
        </div>
        <div className="rounded-2xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] p-4 shadow-inner">
          <div className="space-y-2">
            <label className="ce-label px-1 text-[var(--app-text-muted)]">Avatar Style</label>
            <Select value={options.style} onValueChange={(value) => value && updateOption('style', value)}>
              <SelectTrigger className="h-10 border-[color:var(--app-border)] bg-[var(--app-bg-panel)] text-[var(--app-text)]">
                <SelectValue placeholder="Select a character type" />
              </SelectTrigger>
              <SelectContent className="border-[color:var(--app-border)] bg-[var(--app-bg-panel)] text-[var(--app-text)]">
                {FEATURED_CHARACTERS.map((character) => (
                  <SelectItem key={character.id} value={character.id}>
                    {character.domain}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      <IdentitySection options={options} updateOption={updateOption} resetToSeed={resetToSeed} />
      <BrainSection {...audio} bodyState={bodyState} sendToBrain={sendToBrain} />
      <VoiceSection {...voice} />
      <ConfigSection options={options} updateOption={updateOption} />
      <RiggingSection options={options} updateOption={updateOption} resetToSeed={resetToSeed} />
      <QuantumRiggingSection options={options} updateOption={updateOption} />

      <section id="stage" className="space-y-3 pb-6">
        <h3 className="ce-title flex items-center gap-2 px-1 text-[var(--app-icon-primary)]">
          <Settings2 className="w-2.5 h-2.5" /> Stage Positioning
        </h3>
        <div className="grid grid-cols-1 gap-3 rounded-2xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] p-4 shadow-inner">
          <div className="space-y-2">
            <div className="flex justify-between px-1">
              <label className="ce-label text-[var(--app-text-muted)]">Scale</label>
              <span className="text-[9px] font-mono font-bold text-[var(--app-accent)]">{options.scale}%</span>
            </div>
            <Input type="range" min="50" max="180" value={options.scale} onChange={(e) => updateOption('scale', parseInt(e.target.value, 10))} className="h-1 border-none bg-[var(--app-bg-panel)] accent-[var(--app-accent)]" />
          </div>
        </div>
      </section>
    </div>
  );
};
