import type { CharacterOptions } from '@/character-editor/context/CharacterContext';
import type { CharacterPackageManifest } from '@/character-editor/integration/contracts';

function slugifySegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function deriveIdentityKey(options: CharacterOptions) {
  if (options.identity_key?.trim()) {
    return slugifySegment(options.identity_key);
  }

  const primary = options.name?.trim() || options.seed || 'character';
  const domain = options.style || 'dicebear';
  return [slugifySegment(primary), slugifySegment(domain)]
    .filter(Boolean)
    .join('_');
}

export function buildCharacterPackageManifest(
  options: CharacterOptions
): CharacterPackageManifest {
  const identityKey = deriveIdentityKey(options);
  const primaryName = options.name?.trim() || options.seed || 'Character';

  return {
    primary_name: primaryName,
    domain: options.style,
    identity_key: identityKey,
    behavior_style:
      options.persona_prompt?.trim() ||
      `You are ${primaryName}, a DiceBear-based assistant with a ${options.style} visual style.`,
    svg_file: `${identityKey}.svg`,
    voice_model: options.voice_model,
    face_center: {
      x: 120,
      y: 95,
    },
  };
}
