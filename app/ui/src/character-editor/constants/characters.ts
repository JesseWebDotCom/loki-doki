export interface CharacterStyle {
  id: string;
  primary_name: string;
  domain: string;
  thumbnail?: string;
}

export const DEFAULT_VOICE_MODEL = 'en-us-lessac-medium.onnx';

export const FEATURED_CHARACTERS: CharacterStyle[] = [
  {
    id: 'avataaars',
    primary_name: 'Avery',
    domain: 'DiceBear Avataaars',
  },
  {
    id: 'bottts',
    primary_name: 'Bottts',
    domain: 'DiceBear Bottts',
  },
  {
    id: 'toonHead',
    primary_name: 'Toon Head',
    domain: 'DiceBear Toon Head',
  },
];

export function getCharacterStyleLabel(styleId: string) {
  return FEATURED_CHARACTERS.find((character) => character.id === styleId)?.domain ?? styleId;
}

export function buildDefaultPersonaPrompt(name: string, styleId: string) {
  const styleLabel = getCharacterStyleLabel(styleId);
  return `You are ${name}, a helpful assistant rendered with the ${styleLabel} DiceBear style.`;
}

export function buildDefaultDescription(name: string, styleId: string) {
  const styleLabel = getCharacterStyleLabel(styleId);
  return `${name} is a LokiDoki character using the ${styleLabel} DiceBear renderer.`;
}
