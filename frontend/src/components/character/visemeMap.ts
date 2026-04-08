/**
 * visemeMap — canonical-viseme → DiceBear mouth/eye enum.
 *
 * VoiceStreamer emits canonical visemes from IPA: 'p' | 'b' | 'm' |
 * 'open' | 'o' | 'wide' | 'neutral' | 'closed'. Each DiceBear style
 * has its own mouth enum (`avataaars` is rich, `toon-head` has 5
 * mouths, `bottts` has no truly-closed mouth at all). We map at this
 * single boundary so AnimatedAvatar stays style-agnostic.
 *
 * Enum values verified at build time against the actual schema enums
 * shipped in @dicebear/{avataaars,bottts,toon-head}/lib/schema.js —
 * if DiceBear renames a value, the renderer will silently fall back
 * to the style's default mouth, so keep this in sync if we bump the
 * dicebear major.
 */
import type { AvatarStyle } from "./Avatar";

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

const MAPS: Record<AvatarStyle, StyleVisemeMap> = {
  avataaars: {
    // avataaars only ships ONE genuinely open mouth (`screamOpen`) —
    // every other option is closed-ish (`default`/`smile`/`serious`
    // are all flat lines, `eating` is a small pucker). To make it
    // *look* like talking we have to alternate between the one open
    // shape and several distinct closed shapes so each viseme tick
    // produces a visible swap. `neutral` MUST differ from `closed`
    // or consonant runs render as a frozen mouth.
    mouths: {
      closed: "default",
      neutral: "eating", // distinct closed so neutral↔closed swap reads
      open: "screamOpen",
      o: "screamOpen", // disbelief is too small to read as talking
      wide: "grimace", // shows teeth wide — reads as a talking shape
      p: "default",
      b: "default",
      m: "default",
    },
    blinkEye: "closed",
    defaultEye: "default",
  },
  bottts: {
    // bottts has no real "closed" mouth — every option is a visible
    // mouth shape. Pick distinct shapes for closed/neutral so the
    // swap reads during consonant runs.
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
    // bottts ships no closed-eye variant — every eye is an open LED
    // frame. The sentinel "__overlay__" enables the idle blink loop
    // but tells the renderer to skip the DiceBear `eyes` override and
    // instead overlay custom closed-eye bars on the rendered SVG
    // (see applyBotttsBlinkOverlay in splitDicebearSvg).
    blinkEye: "__overlay__",
    defaultEye: null,
  },
  "toon-head": {
    // toon-head only ships 5 mouths: laugh, angry, agape, smile, sad.
    // Same alternation trick as avataaars — neutral must differ from
    // closed or consonant runs freeze the face.
    mouths: {
      closed: "smile",
      neutral: "laugh", // open-with-teeth shape, distinct from smile
      open: "agape",
      o: "agape",
      wide: "laugh",
      p: "smile",
      b: "smile",
      m: "smile",
    },
    // toon-head's `bow` eye is two downward arcs over both eye
    // sockets — i.e. the `^_^` closed-eye look. Perfect blink frame.
    // (`wink` only closes one eye and reads as broken for idle blinks.)
    blinkEye: "bow",
    defaultEye: "happy",
  },
};

export function mouthForViseme(style: AvatarStyle, viseme: Viseme): string {
  return MAPS[style].mouths[viseme] ?? MAPS[style].mouths.neutral;
}

export function blinkEyeFor(style: AvatarStyle): string | null {
  return MAPS[style].blinkEye;
}

export function defaultEyeFor(style: AvatarStyle): string | null {
  return MAPS[style].defaultEye;
}
