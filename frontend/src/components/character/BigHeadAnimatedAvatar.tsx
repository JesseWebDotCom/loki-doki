/**
 * BigHeadAnimatedAvatar — animated wrapper around BigHeadRigged.
 *
 * Replicates AnimatedAvatar's behavior (TTS-driven lipsync, idle blink,
 * head tilt via useHeadTilt) for the @bigheads/core part library, where
 * the head can be rotated as a real rigid <g> instead of via pixel masks.
 *
 * Lives alongside the existing AnimatedAvatar so we can A/B them on a
 * single character without committing to a migration. Wired into the
 * playground via a fourth style key, "bighead".
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import BigHeadRigged, { type BigHeadProps } from "./BigHeadRigged";
import { ttsController } from "../../utils/tts";
import { useHeadTilt, type HeadTiltState } from "./useHeadTilt";
import { type Viseme } from "./visemeMap";
import {
  eyesMap,
  mouthsMap,
  hairMap,
  facialHairMap,
  clothingMap,
  accessoryMap,
  hatMap,
  bodyMap,
  theme,
} from "@bigheads/core";

// Deterministic seed → bighead props. We hash the seed to a number,
// then index every part-map by that number so each character renders
// as a distinct (but stable) bighead. This is a stand-in until the
// character schema gains real bighead options.
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

export function bigHeadPropsForSeed(seed: string): Partial<BigHeadProps> {
  const h = hashSeed(seed);
  const skinKeys = Object.keys(theme.colors.skin) as Array<
    keyof typeof theme.colors.skin
  >;
  const hairColorKeys = Object.keys(theme.colors.hair) as Array<
    keyof typeof theme.colors.hair
  >;
  const clothingColorKeys = Object.keys(theme.colors.clothing) as Array<
    keyof typeof theme.colors.clothing
  >;
  const lipColorKeys = Object.keys(theme.colors.lipColors) as Array<
    keyof typeof theme.colors.lipColors
  >;
  // Filter out the joke "noneN" entries from hair/hat so most seeds get
  // a real haircut and most don't get a hat.
  const hairKeys = (Object.keys(hairMap) as Array<keyof typeof hairMap>).filter(
    (k) => k !== "none",
  );
  const hatKeys = Object.keys(hatMap) as Array<keyof typeof hatMap>;
  const eyebrowsKeys = ["raised", "leftLowered", "serious", "concerned"] as const;
  const facialHairKeys = Object.keys(facialHairMap) as Array<
    keyof typeof facialHairMap
  >;
  const clothingKeys = (
    Object.keys(clothingMap) as Array<keyof typeof clothingMap>
  ).filter((k) => k !== "naked");
  const accessoryKeys = Object.keys(accessoryMap) as Array<
    keyof typeof accessoryMap
  >;
  const bodyKeys = Object.keys(bodyMap) as Array<keyof typeof bodyMap>;

  return {
    skinTone: pick(h, 1, skinKeys),
    hair: pick(h, 2, hairKeys),
    hairColor: pick(h, 3, hairColorKeys),
    eyebrows: pick(h, 4, eyebrowsKeys) as BigHeadProps["eyebrows"],
    facialHair: pick(h, 5, facialHairKeys),
    clothing: pick(h, 6, clothingKeys),
    clothingColor: pick(h, 7, clothingColorKeys),
    accessory: pick(h, 8, accessoryKeys),
    // Hat is mostly "noneN" entries — let those dominate so most
    // characters render hatless.
    hat: pick(h, 9, hatKeys),
    body: pick(h, 10, bodyKeys),
    lipColor: pick(h, 11, lipColorKeys),
  };
}

// Viseme → bigheads mouth name. bigheads has: grin, sad, openSmile,
// lips, open, serious, tongue. We pick distinct shapes for each viseme
// so the swap reads as talking even on consonant-heavy runs.
type MouthKey = keyof typeof mouthsMap;
const VISEME_MOUTH: Record<Viseme, MouthKey> = {
  closed: "serious",
  neutral: "lips",
  open: "openSmile",
  o: "openSmile",
  wide: "open",
  p: "serious",
  b: "serious",
  m: "lips",
};

// bigheads has no proper "eyes-closed" — `wink` is the closest single-eye
// closed shape, but it leaves the other eye open. Use it for the blink
// frame anyway; it reads better than freezing.
type EyeKey = keyof typeof eyesMap;
const BLINK_EYE: EyeKey = "wink";
const BLINK_INTERVAL_MS = 4500;
const BLINK_DURATION_MS = 140;

type Props = Omit<BigHeadProps, "headRotateDeg" | "mouth" | "eyes"> & {
  /** Default eye/mouth when not blinking/speaking. */
  baseEyes?: EyeKey;
  baseMouth?: MouthKey;
  size?: number;
  className?: string;
  tiltState?: HeadTiltState;
  manualTiltDeg?: number;
  /** When set, deterministically derives bighead part choices from
   *  this string so each character renders as a distinct (stable)
   *  avatar. Explicit prop overrides on this component still win. */
  seed?: string;
};

const BigHeadAnimatedAvatar: React.FC<Props> = ({
  baseEyes = "normal",
  baseMouth = "grin",
  size,
  className,
  tiltState = "idle",
  manualTiltDeg,
  seed,
  ...rest
}) => {
  // Seed-derived defaults are merged BEHIND any explicit overrides
  // passed by the caller, so future per-character bighead options
  // will trump the seed-derived guesses without further plumbing.
  const seedProps = useMemo(
    () => (seed ? bigHeadPropsForSeed(seed) : {}),
    [seed],
  );
  const merged = { ...seedProps, ...rest };
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

  // Effective mouth: base unless TTS is driving a viseme other than
  // "closed", in which case use the viseme mapping. "closed" falls
  // through to the base so the resting expression isn't overridden.
  const effectiveMouth: MouthKey = useMemo(() => {
    if (viseme === "closed") return baseMouth;
    return VISEME_MOUTH[viseme];
  }, [viseme, baseMouth]);

  const effectiveEyes: EyeKey = blinking ? BLINK_EYE : baseEyes;

  const wrapperStyle: React.CSSProperties = size
    ? { width: size, height: size, display: "inline-block" }
    : { width: "100%", height: "100%", display: "inline-block" };

  return (
    <div className={className} style={wrapperStyle}>
      <BigHeadRigged
        {...merged}
        eyes={effectiveEyes}
        mouth={effectiveMouth}
        headRotateDeg={headDeg}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
};

export default BigHeadAnimatedAvatar;
