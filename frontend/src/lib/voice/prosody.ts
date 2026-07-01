// Content + punctuation driven prosody for TTS.
//
// Kokoro can't act out an emotion's timbre, but it DOES respond to speech rate
// (a real model input), and we shape loudness with a DSP gain pass on the PCM.
//
// IMPORTANT: emotes (<action>…</action>) were the original signal, but most local
// models don't emit them — real replies are plain text like "Oh no, that's
// concerning!" or "omg that's amazing!". So the PRIMARY driver here is sentiment
// keywords + punctuation, which exist in every reply. Emotes, when present, layer
// on top as a booster.
//
// Output is a per-chunk { rateScale, gain } that rides the request to the backend,
// which multiplies rateScale into the character's base rate and applies gain.

import { extractEmoteMoods, type Mood } from "@/components/companion/moods";

export interface ChunkProsody {
  /** Multiplier on the character's base speech rate (backend clamps the product). */
  rateScale: number;
  /** Linear amplitude gain applied to the synthesized PCM. */
  gain: number;
}

export const NEUTRAL_PROSODY: ChunkProsody = { rateScale: 1, gain: 1 };

// Default swing limit when the character has no `expressiveness` set.
// 1.0 = use the raw targets below as-is. Lower = subtler.
const DEFAULT_EXPRESSIVENESS = 1.0;

// ── Sentiment lexicons (sets the base tone of a chunk) ───────────────────────
// Upbeat/excited → faster + louder.
const EXCITED =
  /\b(omg|wow|whoa|yay+|woo+|woohoo|hooray|awesome|amazing|incredible|fantastic|wonderful|excited|exciting|thrilled|stoked|congrats|congratulations|haha+|hehe+|lol|lmao|yes{2,}|so (?:cool|good|happy)|can'?t wait|love (?:it|this|that))\b/i;
// Down/soft/concerned → slower + softer.
const SOMBER =
  /\b(oh no|so sorry|i'?m sorry|sorry to hear|sadly|unfortunately|regret|concerning|concerned|worried|worry|afraid|terrible|awful|tragic|heartbreaking|devastating|condolences|that'?s (?:tough|rough|hard)|so sad|heartbroken|grief|mourning)\b/i;

// Emote moods → multiplicative booster (only when the model actually emits tags).
const MOOD_BOOST: Partial<Record<Mood, ChunkProsody>> = {
  laugh: { rateScale: 1.08, gain: 1.06 },
  happy: { rateScale: 1.06, gain: 1.04 },
  surprised: { rateScale: 1.08, gain: 1.06 },
  tired: { rateScale: 0.9, gain: 0.9 },
  sad: { rateScale: 0.88, gain: 0.88 },
  sick: { rateScale: 0.92, gain: 0.9 },
  angry: { rateScale: 1.05, gain: 1.08 },
  think: { rateScale: 0.95, gain: 0.97 },
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function countOccurrences(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

// Layer gate (see plans/voice-rebuild.md). Baseline = neutral (no rate/gain swing);
// Layer 3 flips this on to add inflection.
const PROSODY_ENABLED = true;

/**
 * Derive prosody for a raw chunk. Sentiment sets the base; punctuation and
 * emphasis modulate it; emotes (if any) boost. Call BEFORE stripEmotes().
 *
 * `expressiveness` is the character's 0–1 swing setting from the DB (the admin
 * studio slider); null/undefined falls back to the default.
 */
export function prosodyForChunk(rawChunk: string, expressiveness?: number | null): ChunkProsody {
  if (!PROSODY_ENABLED) return NEUTRAL_PROSODY;
  const swing = clamp(expressiveness ?? DEFAULT_EXPRESSIVENESS, 0, 1);
  const t = rawChunk;
  let rate = 1;
  let gain = 1;

  // 1) Sentiment base.
  if (EXCITED.test(t)) {
    rate = 1.14;
    gain = 1.08;
  } else if (SOMBER.test(t)) {
    rate = 0.91; // gently slower — not draggy
    gain = 0.9;
  }

  // 2) Punctuation modulation.
  const bangs = countOccurrences(t, /!/g);
  if (bangs >= 1) {
    rate *= 1.05;
    gain *= 1.06;
  }
  if (bangs >= 3) gain *= 1.05; // shouty
  if (/(\.\.\.|…)/.test(t)) rate *= 0.9; // trailing off / hesitation
  // ALL-CAPS word (≥3 letters, not an acronym mid-word) → emphasis.
  if (/(?:^|\s)[A-Z]{3,}(?:\b|$)/.test(t)) gain *= 1.08;

  // 3) Emote booster (no-op when the model emits no <action> tags).
  const mood = extractEmoteMoods(t).moods[0];
  const boost = mood ? MOOD_BOOST[mood] : undefined;
  if (boost) {
    rate *= boost.rateScale;
    gain *= boost.gain;
  }

  // 4) Scale toward neutral by expressiveness, then clamp to safe ranges.
  const scaledRate = 1 + (rate - 1) * swing;
  const scaledGain = 1 + (gain - 1) * swing;
  return {
    rateScale: clamp(scaledRate, 0.8, 1.25),
    gain: clamp(scaledGain, 0.6, 1.15),
  };
}
