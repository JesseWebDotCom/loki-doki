import type { CharacterStyle } from "./styles";

// Ported verbatim from maipai-home-v2.

export type Viseme =
  | "closed"
  | "neutral"
  | "open"
  | "o"
  | "wide"
  | "p"
  | "b"
  | "m";

type StyleVisemeMap = {
  mouths: Record<Viseme, string>;
  blinkEye: string | null;
  defaultEye: string | null;
};

const MAPS: Record<CharacterStyle, StyleVisemeMap> = {
  avataaars: {
    mouths: {
      closed: "default",
      neutral: "eating",
      open: "screamOpen",
      o: "screamOpen",
      wide: "grimace",
      p: "default",
      b: "default",
      m: "default",
    },
    blinkEye: "closed",
    defaultEye: "default",
  },
  bottts: {
    mouths: {
      closed: "smile01",
      neutral: "grill02",
      open: "square01",
      o: "square02",
      wide: "smile02",
      p: "grill01",
      b: "grill01",
      m: "grill01",
    },
    blinkEye: "__overlay__",
    defaultEye: null,
  },
  "toon-head": {
    mouths: {
      closed: "smile",
      neutral: "laugh",
      open: "agape",
      o: "agape",
      wide: "laugh",
      p: "smile",
      b: "smile",
      m: "smile",
    },
    blinkEye: "bow",
    defaultEye: "happy",
  },
};

export function mouthForViseme(style: CharacterStyle, viseme: Viseme): string {
  return MAPS[style].mouths[viseme] ?? MAPS[style].mouths.neutral;
}

export function blinkEyeFor(style: CharacterStyle): string | null {
  return MAPS[style].blinkEye;
}

export function defaultEyeFor(style: CharacterStyle): string | null {
  return MAPS[style].defaultEye;
}

export function lookUpEyeFor(style: CharacterStyle): string | null {
  switch (style) {
    case "avataaars":
      return "eyeRoll";
    case "toon-head":
      return null;
    case "bottts":
    default:
      return null;
  }
}
