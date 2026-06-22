// IPA / X-SAMPA phoneme → viseme mapping. Ported from v2 viseme-map.ts.
// The 15-id internal VisemeId set collapses to v3's `Viseme` union (the 5
// canonical mouth shapes the DiceBear renderer paints) via TO_CANONICAL.

import type { Viseme } from "./visemeMap";

export const VISEME_IDS = [
  "sil", "pp", "ff", "th", "dd", "kk", "ch", "rr",
  "aa", "e", "ih", "oh", "ou", "er", "ay",
] as const;
export type VisemeId = (typeof VISEME_IDS)[number];

// Multi-char keys must precede overlapping single-char prefixes; lookup tries
// the longest match first via length-sorted iteration.
export const IPA_TO_VISEME: Record<string, VisemeId> = {
  aI: "ay", aU: "ay", OI: "ay", eI: "ay",
  tS: "ch", dZ: "ch", S: "ch", Z: "ch", "ʃ": "ch", "ʒ": "ch",
  T: "th", D: "th", "θ": "th", "ð": "th",
  p: "pp", b: "pp", m: "pp",
  f: "ff", v: "ff",
  k: "kk", g: "kk", N: "kk", "ŋ": "kk",
  t: "dd", d: "dd", n: "dd", s: "dd", z: "dd", l: "dd",
  r: "rr", "ɹ": "rr",
  A: "aa", a: "aa", Q: "aa", "æ": "aa", "ɑ": "aa", "ɒ": "aa",
  E: "e", e: "e", "ɛ": "e",
  I: "ih", i: "ih", "ɪ": "ih",
  O: "oh", o: "oh", "ɔ": "oh",
  U: "ou", u: "ou", "ʊ": "ou",
  "3": "er", "@": "er", "ə": "er", "ɜ": "er",
}

const SORTED_KEYS = Object.keys(IPA_TO_VISEME).sort((a, b) => b.length - a.length)

export function phonemeToViseme(ph: string): VisemeId {
  if (!ph) return "sil"
  for (const key of SORTED_KEYS) {
    if (ph === key) return IPA_TO_VISEME[key]!
  }
  return "sil"
}

// Maps the internal 15-id set onto v3's renderer-facing `Viseme` union.
const TO_CANONICAL: Record<VisemeId, Viseme> = {
  sil: "closed",
  pp: "closed",
  ff: "closed",
  th: "neutral",
  dd: "neutral",
  kk: "neutral",
  ch: "o",
  rr: "neutral",
  aa: "open",
  e: "open",
  ih: "wide",
  oh: "o",
  ou: "o",
  er: "neutral",
  ay: "open",
}

export function visemeToCanonical(v: VisemeId): Viseme {
  return TO_CANONICAL[v] ?? "closed"
}
