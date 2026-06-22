// RMS-driven mouth fallback for sentences without phoneme alignment.
// Ported verbatim from v2. Used when `phonemes[]` is missing/empty — which is
// the v1 path, since Piper/clone sidecars return PCM only.

import type { VisemeId } from "./phonemeViseme";

export const RMS_BIN_MS = 50;

const RMS_FLOOR = 0.005; // absolute silence floor — anything below = closed
const RMS_REL_FRAC = 0.18; // adaptive silence threshold = max(floor, peak × this)
const RMS_LOUD_FRAC = 0.6; // bin energy ≥ peak × this → wide-vowel shape

// Wide-vowel rotation cycled per detected syllable so successive words don't all
// read as the same open "O" shape.
const SYLLABLE_VOWELS: VisemeId[] = ["aa", "e", "ih", "oh", "ou", "ay"];

export function computeRmsBins(pcm: Float32Array, sampleRate: number, binMs: number): number[] {
  const samplesPerBin = Math.max(1, Math.floor((sampleRate * binMs) / 1000));
  const bins: number[] = [];
  for (let start = 0; start < pcm.length; start += samplesPerBin) {
    const end = Math.min(start + samplesPerBin, pcm.length);
    let sumSq = 0;
    for (let i = start; i < end; i += 1) sumSq += pcm[i]! * pcm[i]!;
    bins.push(Math.sqrt(sumSq / Math.max(1, end - start)));
  }
  return bins;
}

export function rmsToViseme(rms: number): VisemeId {
  return rms > 0.01 ? "aa" : "sil";
}

export function binsToVisemes(bins: number[]): VisemeId[] {
  if (bins.length === 0) return [];

  let peak = 0;
  for (const b of bins) if (b > peak) peak = b;
  const threshold = Math.max(RMS_FLOOR, peak * RMS_REL_FRAC);
  const loud = peak * RMS_LOUD_FRAC;

  const raw = bins.map((b) => b >= threshold);
  const voiced = raw.slice();
  for (let i = 1; i < voiced.length - 1; i += 1) {
    if (!raw[i] && raw[i - 1] && raw[i + 1]) voiced[i] = true;
    if (raw[i] && !raw[i - 1] && !raw[i + 1]) voiced[i] = false;
  }

  const out: VisemeId[] = [];
  let inSyllable = false;
  let syllableIdx = -1;
  for (let i = 0; i < bins.length; i += 1) {
    if (!voiced[i]) {
      out.push("sil");
      inSyllable = false;
      continue;
    }
    if (!inSyllable) {
      inSyllable = true;
      syllableIdx += 1;
    }
    const wide = SYLLABLE_VOWELS[syllableIdx % SYLLABLE_VOWELS.length]!;
    out.push(bins[i]! >= loud ? wide : narrowerShape(wide));
  }
  return out;
}

function narrowerShape(wide: VisemeId): VisemeId {
  switch (wide) {
    case "aa": return "ih";
    case "e": return "ih";
    case "ih": return "er";
    case "oh": return "ou";
    case "ou": return "er";
    case "ay": return "e";
    default: return "er";
  }
}
