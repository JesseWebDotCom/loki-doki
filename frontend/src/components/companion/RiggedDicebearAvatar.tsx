import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createAvatar, type Style } from "@dicebear/core";
import { avataaars, bottts, toonHead } from "@dicebear/collection";

import AngryFlames from "./AngryFlames";
import BotttsSparks from "./BotttsSparks";
import SleepingZs from "./SleepingZs";
import ThinkingDots from "./ThinkingDots";
import { faceForState } from "./faceForState";
import { filterOptionsForStyle } from "./dicebearSchema";
import { applyBotttsBlinkOverlay, splitDicebearSvg } from "./splitDicebearSvg";
import { useHeadTilt, type HeadTiltState } from "./useHeadTilt";
import { blinkEyeFor, defaultEyeFor, lookUpEyeFor, mouthForViseme, type Viseme } from "./visemeMap";
import { faceForMood, type Mood } from "./moods";
import type { CharacterStyle } from "./styles";

// Ported from loki-doki-v2 RiggedDicebearAvatar.tsx. The head-tilt mechanism (split
// parts rotated around a fixed neck pivot) is preserved exactly. Mouth source:
// when `audioViseme` is provided (TTS audio bridge active) it drives the mouth on
// the real audio clock; otherwise the streaming-text cadence flap (`speaking`) is
// the fallback for text-only streams with TTS off.

const STYLE_MAP: Record<CharacterStyle, Style<object>> = {
  avataaars: avataaars as unknown as Style<object>,
  bottts: bottts as unknown as Style<object>,
  "toon-head": toonHead as unknown as Style<object>,
};

// Deterministic per-seed phase offset (seconds) so idle/dozing avatars rendered
// side-by-side (e.g. the companion store grid) don't tilt their heads in unison.
function seedPhase(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  // Spread across a wide window so even the slow idle sine waves are out of sync.
  return Math.abs(h % 10000) / 10000 * 20;
}

const FLAP_SHAPES: Viseme[] = ["open", "wide", "o", "neutral", "closed"];
const FLAP_INTERVAL_MS = 110;
const BLINK_INTERVAL_MS = 4500;
const BLINK_DURATION_MS = 140;

interface Props {
  style: CharacterStyle;
  seed: string;
  baseOptions?: Record<string, unknown>;
  size?: number;
  className?: string;
  tiltState?: HeadTiltState;
  manualTiltDeg?: number | null;
  /** Tokens streaming → drive the mouth flap (fallback when no audio viseme). */
  speaking?: boolean;
  /** Live viseme from the TTS audio bridge. `undefined` = no audio source (use flap). */
  audioViseme?: Viseme | null;
  /** Emote overlay (eyes/eyebrows, + mouth when not speaking). */
  mood?: Mood;
  staticPose?: boolean;
  /** Skip rendering ThinkingDots/SleepingZs/AngryFlames — caller renders them outside an overflow-hidden container. */
  suppressOverlays?: boolean;
}

