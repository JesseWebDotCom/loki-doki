export interface CharacterStyle {
  id: string;
  primary_name: string;
  domain: string;
  thumbnail?: string;
}

export const DEFAULT_VOICE_MODEL = 'en-us-lessac-medium.onnx';

export const FEATURED_CHARACTERS: CharacterStyle[] = [
  {
    id: 'bottts',
    primary_name: 'Botts',
    domain: 'DiceBear Botts',
  },
  {
    id: 'bottts-neutral',
    primary_name: 'botts neutral',
    domain: 'DiceBear Botts Neutral',
  },
  {
    id: 'avataaars',
    primary_name: 'vataraars',
    domain: 'DiceBear Avataaars',
  },
  {
    id: 'avataaars-neutral',
    primary_name: 'avataars nuetral',
    domain: 'DiceBear Avataaars Neutral',
  },
  {
    id: 'fun-emoji',
    primary_name: 'fun emoji',
    domain: 'DiceBear Fun Emoji',
  },
  {
    id: 'toon-head',
    primary_name: 'toon head',
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
