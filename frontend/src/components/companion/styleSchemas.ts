// Rigging field definitions for the studio editor. Values validated against
// @dicebear/collection v9. Animation owns eyes/mouth/eyebrows, so those are not
// exposed here — only the static look (hair, clothing, colors, background).

export interface RigOption { value: string; label?: string; color?: string }
export interface RigField { key: string; label: string; options: RigOption[]; isColor?: boolean; hasNone?: boolean }

// Only the three styles the rigged avatar pipeline (splitDicebearSvg/faceForState/
// visemeMap) supports — these are the ones with correct head-tilt + expression rigging.
export const AVATAR_STYLES: { id: string; label: string }[] = [
  { id: 'avataaars', label: 'Avataaars' },
  { id: 'bottts', label: 'Bottts' },
  { id: 'toon-head', label: 'Toon Head' },
]

const color = (hex: string): RigOption => ({ value: hex, color: hex === 'transparent' ? undefined : `#${hex}`, label: hex })

export const BACKGROUND_FIELD: RigField = {
  key: 'backgroundColor',
  label: 'Background',
  isColor: true,
  options: ['transparent', 'b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf', 'f1f5f9', '1e293b'].map(color),
}

const AVATAAARS_FIELDS: RigField[] = [
  {
    key: 'top', label: 'Hair / Hat', hasNone: false,
    options: ['shortFlat', 'shortRound', 'shortCurly', 'shortWaved', 'theCaesar', 'bob', 'curly', 'dreads01', 'frizzle', 'shaggy', 'sides', 'bigHair', 'hat', 'turban', 'winterHat1'].map((v) => ({ value: v })),
  },
  { key: 'hairColor', label: 'Hair color', isColor: true, options: ['2c1b18', '4a312c', '724130', 'a55728', 'b58143', 'd6b370', '1a1a1a', 'e8e1e1', 'ecdcbf'].map(color) },
  { key: 'facialHair', label: 'Facial hair', hasNone: true, options: ['beardMedium', 'beardLight', 'beardMajestic', 'moustacheFancy', 'moustacheMagnum'].map((v) => ({ value: v })) },
  { key: 'clothing', label: 'Clothing', options: ['hoodie', 'blazerAndShirt', 'blazerAndSweater', 'collarAndSweater', 'graphicShirt', 'overall', 'shirtCrewNeck', 'shirtScoopNeck', 'shirtVNeck'].map((v) => ({ value: v })) },
  { key: 'clothesColor', label: 'Clothes color', isColor: true, options: ['3c4e5e', '262e33', '65c9ff', '5199e4', '25557c', 'a7ffc4', 'ff488e', 'ff5c5c', 'ffffff'].map(color) },
  { key: 'skinColor', label: 'Skin', isColor: true, options: ['ffdbb4', 'edb98a', 'd08b5b', 'ae5d29', '614335'].map(color) },
  { key: 'accessories', label: 'Accessories', hasNone: true, options: ['prescription01', 'prescription02', 'round', 'sunglasses', 'wayfarers', 'kurt'].map((v) => ({ value: v })) },
]

const BOTTTS_FIELDS: RigField[] = [
  { key: 'face', label: 'Face', options: ['round01', 'round02', 'square01', 'square02', 'square03', 'square04'].map((v) => ({ value: v })) },
  { key: 'top', label: 'Antenna', hasNone: true, options: ['antenna', 'antennaCrooked', 'bulb01', 'glowingBulb01', 'glowingBulb02', 'horns', 'lights', 'pyramid', 'radar'].map((v) => ({ value: v })) },
  { key: 'sides', label: 'Sides', hasNone: true, options: ['antenna01', 'antenna02', 'cables01', 'cables02', 'round', 'square', 'squareAssymetric'].map((v) => ({ value: v })) },
  { key: 'texture', label: 'Texture', hasNone: true, options: ['camo01', 'camo02', 'circuits', 'dirty01', 'dirty02', 'dots', 'grunge01', 'grunge02'].map((v) => ({ value: v })) },
  { key: 'baseColor', label: 'Color', isColor: true, options: ['d9d9d9', 'acacac', '6b7280', '3b82f6', '60a5fa', '22c55e', 'ef4444', 'f59e0b', 'ec4899', '8b5cf6', '1e293b'].map(color) },
]

const TOON_HEAD_FIELDS: RigField[] = [
  { key: 'hair', label: 'Hair', hasNone: true, options: ['sideComed', 'undercut', 'spiky', 'bun'].map((v) => ({ value: v })) },
  { key: 'rearHair', label: 'Rear hair', hasNone: true, options: ['longStraight', 'longWavy', 'shoulderHigh', 'neckHigh'].map((v) => ({ value: v })) },
  { key: 'hairColor', label: 'Hair color', isColor: true, options: ['2c1b18', '4a312c', '724130', 'a55728', 'b58143', 'd6b370', '1a1a1a', 'e8e1e1', 'ecdcbf'].map(color) },
  { key: 'beard', label: 'Beard', hasNone: true, options: ['moustacheTwirl', 'fullBeard', 'chin', 'chinMoustache', 'longBeard'].map((v) => ({ value: v })) },
  { key: 'clothes', label: 'Clothes', options: ['turtleNeck', 'openJacket', 'dress', 'shirt', 'tShirt'].map((v) => ({ value: v })) },
  { key: 'clothesColor', label: 'Clothes color', isColor: true, options: ['3c4e5e', '262e33', '65c9ff', '5199e4', '25557c', 'a7ffc4', 'ff488e', 'ff5c5c', 'ffffff'].map(color) },
  { key: 'skinColor', label: 'Skin', isColor: true, options: ['ffdbb4', 'edb98a', 'd08b5b', 'ae5d29', '614335'].map(color) },
]

export function fieldsForStyle(style: string): RigField[] {
  if (style === 'avataaars') return [...AVATAAARS_FIELDS, BACKGROUND_FIELD]
  if (style === 'bottts')    return [...BOTTTS_FIELDS,    BACKGROUND_FIELD]
  if (style === 'toon-head') return [...TOON_HEAD_FIELDS, BACKGROUND_FIELD]
  return [BACKGROUND_FIELD]
}

export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
}