export default function RiggedDicebearAvatar({
  style,
  seed,
  baseOptions,
  size,
  className,
  tiltState = "idle",
  manualTiltDeg,
  speaking = false,
  audioViseme,
  mood = "neutral",
  staticPose = false,
  suppressOverlays = false,
}: Props) {
  const [flapViseme, setFlapViseme] = useState<Viseme>("closed");
  const [blinking, setBlinking] = useState(false);
  const blinkTimer = useRef<number | null>(null);
  const phase = useMemo(() => seedPhase(seed || "default"), [seed]);
  const anim = useHeadTilt(tiltState, manualTiltDeg ?? null, staticPose, phase);

  // When the audio bridge supplies a viseme, it drives the mouth on the real
  // audio clock; otherwise fall back to the streaming-text cadence flap.
  const audioDriven = audioViseme !== undefined && audioViseme !== null;
  const viseme: Viseme = audioDriven ? (audioViseme as Viseme) : flapViseme;
  const playing = audioDriven ? viseme !== "closed" : speaking;

  useEffect(() => {
    if (audioDriven) return undefined; // audio bridge drives the mouth
    if (staticPose || !speaking) { setFlapViseme("closed"); return; }
    let i = 0;
    const id = window.setInterval(() => {
      i = (i + 1 + Math.floor(Math.random() * 2)) % FLAP_SHAPES.length;
      setFlapViseme(FLAP_SHAPES[i]!);
    }, FLAP_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [staticPose, speaking, audioDriven]);

  useEffect(() => {
    if (staticPose) return undefined;
    if (!blinkEyeFor(style)) return undefined;
    if (tiltState === "dozing" || tiltState === "sleeping") return undefined;
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
      if (blinkTimer.current !== null) window.clearTimeout(blinkTimer.current);
    };
  }, [staticPose, style, tiltState]);

  const effectiveOptions: Record<string, unknown> = { ...(baseOptions ?? {}) };
  // Suppress RANDOM extras: only render accessories / facial hair / beard when the
  // character's config explicitly asks for them. Otherwise DiceBear's per-seed
  // probability can add a surprise eye patch, glasses, or beard the character has no
  // idea it's "wearing" — breaking appearance self-consistency.
  const cfg = baseOptions ?? {};
  if (!("accessories" in cfg)) effectiveOptions.accessoriesProbability = 0;
  if (style === "avataaars" && !("facialHair" in cfg)) effectiveOptions.facialHairProbability = 0;
  if (style === "toon-head" && !("beard" in cfg)) effectiveOptions.beardProbability = 0;
  // Mood (emote overlay) wins over the activity-state face; the speaking mouth
  // (visemes) still wins over both so the character emotes WHILE lip-syncing.
  const stateFace = faceForState(tiltState, style);
  const expr = faceForMood(mood, style) ?? stateFace;
  const userSetMouth = "mouth" in (baseOptions ?? {});
  const userSetEyes = "eyes" in (baseOptions ?? {});
  const userSetEyebrows = "eyebrows" in (baseOptions ?? {});

  if (anim.sleepMouth) {
    effectiveOptions.mouth = [mouthForViseme(style, anim.sleepMouthOpen ? "o" : "closed")];
    effectiveOptions.mouthProbability = 100;
  } else if (playing) {
    effectiveOptions.mouth = [mouthForViseme(style, viseme)];
    effectiveOptions.mouthProbability = 100;
  } else if (expr?.mouth && !userSetMouth) {
    effectiveOptions.mouth = [expr.mouth];
    effectiveOptions.mouthProbability = 100;
  }

  const blinkEye = blinkEyeFor(style);
  const eyesShouldClose = anim.eyesClosed || blinking;
  const blinkViaOverride = eyesShouldClose && blinkEye !== null && !blinkEye.startsWith("__");
  const lookUpEye = !eyesShouldClose && anim.eyeHint === "lookUpLeft" ? lookUpEyeFor(style) : null;

  if (blinkViaOverride) {
    effectiveOptions.eyes = [blinkEye as string];
    effectiveOptions.eyesProbability = 100;
  } else if (lookUpEye) {
    effectiveOptions.eyes = [lookUpEye];
    effectiveOptions.eyesProbability = 100;
  } else if (expr?.eyes && !userSetEyes) {
    effectiveOptions.eyes = [expr.eyes];
    effectiveOptions.eyesProbability = 100;
  } else if (defaultEyeFor(style) && !userSetEyes) {
    effectiveOptions.eyes = [defaultEyeFor(style) as string];
    effectiveOptions.eyesProbability = 100;
  }

  if (expr?.eyebrows && !userSetEyebrows) {
    effectiveOptions.eyebrows = [expr.eyebrows];
    effectiveOptions.eyebrowsProbability = 100;
  }

  const optionsKey = JSON.stringify(effectiveOptions);
  const svgString = useMemo(() => {
    try {
      return createAvatar(STYLE_MAP[style], {
        seed: seed || "default",
        ...filterOptionsForStyle(style, effectiveOptions),
      }).toString();
    } catch (error) {
      console.error("[RiggedDicebearAvatar] render failed", style, error);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey, seed, style]);

  const processedSvg = useMemo(() => {
    if (!svgString) return null;
    if (style === "bottts" && eyesShouldClose) return applyBotttsBlinkOverlay(svgString);
    return svgString;
  }, [eyesShouldClose, style, svgString]);

  const split = useMemo(() => {
    if (!processedSvg) return null;
    return splitDicebearSvg(processedSvg, style);
  }, [processedSvg, style]);

  const wrapperStyle: CSSProperties = {
    ...(size ? { width: size, height: size } : { width: "100%", height: "100%" }),
    display: "inline-block",
    position: "relative",
    containerType: "size",
  };
  const filter = anim.grayscale
    ? "grayscale(1)"
    : tiltState === "sick"
      ? "sepia(0.55) hue-rotate(55deg) saturate(1.6) brightness(0.95)"
      : "none";
  const isAngry = tiltState === "angry";
  const svgStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    display: "block",
    position: "relative",
    zIndex: 1,
    filter,
    transition: "filter 600ms ease",
    ...(isAngry ? { animation: "ld-angry-shake 0.18s linear infinite" } : null),
  };

  if (!split) {
    return <div className={className} style={wrapperStyle} />;
  }
  if (!split.riggable) {
    return (
      <div className={className} style={wrapperStyle}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox={split.viewBox}
          style={{ width: "100%", height: "100%", display: "block" }}
          dangerouslySetInnerHTML={{ __html: split.inner }}
        />
      </div>
    );
  }

  const rotation = `rotate(${anim.headDeg.toFixed(3)} ${split.pivotX} ${split.pivotY})`;
  const markup =
    split.defs +
    `<g transform="${rotation}">${split.backHair}</g>` +
    `<g>${split.body}</g>` +
    `<g transform="${rotation}">${split.headSkin}</g>` +
    `<g>${split.clothes}</g>` +
    `<g transform="${rotation}">${split.headFeatures}</g>`;

  return (
    <div className={className} style={wrapperStyle}>
      {!staticPose && !suppressOverlays && tiltState === "sick" && style === "bottts" ? <BotttsSparks /> : null}
      {!staticPose && !suppressOverlays && tiltState === "sleeping" ? <SleepingZs tiltDeg={anim.headDeg} grayscale={anim.grayscale} /> : null}
      {!staticPose && !suppressOverlays && tiltState === "thinking" ? <ThinkingDots tiltDeg={anim.headDeg} /> : null}
      {!staticPose && !suppressOverlays && isAngry ? (
        <>
          <style>{`
            @keyframes ld-angry-shake {
              0%   { transform: translate(0, 0)   rotate(0deg);   }
              20%  { transform: translate(-1.5px, 1px) rotate(-0.6deg); }
              40%  { transform: translate(1.5px, -1px) rotate(0.6deg);  }
              60%  { transform: translate(-1px, -1.5px) rotate(-0.4deg); }
              80%  { transform: translate(1px, 1.5px) rotate(0.4deg);  }
              100% { transform: translate(0, 0)   rotate(0deg);   }
            }
          `}</style>
          <div style={{ position: "absolute", inset: 0, opacity: 0.5, pointerEvents: "none" }}>
            <AngryFlames tiltDeg={anim.headDeg} />
          </div>
        </>
      ) : null}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={split.viewBox}
        style={svgStyle}
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    </div>
  );
}
