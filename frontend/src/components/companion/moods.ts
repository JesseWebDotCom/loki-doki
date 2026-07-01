import type { CharacterStyle } from "./styles";
import type { FaceOverride } from "./faceForState";
import { ACTION_TAG_RE, ASTERISK_EMOTE_RE } from "@/lib/emoteParser";

// Emotion overlay, distinct from the activity HeadTiltState (idle/thinking/
// speaking). A mood tints the FACE (eyes/eyebrows, and mouth only when NOT
// speaking) so the character can emote *while* lip-syncing. Driven by
// <action>...</action> XML tags the LLM emits — stripped from display/audio
// and translated into avatar animation here.

export type Mood =
  | "neutral"
  | "happy"
  | "laugh"
  | "wink"
  | "love"
  | "surprised"
  | "confused"
  | "tired"
  | "sad"
  | "angry"
  | "sick"
  | "think";

type StateMap = Partial<Record<CharacterStyle, FaceOverride>>;

// Per-style face overrides. Values are drawn from each DiceBear collection's
// schema; unknown values are filtered out by filterOptionsForStyle so a missing
// one degrades gracefully rather than erroring.
const MOOD_FACE: Partial<Record<Mood, StateMap>> = {
  happy: {
    avataaars: { mouth: "smile", eyes: "happy", eyebrows: "raisedExcitedNatural" },
    "toon-head": { mouth: "smile", eyes: "wide", eyebrows: "raised" },
    bottts: { mouth: "smile02", eyes: "happy" },
  },
  laugh: {
    avataaars: { mouth: "smile", eyes: "squint", eyebrows: "raisedExcited" },
    "toon-head": { mouth: "laugh", eyes: "wide", eyebrows: "raised" },
    bottts: { mouth: "smile02", eyes: "happy" },
  },
  wink: {
    avataaars: { mouth: "twinkle", eyes: "wink", eyebrows: "default" },
    "toon-head": { mouth: "smile", eyes: "happy", eyebrows: "raised" },
    bottts: { mouth: "smile01", eyes: "happy" },
  },
  love: {
    avataaars: { mouth: "smile", eyes: "hearts", eyebrows: "raisedExcitedNatural" },
    "toon-head": { mouth: "smile", eyes: "happy", eyebrows: "raised" },
    bottts: { mouth: "smile02", eyes: "happy" },
  },
  surprised: {
    avataaars: { mouth: "screamOpen", eyes: "surprised", eyebrows: "raisedExcited" },
    "toon-head": { mouth: "agape", eyes: "wide", eyebrows: "raised" },
    bottts: { mouth: "square02", eyes: "roundFrame02" },
  },
  confused: {
    avataaars: { mouth: "serious", eyes: "squint", eyebrows: "upDown" },
    "toon-head": { mouth: "smile", eyes: "humble", eyebrows: "neutral" },
    bottts: { mouth: "grill02", eyes: "dizzy" },
  },
  tired: {
    avataaars: { mouth: "serious", eyes: "side", eyebrows: "sadConcerned" },
    "toon-head": { mouth: "sad", eyes: "humble", eyebrows: "sad" },
    bottts: { mouth: "square01", eyes: "sensor" },
  },
  sad: {
    avataaars: { mouth: "sad", eyes: "cry", eyebrows: "sadConcerned" },
    "toon-head": { mouth: "sad", eyes: "humble", eyebrows: "sad" },
    bottts: { mouth: "square01", eyes: "sensor" },
  },
  angry: {
    avataaars: { mouth: "grimace", eyes: "squint", eyebrows: "angryNatural" },
    "toon-head": { mouth: "angry", eyes: "wide", eyebrows: "angry" },
    bottts: { mouth: "bite", eyes: "dizzy" },
  },
  sick: {
    avataaars: { mouth: "vomit", eyes: "cry", eyebrows: "sadConcerned" },
    "toon-head": { mouth: "sad", eyes: "humble", eyebrows: "sad" },
    bottts: { mouth: "bite", eyes: "sensor" },
  },
  think: {
    avataaars: { mouth: "serious", eyes: "eyeRoll", eyebrows: "raisedExcitedNatural" },
    "toon-head": { mouth: "smile", eyebrows: "neutral" },
    bottts: { mouth: "grill02", eyes: "happy" },
  },
};

export function faceForMood(mood: Mood, style: CharacterStyle): FaceOverride | null {
  if (mood === "neutral") return null;
  return MOOD_FACE[mood]?.[style] ?? null;
}

// Moods that get a brief physical flourish (handled by the renderer).
export const BOUNCE_MOODS: ReadonlySet<Mood> = new Set(["laugh", "surprised"]);

