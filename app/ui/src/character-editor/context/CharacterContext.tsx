import React, { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useMachine } from '@xstate/react';
import type { SnapshotFrom } from 'xstate';
import { characterMachine, type CharacterEvent } from '../machines/CharacterMachine';
import { useAudio } from './AudioContext';
import { buildDefaultDescription, buildDefaultPersonaPrompt, DEFAULT_VOICE_MODEL } from '@/character-editor/constants/characters';
import { deriveIdentityKey } from '@/character-editor/integration/packageManifest';

export type CharacterOptions = {
  character_id?: string;
  name?: string;
  identity_key?: string;
  description?: string;
  teaser?: string;
  phonetic_spelling?: string;
  persona_prompt?: string;
  preferred_response_style?: string;
  voice_model?: string;
  default_voice_source_name?: string;
  default_voice_config_source_name?: string;
  default_voice_upload_data_url?: string;
  default_voice_config_upload_data_url?: string;
  wakeword_model_id?: string;
  wakeword_source_name?: string;
  wakeword_upload_data_url?: string;
  style: string;
  seed: string;
  flip: boolean;
  rotate: number;
  scale: number;
  radius: number;
  backgroundColor: string[];
  backgroundType: string[];
  backgroundRotation: number[];
  top?: string[];
  accessories?: string[];
  accessoriesColor?: string[];
  clothing?: string[];
  clothingGraphic?: string[];
  clothesColor?: string[];
  eyebrows?: string[];
  eyes?: string[];
  facialHair?: string[];
  facialHairColor?: string[];
  hairColor?: string[];
  hatColor?: string[];
  mouth?: string[];
  skinColor?: string[];
  kyle_tuning?: {
    eyeXOffset?: number;
    eyeYOffset?: number;
    eyeSpacing?: number;
    eyeSize?: number;
    eyeRoundness?: number;
    eyeRotate?: number;
    eyelidRotate?: number;
    browXOffset?: number;
    browYOffset?: number;
    browSpacing?: number;
    browThickness?: number;
    browWidth?: number;
    browRotate?: number;
    pupilSize?: number;
    pupilXOffset?: number;
    pupilYOffset?: number;
    eyeStateOverride?: string;
    visemeOverride?: string;
    mouthXOffset?: number;
    mouthYOffset?: number;
    mouthThickness?: number;
    mouthLength?: number;
    mouthCurve?: number;
    mouthRotate?: number;
    mouthOpenShape?: 'oval' | 'triangle';
    mouthTeeth?: number;
    mouthTongue?: number;
  };
  headRotation?: number;
  headBob?: number;
};

type CharacterContextType = {
  options: CharacterOptions;
  setOptions: (options: CharacterOptions) => void;
  updateOption: <K extends keyof CharacterOptions>(key: K, value: CharacterOptions[K]) => void;
  resetToSeed: (seed: string) => void;
  loadManifest: (identity_key: string) => Promise<void>;
  saveManifest: () => Promise<boolean>;
  brain: SnapshotFrom<typeof characterMachine>;
  sendToBrain: (event: CharacterEvent) => void;
};

const defaultOptions: CharacterOptions = {
  character_id: '',
  name: 'Avery',
  identity_key: 'lokidoki',
  description: buildDefaultDescription('Avery', 'avataaars'),
  teaser: 'Friendly local helper voice',
  phonetic_spelling: '',
  persona_prompt: buildDefaultPersonaPrompt('Avery', 'avataaars'),
  preferred_response_style: 'balanced',
  voice_model: DEFAULT_VOICE_MODEL,
  default_voice_source_name: '',
  default_voice_config_source_name: '',
  default_voice_upload_data_url: '',
  default_voice_config_upload_data_url: '',
  wakeword_model_id: '',
  wakeword_source_name: '',
  wakeword_upload_data_url: '',
  style: 'avataaars',
  seed: 'Avery',
  flip: false,
  rotate: 0,
  scale: 100,
  radius: 0,
  backgroundColor: ['transparent'],
  backgroundType: ['solid'],
  backgroundRotation: [0],
  headRotation: 0,
  headBob: 0,
};

export const CharacterContext = createContext<CharacterContextType | undefined>(undefined);

