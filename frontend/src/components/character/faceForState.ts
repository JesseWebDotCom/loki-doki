/**
 * faceForState — per-(state, style) DiceBear option overrides.
 *
 * Behavioral states like `sick`, `listening`, `thinking` should pick
 * matching mouth/eye/eyebrow variants automatically so the character's
 * face actually *expresses* the state, not just the head angle.
 *
 * The renderer applies these overrides AFTER the user's `baseOptions`
 * are spread, so a state with an explicit `mouth` clobbers the user's
 * editor selection while the state is active. When the state changes
 * back to `idle` the override goes away and the user's selection
 * reasserts itself.
 *
 * Enum values are taken straight from the per-style component files
 * shipped in @dicebear/{avataaars,bottts,toon-head}/lib/components/
 * — if DiceBear renames a value the renderer will silently fall back
 * to the style's default for that field, so keep this in sync if we
 * bump the dicebear major.
 */
import type { AvatarStyle } from "./Avatar";
import type { HeadTiltState } from "./useHeadTilt";

export type FaceOverride = {
  mouth?: string;
  eyes?: string;
  eyebrows?: string;
};

type StateMap = Partial<Record<AvatarStyle, FaceOverride>>;

const FACE: Partial<Record<HeadTiltState, StateMap>> = {
  // Queasy / unwell. Pursed/sad mouth, watery eyes, droopy brows.
  sick: {
    avataaars: {
      mouth: "vomit",
      // `cry` reads as watery-eyed unwell; `squint` looked angrier
      // than sick in testing.
      eyes: "cry",
      eyebrows: "sadConcerned",
    },
    "toon-head": {
      mouth: "sad",
      // toon-head has no truly squinty open eye; `humble` reads as
      // half-closed unwell. Acceptable here because the head is
      // also tilted forward (sick profile in useHeadTilt).
      eyes: "humble",
      eyebrows: "sad",
    },
    bottts: {
      mouth: "bite", // grimace-y bot mouth
      eyes: "sensor", // single sensor — reads as "scanning sickly"
    },
  },

  // Attentive bob. Engaged but subtle — open eyes, slight upturned
  // mouth, slightly raised brows. NOT a giant grin.
  listening: {
    avataaars: {
      // `twinkle` is a small closed-line smile (no teeth). `smile`
      // shows the full open mouth and reads as laughing, not
      // listening.
      mouth: "twinkle",
      // `default` is the round open eye. `happy` in avataaars is
      // the upward-arc shape — visually identical to closed eyes.
      eyes: "default",
      eyebrows: "defaultNatural",
    },
    "toon-head": {
      mouth: "smile",
      eyes: "wide", // wide open = paying attention
      eyebrows: "raised",
    },
    bottts: {
      mouth: "smile02",
      eyes: "happy",
    },
  },

  // Furious glare. Bared teeth, narrow eyes, hard angled brows.
  angry: {
    avataaars: {
      mouth: "grimace",
      eyes: "squint",
      eyebrows: "angryNatural",
    },
    "toon-head": {
      mouth: "angry",
      eyes: "wide",
      eyebrows: "angry",
    },
    bottts: {
      mouth: "bite",
      // `dizzy` is the X-eye shape — reads as glaring/clenched.
      eyes: "dizzy",
    },
  },

  // Crying. Watery eyes, downturned mouth, droopy brows. Renderer
  // also runs the sob-bob head animation from useHeadTilt.
  sad: {
    avataaars: {
      mouth: "sad",
      eyes: "cry", // the genuine teardrop variant
      eyebrows: "sadConcerned",
    },
    "toon-head": {
      mouth: "sad",
      // toon-head has no cry/teardrop variant; `humble` (downward
      // shut-arc eyes) is the closest "weeping" pose.
      eyes: "humble",
      eyebrows: "sad",
    },
    bottts: {
      // `square01` is the small square readout — reads as a frown
      // on a robot mouth. No real bot crying mouth exists.
      mouth: "square01",
      eyes: "sensor",
    },
  },

  // Startled reaction. Wide eyes, open mouth, raised brows. Used as
  // a transient click-feedback pose — the caller flips back to the
  // ambient state on a timer.
  shocked: {
    avataaars: {
      mouth: "screamOpen",
      eyes: "surprised",
      eyebrows: "raisedExcited",
    },
    "toon-head": {
      mouth: "agape",
      eyes: "wide",
      eyebrows: "raised",
    },
    bottts: {
      mouth: "square02",
      eyes: "roundFrame02",
    },
  },

  // Thinking pose. Mouth pursed/serious, brows furrowed-up.
  // We deliberately do NOT set `eyes` for toon-head: every "looking"
  // variant in toon-head reads as closed/half-closed and breaks the
  // pose. The default eye + the -8° head tilt is enough.
  thinking: {
    avataaars: {
      mouth: "serious",
      eyes: "eyeRoll", // rolled upward — reads as "looking up"
      eyebrows: "raisedExcitedNatural",
    },
    "toon-head": {
      mouth: "smile",
      eyebrows: "neutral",
    },
    bottts: {
      mouth: "grill02",
      eyes: "happy", // happy = arc-style, looks like concentration
    },
  },
};

/** Returns the face overrides for the given state+style, or null. */
export function faceForState(
  state: HeadTiltState,
  style: AvatarStyle,
): FaceOverride | null {
  return FACE[state]?.[style] ?? null;
}