// ── Emote text → mood ────────────────────────────────────────────────────────
const EMOTE_MOODS: Array<[RegExp, Mood]> = [
  [/\b(laughs?|laughing|giggles?|chuckles?|cackles?|lol|haha+|hehe+)\b/i, "laugh"],
  [/\b(smiles?|smiling|grins?|beams?|smirks?|claps?|cheers?|waves?|bounces?|hops?|excitedly)\b/i, "happy"],
  [/\b(winks?|winking)\b/i, "wink"],
  [/\b(blush(es|ing)?|swoons?|hearts?|adoring|lovingly)\b/i, "love"],
  [/\b(gasps?|surprised|astonished|wow|whoa|stunned)\b/i, "surprised"],
  [/\b(sighs?|yawns?|tired|sleepy|exhausted|groans?|stretches?|slumps?)\b/i, "tired"],
  [/\b(frowns?|sad(?:ly)?|cries|crying|sobs?|sniffs?|tears?|pouts?)\b/i, "sad"],
  [/\b(angr(y|ily)|growls?|glares?|scowls?|grumbles?|huffs?|snaps?|seethes?)\b/i, "angry"],
  [/\b(confused|puzzled|shrugs?|hmm+|ponders?|wonders?|scratches?|tilts?)\b/i, "confused"],
  [/\b(thinks?|thinking|considers?|taps?|strokes?|pauses?)\b/i, "think"],
  [/\b(winces?|nauseous|queasy|gags?)\b/i, "sick"],
];

function moodForSpan(span: string): Mood | null {
  for (const [re, mood] of EMOTE_MOODS) if (re.test(span)) return mood;
  return null;
}

// ── Plain-sentence sentiment → mood ──────────────────────────────────────────
// VOICE_RULE explicitly bans the XML/asterisk emotes above, so with a compliant
// model the tag path never fires and the avatar's whole emotional range was
// unreachable. This lexicon reads the PROSE itself (same approach prosody already
// uses for rate/gain) — conservative patterns tuned for sentences, not action
// spans ("I think we should…" must NOT trigger the think face).
const SENTENCE_MOODS: Array<[RegExp, Mood]> = [
  [/\b(?:haha+|hehe+|lo+l|lmao|that'?s (?:hilarious|so funny)|cracking me up|i can'?t stop laughing)\b/i, "laugh"],
  [/\b(?:omg|oh wow|whoa|no way|that'?s (?:incredible|unbelievable|wild|insane)|i can'?t believe)\b/i, "surprised"],
  [/\b(?:i love (?:it|this|that)|aww+|so sweet|how lovely|adorable)\b/i, "love"],
  [/\b(?:ya+y|woohoo|that'?s (?:awesome|fantastic|wonderful|great news)|so (?:happy|excited) for you|congrats|congratulations)\b/i, "happy"],
  [/\b(?:oh no|i'?m so sorry|sorry to hear|sadly|unfortunately|heartbreaking|that'?s (?:tough|rough|hard|awful|terrible)|condolences|so sad)\b/i, "sad"],
  [/\b(?:ugh+|so frustrating|infuriating|grr+)\b/i, "angry"],
  [/\b(?:hmm+|let me think|that'?s a (?:good|tough|tricky) (?:question|one))\b/i, "think"],
];

export function moodForSentence(sentence: string): Mood | null {
  for (const [re, mood] of SENTENCE_MOODS) if (re.test(sentence)) return mood;
  return null;
}

// Extract moods from <action>...</action> XML tags (primary) and *action* fallback.
// Returns the moods plus the end offset of the last complete tag so callers can
// advance a streaming cursor and not re-fire on partially-streamed tags.
export function extractEmoteMoods(text: string): { moods: Mood[]; lastEnd: number } {
  const moods: Mood[] = [];
  let lastEnd = 0;

  // Primary: <action>...</action> XML tags — inner text is the action description
  ACTION_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ACTION_TAG_RE.exec(text)) !== null) {
    const inner = m[1] ?? "";
    const mood = moodForSpan(inner);
    if (mood) moods.push(mood);
    lastEnd = m.index + m[0].length;
  }

  // Fallback: *action* for models that ignore the instruction
  ASTERISK_EMOTE_RE.lastIndex = 0;
  while ((m = ASTERISK_EMOTE_RE.exec(text)) !== null) {
    const inner = m[0].slice(1, -1); // strip surrounding asterisks
    const mood = moodForSpan(inner);
    if (mood) moods.push(mood);
    const end = m.index + m[0].length;
    if (end > lastEnd) lastEnd = end;
  }

  return { moods, lastEnd };
}