const LOCAL_STORAGE_KEY = 'loki_character_options';

export const CharacterProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [options, setOptions] = useState<CharacterOptions>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
      return saved ? { ...defaultOptions, ...JSON.parse(saved) } : defaultOptions;
    } catch (err) {
      console.warn('Invalid saved character config, falling back to defaults.', err);
      return defaultOptions;
    }
  });
  const [state, send] = useMachine(characterMachine);
  const { peakVolume, isListening, sensitivity, reflexesEnabled } = useAudio();

  useEffect(() => {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(options));
  }, [options]);

  useEffect(() => {
    const fallbackName = options.name?.trim() || options.seed || 'Character';
    const fallbackDescription =
      options.description?.trim() || buildDefaultDescription(fallbackName, options.style);
    const fallbackPersona =
      options.persona_prompt?.trim() || buildDefaultPersonaPrompt(fallbackName, options.style);
    const fallbackVoice = options.voice_model || DEFAULT_VOICE_MODEL;
    const fallbackIdentity = options.identity_key || deriveIdentityKey({
      ...options,
      name: fallbackName,
      persona_prompt: fallbackPersona,
      voice_model: fallbackVoice,
    });

    if (
      options.name !== fallbackName ||
      options.description !== fallbackDescription ||
      options.persona_prompt !== fallbackPersona ||
      options.voice_model !== fallbackVoice ||
      options.identity_key !== fallbackIdentity
    ) {
      setOptions((prev) => ({
        ...prev,
        name: fallbackName,
        description: fallbackDescription,
        persona_prompt: fallbackPersona,
        voice_model: fallbackVoice,
        identity_key: fallbackIdentity,
      }));
    }
  }, [options]);

  useEffect(() => {
     if (!isListening || !reflexesEnabled) return;
     const threshold = 0.95 - (sensitivity * 0.75);
     const isTalking = state.matches({ mouth: 'talking' });
     if (peakVolume > threshold && !state.matches('body.startled') && !isTalking) {
        send({ type: 'STARTLE' });
     }
  }, [peakVolume, isListening, sensitivity, state, send, reflexesEnabled]);

  const updateOption = <K extends keyof CharacterOptions>(key: K, value: CharacterOptions[K]) => {
    setOptions(prev => ({ ...prev, [key]: value }));
    send({ type: 'RESET_IDLE' });
  };

  const resetToSeed = (seed: string) => {
    const nextName = options.name || seed;
    setOptions({
      ...defaultOptions,
      style: options.style,
      seed,
      name: nextName,
      description: buildDefaultDescription(nextName, options.style),
      persona_prompt: buildDefaultPersonaPrompt(nextName, options.style),
      voice_model: options.voice_model || DEFAULT_VOICE_MODEL,
      identity_key: deriveIdentityKey({
        ...defaultOptions,
        style: options.style,
        seed,
        name: nextName,
        identity_key: options.identity_key || defaultOptions.identity_key,
      }),
    });
    send({ type: 'RESET_IDLE' });
  };

  const loadManifest = async (id: string) => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!saved) {
        return;
      }
      const parsed = { ...defaultOptions, ...JSON.parse(saved) } as CharacterOptions;
      if ((parsed.identity_key || deriveIdentityKey(parsed)) === id) {
        setOptions(parsed);
      }
    } catch (err) {
      console.warn('Manifest Load Error:', err);
    }
  };

  const saveManifest = async () => {
    try {
      const nextOptions = {
        ...options,
        identity_key: options.identity_key || deriveIdentityKey(options),
      };
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(nextOptions));
      return true;
    } catch (err) {
      console.error('Manifest Save Error:', err);
      return false;
    }
  };

  return (
    <CharacterContext.Provider value={{ 
      options, 
      setOptions, 
      updateOption, 
      resetToSeed,
      loadManifest,
      saveManifest,
      brain: state,
      sendToBrain: send
    }}>
      {children}
    </CharacterContext.Provider>
  );
};

export const useCharacter = () => {
  const context = useContext(CharacterContext);
  if (!context) throw new Error('useCharacter must be used within a CharacterProvider');
  return context;
};
