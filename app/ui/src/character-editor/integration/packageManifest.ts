import type { CharacterOptions } from '@/character-editor/context/CharacterContext';
import type { CharacterPackageManifest } from '@/character-editor/integration/contracts';

function slugifySegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function deriveCharacterId(options: CharacterOptions) {
  const name = slugifySegment(options.name?.trim() || options.seed || 'character');
  const domain = slugifySegment(options.identity_key?.trim() || 'lokidoki');
  return [name, domain].filter(Boolean).join('_');
}

export function deriveIdentityKey(options: CharacterOptions) {
  if (options.identity_key?.trim()) {
    return slugifySegment(options.identity_key);
  }
  return 'lokidoki';
}

export function buildCharacterPackageManifest(
  options: CharacterOptions
): CharacterPackageManifest {
  const identityKey = deriveIdentityKey(options);
  const primaryName = options.name?.trim() || options.seed || 'Character';
  const characterId = deriveCharacterId(options);

  return {
    primary_name: primaryName,
    domain: identityKey,
    identity_key: identityKey,
    teaser: options.teaser?.trim() || '',
    phonetic_spelling: options.phonetic_spelling?.trim() || '',
    behavior_style:
      options.persona_prompt?.trim() ||
      `You are ${primaryName}, a DiceBear-based assistant with a ${options.style} visual style.`,
    svg_file: `${characterId}.svg`,
    voice_model: options.voice_model,
    wakeword_model: options.wakeword_model_id,
    face_center: {
      x: 120,
      y: 95,
    },
  };
}
