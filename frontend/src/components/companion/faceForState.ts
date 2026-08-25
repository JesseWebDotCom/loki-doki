import type { CharacterStyle } from "./styles";
import type { HeadTiltState } from "./useHeadTilt";

// Ported verbatim from maipai-home-v2.

export interface FaceOverride {
  mouth?: string;
  eyes?: string;
  eyebrows?: string;
}

type StateMap = Partial<Record<CharacterStyle, FaceOverride>>;

const FACE: Partial<Record<HeadTiltState, StateMap>> = {
  sick: {
    avataaars: { mouth: "vomit", eyes: "cry", eyebrows: "sadConcerned" },
    "toon-head": { mouth: "sad", eyes: "humble", eyebrows: "sad" },
    bottts: { mouth: "bite", eyes: "sensor" },
  },
  listening: {
    avataaars: { mouth: "twinkle", eyes: "default", eyebrows: "defaultNatural" },
    "toon-head": { mouth: "smile", eyes: "wide", eyebrows: "raised" },
    bottts: { mouth: "smile02", eyes: "happy" },
  },
  angry: {
    avataaars: { mouth: "grimace", eyes: "squint", eyebrows: "angryNatural" },
    "toon-head": { mouth: "angry", eyes: "wide", eyebrows: "angry" },
    bottts: { mouth: "bite", eyes: "dizzy" },
  },
  sad: {
    avataaars: { mouth: "sad", eyes: "cry", eyebrows: "sadConcerned" },
    "toon-head": { mouth: "sad", eyes: "humble", eyebrows: "sad" },
    bottts: { mouth: "square01", eyes: "sensor" },
  },
  shocked: {
    avataaars: { mouth: "screamOpen", eyes: "surprised", eyebrows: "raisedExcited" },
    "toon-head": { mouth: "agape", eyes: "wide", eyebrows: "raised" },
    bottts: { mouth: "square02", eyes: "roundFrame02" },
  },
  thinking: {
    avataaars: { mouth: "serious", eyes: "eyeRoll", eyebrows: "raisedExcitedNatural" },
    "toon-head": { mouth: "smile", eyebrows: "neutral" },
    bottts: { mouth: "grill02", eyes: "happy" },
  },
};

export function faceForState(
  state: HeadTiltState,
  style: CharacterStyle,
): FaceOverride | null {
  return FACE[state]?.[style] ?? null;
}
