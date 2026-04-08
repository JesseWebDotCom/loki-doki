/**
 * AvataaarsAnimatedAvatar — animated wrapper around AvataaarsRigged.
 *
 * Same idea as AnimatedAvatar (DiceBear) and BigHeadAnimatedAvatar
 * (@bigheads/core), but uses Pablo Stanley's original avataaars
 * artwork through the `avataaars` npm package, with a real rigid
 * head <g> via the AvataaarsRigged path split.
 *
 * Provides:
 *   - useHeadTilt-driven head rotation
 *   - TTS viseme → mouthType swap (lipsync)
 *   - Idle blink via eyeType="Close"
 *   - Optional seed-derived deterministic part choices, so each
 *     character renders as a distinct avatar without the caller
 *     having to plumb through every option key
 *
 * The viseme map and blink swap key off the legacy avataaars option
 * values (PascalCase: "ScreamOpen", "Default", "Close"), which are
 * different from DiceBear avataaars's enum (camelCase: "screamOpen",
 * "default", "closed"). When we eventually wire saved character
 * options through, the mapping will need to PascalCase them.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import AvataaarsRigged, { type AvataaarsRiggedProps } from "./AvataaarsRigged";
import { ttsController } from "../../utils/tts";
import { useHeadTilt, type HeadTiltState } from "./useHeadTilt";
import { type Viseme } from "./visemeMap";

// Canonical viseme → legacy avataaars mouthType. We pick distinct
// shapes per viseme so consonant runs visibly swap instead of
// freezing on a single mouth shape.
const VISEME_MOUTH: Record<Viseme, string> = {
  closed: "Default",
  neutral: "Eating",
  open: "ScreamOpen",
  o: "ScreamOpen",
  wide: "Grimace",
  p: "Default",
  b: "Default",
  m: "Eating",
};

// Legacy avataaars eye for the blink frame.
const BLINK_EYE = "Close";
const BLINK_INTERVAL_MS = 4500;
const BLINK_DURATION_MS = 140;

// ----- seed-derived defaults -----
// Hash any string to a 32-bit unsigned int (FNV-1a).
const hashSeed = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const pick = <T,>(seedHash: number, salt: number, arr: readonly T[]): T =>
  arr[(seedHash + salt) % arr.length];

// Curated subsets of legacy avataaars option values. We keep these
// short on purpose: enough variety to make seeds visibly distinct,
// not so much that one character looks like a clown wig.
const TOPS = [
  "ShortHairShortFlat",
  "ShortHairShortRound",
  "ShortHairShortWaved",
  "ShortHairTheCaesar",
  "ShortHairFrizzle",
  "ShortHairShaggy",
  "LongHairBob",
  "LongHairBun",
  "LongHairCurly",
  "LongHairCurvy",
  "LongHairStraight",
  "LongHairStraight2",
  "LongHairFro",
  "LongHairMiaWallace",
  "Hat",
  "WinterHat1",
  "Turban",
  "Hijab",
] as const;
const ACCESSORIES = ["Blank", "Round", "Sunglasses", "Wayfarers"] as const;
const HAIR_COLORS = [
  "Auburn",
  "Black",
  "Blonde",
  "BlondeGolden",
  "Brown",
  "BrownDark",
  "Red",
  "SilverGray",
] as const;
const FACIAL_HAIR = ["Blank", "BeardLight", "BeardMedium", "MoustacheFancy"] as const;
const CLOTHES = [
  "BlazerShirt",
  "BlazerSweater",
  "CollarSweater",
  "GraphicShirt",
  "Hoodie",
  "Overall",
  "ShirtCrewNeck",
  "ShirtScoopNeck",
  "ShirtVNeck",
] as const;
const CLOTHE_COLORS = [
  "Black",
  "Blue01",
  "Blue02",
  "Blue03",
  "Gray01",
  "Heather",
  "PastelBlue",
  "PastelGreen",
  "PastelOrange",
  "PastelRed",
  "PastelYellow",
  "Pink",
  "Red",
  "White",
] as const;
const EYEBROWS = [
  "Default",
  "DefaultNatural",
  "FlatNatural",
  "RaisedExcited",
  "UpDown",
] as const;
const SKIN_COLORS = ["Tanned", "Yellow", "Pale", "Light", "Brown", "DarkBrown", "Black"] as const;

export function avataaarsPropsForSeed(seed: string): Partial<AvataaarsRiggedProps> {
  const h = hashSeed(seed);
  return {
    topType: pick(h, 1, TOPS),
    accessoriesType: pick(h, 2, ACCESSORIES),
    hairColor: pick(h, 3, HAIR_COLORS),
    facialHairType: pick(h, 4, FACIAL_HAIR),
    facialHairColor: pick(h, 5, HAIR_COLORS),
    clotheType: pick(h, 6, CLOTHES),
    clotheColor: pick(h, 7, CLOTHE_COLORS),
    eyebrowType: pick(h, 8, EYEBROWS),
    skinColor: pick(h, 9, SKIN_COLORS),
    // Eyes/mouth are intentionally omitted here — they're driven by
    // the live blink/lipsync state below. The seed picks a baseline
    // "default" eye, falling through to the runtime override.
  };
}

type Props = Omit<AvataaarsRiggedProps, "headRotateDeg" | "mouthType" | "eyeType"> & {
  /** Default eye when not blinking. */
  baseEyeType?: string;
  /** Default mouth when not speaking. */
  baseMouthType?: string;
  size?: number;
  className?: string;
  tiltState?: HeadTiltState;
  manualTiltDeg?: number;
  /** Optional seed for deterministic part picks. Explicit prop
   *  overrides on this component still win. */
  seed?: string;
};

