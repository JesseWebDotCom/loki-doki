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
    id: 'micah',
    primary_name: 'Micah',
    domain: 'DiceBear Micah',
  },
  {
    id: 'notionists',
    primary_name: 'Nori',
    domain: 'DiceBear Notionists',
  },
  {
    id: 'adventurerNeutral',
    primary_name: 'Ari',
    domain: 'DiceBear Adventurer Neutral',
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
