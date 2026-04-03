import React from 'react';

import { useAudio } from '@/character-editor/context/AudioContext';
import { useCharacter } from '@/character-editor/context/CharacterContext';
import { useVoice } from '@/character-editor/context/VoiceContext';
import { BrainSection } from '@/character-editor/components/sidebar/sections/BrainSection';
import { VoiceSection } from '@/character-editor/components/sidebar/sections/VoiceSection';

export const TestTab: React.FC = () => {
  const audio = useAudio();
  const voice = useVoice();
  const { brain, sendToBrain } = useCharacter();
  const bodyState = typeof brain.value === 'string' ? brain.value : 'body' in brain.value ? String(brain.value.body) : 'active';

  return (
    <div className="space-y-6 pb-6">
      <BrainSection {...audio} bodyState={bodyState} sendToBrain={sendToBrain} />
      <VoiceSection {...voice} />
    </div>
  );
};
