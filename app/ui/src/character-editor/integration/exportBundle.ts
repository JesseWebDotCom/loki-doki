import { createAvatar } from '@dicebear/core';
import * as collections from '@dicebear/collection';
import type { CharacterOptions } from '@/character-editor/context/CharacterContext';
import { buildCharacterPackageManifest, deriveIdentityKey } from '@/character-editor/integration/packageManifest';
import { validateCharacterPackage } from '@/character-editor/integration/packageValidation';

function buildAvatarLogoDataUrl(options: CharacterOptions) {
  const selectedCollection =
    (collections as unknown as Record<string, Parameters<typeof createAvatar>[0]>)[options.style] ||
    collections.avataaars;

  const avatarOptions: Record<string, unknown> = {
    seed: options.seed || options.name || 'Character',
    flip: options.flip,
    rotate: options.rotate,
    radius: options.radius,
    scale: 100,
  };

  if (options.top && options.top[0] !== 'seed') avatarOptions.top = options.top;
  if (options.accessories && options.accessories[0] !== 'seed') avatarOptions.accessories = options.accessories;
  if (options.eyes && options.eyes[0] !== 'seed') avatarOptions.eyes = options.eyes;
  if (options.mouth && options.mouth[0] !== 'seed') avatarOptions.mouth = options.mouth;
  if (options.clothing && options.clothing[0] !== 'seed') avatarOptions.clothing = options.clothing;
  if (options.clothingGraphic && options.clothingGraphic[0] !== 'seed') avatarOptions.clothingGraphic = options.clothingGraphic;
  if (options.facialHair && options.facialHair[0] !== 'seed') avatarOptions.facialHair = options.facialHair;
  if (options.hairColor && options.hairColor[0] !== 'seed') avatarOptions.hairColor = options.hairColor;
  if (options.skinColor && options.skinColor[0] !== 'seed') avatarOptions.skinColor = options.skinColor;
  if (options.clothesColor && options.clothesColor[0] !== 'seed') avatarOptions.clothesColor = options.clothesColor;
  if (options.accessoriesColor && options.accessoriesColor[0] !== 'seed') avatarOptions.accessoriesColor = options.accessoriesColor;
  if (options.eyebrows && options.eyebrows[0] !== 'seed') avatarOptions.eyebrows = options.eyebrows;

  const svg = createAvatar(selectedCollection, avatarOptions).toString();
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function buildCharacterEditorBundle(options: CharacterOptions) {
  const manifest = buildCharacterPackageManifest(options);
  const validation = validateCharacterPackage(options);

  return {
    exported_at: new Date().toISOString(),
    identity_key: deriveIdentityKey(options),
    manifest,
    logo_data_url: buildAvatarLogoDataUrl(options),
    editor_state: options,
    validation,
  };
}
