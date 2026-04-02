import type { ReactNode } from 'react';

import { AudioProvider } from '@/character-editor/context/AudioContext';
import { CharacterProvider } from '@/character-editor/context/CharacterContext';
import { VoiceProvider } from '@/character-editor/context/VoiceContext';

interface CharacterRuntimeProvidersProps {
  children: ReactNode;
}

export default function CharacterRuntimeProviders({
  children,
}: CharacterRuntimeProvidersProps) {
  return (
    <AudioProvider>
      <VoiceProvider>
        <CharacterProvider>{children}</CharacterProvider>
      </VoiceProvider>
    </AudioProvider>
  );
}
