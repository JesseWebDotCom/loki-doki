import type { CharacterOptions } from '@/character-editor/context/CharacterContext';
import { deriveIdentityKey } from '@/character-editor/integration/packageManifest';

export type ValidationLevel = 'pass' | 'warning' | 'fail';

export interface ValidationCheck {
  id: string;
  label: string;
  level: ValidationLevel;
  detail: string;
}

export function validateCharacterPackage(options: CharacterOptions): ValidationCheck[] {
  const identityKey = deriveIdentityKey(options);

  return [
    {
      id: 'style',
      label: 'DiceBear style selected',
      level: options.style ? 'pass' : 'fail',
      detail: options.style
        ? `Using ${options.style} as the active renderer style.`
        : 'A DiceBear style is required.',
    },
    {
      id: 'identity',
      label: 'Identity key derivable',
      level: identityKey ? 'pass' : 'fail',
      detail: identityKey
        ? `Package identity resolves to ${identityKey}.`
        : 'Identity key could not be derived from the current settings.',
    },
    {
      id: 'persona',
      label: 'Persona prompt present',
      level: options.persona_prompt?.trim() ? 'pass' : 'warning',
      detail: options.persona_prompt?.trim()
        ? 'Behavior style is present for manifest generation.'
        : 'No persona prompt set yet. A fallback behavior string will be used.',
    },
    {
      id: 'voice',
      label: 'Voice model configured',
      level: options.voice_model ? 'pass' : 'warning',
      detail: options.voice_model
        ? `Voice model ${options.voice_model} will be referenced in the package.`
        : 'No voice model selected. The package can still be exported for editor testing.',
    },
    {
      id: 'legacy',
      label: 'Custom prototype excluded',
      level: options.style === 'kyle_southpark' ? 'warning' : 'pass',
      detail:
        options.style === 'kyle_southpark'
          ? 'This style is a lab-only prototype and is outside the supported editor path.'
          : 'Current settings stay within the supported DiceBear-first editor scope.',
    },
  ];
}