const AvataaarsAnimatedAvatar: React.FC<Props> = ({
  baseEyeType = "Default",
  baseMouthType = "Smile",
  size,
  className,
  tiltState = "idle",
  manualTiltDeg,
  seed,
  ...rest
}) => {
  const [viseme, setViseme] = useState<Viseme>("closed");
  const [blinking, setBlinking] = useState(false);
  const blinkTimer = useRef<number | null>(null);
  const headDeg = useHeadTilt(tiltState, manualTiltDeg);

  useEffect(() => {
    const unsub = ttsController.subscribeViseme((v) => {
      setViseme((v || "closed") as Viseme);
    });
    return () => {
      unsub();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      const jitter = Math.random() * 1500 - 750;
      blinkTimer.current = window.setTimeout(() => {
        if (cancelled) return;
        setBlinking(true);
        window.setTimeout(() => {
          if (cancelled) return;
          setBlinking(false);
          schedule();
        }, BLINK_DURATION_MS);
      }, BLINK_INTERVAL_MS + jitter);
    };
    schedule();
    return () => {
      cancelled = true;
      if (blinkTimer.current != null) window.clearTimeout(blinkTimer.current);
    };
  }, []);

  // Seed-derived defaults sit BEHIND any explicit overrides so future
  // per-character avataaars options will trump them automatically.
  const seedProps = useMemo(
    () => (seed ? avataaarsPropsForSeed(seed) : {}),
    [seed],
  );
  const merged = { ...seedProps, ...rest };

  const effectiveMouth =
    viseme === "closed" ? baseMouthType : VISEME_MOUTH[viseme];
  const effectiveEye = blinking ? BLINK_EYE : baseEyeType;

  const wrapperStyle: React.CSSProperties = size
    ? { width: size, height: size, display: "inline-block" }
    : { width: "100%", height: "100%", display: "inline-block" };

  return (
    <div className={className} style={wrapperStyle}>
      <AvataaarsRigged
        {...merged}
        eyeType={effectiveEye}
        mouthType={effectiveMouth}
        headRotateDeg={headDeg}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
    </div>
  );
};

export default AvataaarsAnimatedAvatar;
