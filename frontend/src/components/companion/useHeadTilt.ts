import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Ported verbatim from maipai-home-v2. Continuous rAF head-tilt motion per state.

export type HeadTiltState =
  | "still"
  | "idle"
  | "dozing"
  | "sleeping"
  | "thinking"
  | "listening"
  | "speaking"
  | "sick"
  | "angry"
  | "sad"
  | "shocked";

export type EyeVariantHint = "lookUpLeft" | null;

export interface CharacterAnimation {
  headDeg: number;
  eyesClosed: boolean;
  grayscale: boolean;
  sleepMouth: boolean;
  sleepMouthOpen: boolean;
  eyeHint: EyeVariantHint;
}

const SMOOTHING: Record<HeadTiltState, number> = {
  still: 0.1,
  idle: 0.035,
  dozing: 0.045,
  sleeping: 0.025,
  thinking: 0.08,
  listening: 0.1,
  speaking: 0.15,
  sick: 0.04,
  angry: 0.2,
  sad: 0.07,
  shocked: 0.35,
};

function lerp(current: number, target: number, amount: number): number {
  return current + (target - current) * amount;
}

const STATIC_SLEEP_POSE: CharacterAnimation = {
  headDeg: 14,
  eyesClosed: true,
  grayscale: true,
  sleepMouth: true,
  sleepMouthOpen: false,
  eyeHint: null,
};

export function useHeadTilt(
  state: HeadTiltState,
  manualTiltDeg: number | null = null,
  paused: boolean = false,
  phaseSeconds: number = 0,
): CharacterAnimation {
  const [animation, setAnimation] = useState<CharacterAnimation>(
    paused ? STATIC_SLEEP_POSE : {
      headDeg: 0,
      eyesClosed: false,
      grayscale: false,
      sleepMouth: false,
      sleepMouthOpen: false,
      eyeHint: null,
    },
  );
  const currentRef = useRef(0);

  useLayoutEffect(() => {
    if (paused) return;
    if (state === "sleeping" || state === "dozing") return;
    setAnimation((prev) =>
      prev.eyesClosed || prev.grayscale || prev.sleepMouth || prev.sleepMouthOpen
        ? { ...prev, eyesClosed: false, grayscale: false, sleepMouth: false, sleepMouthOpen: false }
        : prev,
    );
  }, [paused, state]);

  useEffect(() => {
    if (paused) {
      currentRef.current = STATIC_SLEEP_POSE.headDeg;
      setAnimation(STATIC_SLEEP_POSE);
      return;
    }
    let frame = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const t = (now - start) / 1000 + phaseSeconds;
      let target = 0;
      let eyesClosed = false;
      let grayscale = false;
      let sleepMouth = false;
      let sleepMouthOpen = false;
      let eyeHint: EyeVariantHint = null;

      if (manualTiltDeg !== null) {
        target = manualTiltDeg;
      } else {
        switch (state) {
          case "idle":
            target = Math.sin(t * 0.7) * 3 + Math.sin(t * 0.27) * 1.2;
            break;
          case "dozing":
            target = Math.sin(t * 0.35) * 8;
            eyesClosed = Math.sin(t * 1.4) > 0.55;
            break;
          case "sleeping":
            target = 14;
            eyesClosed = true;
            grayscale = true;
            sleepMouth = true;
            sleepMouthOpen = Math.sin(t * 1.8) > 0;
            break;
          case "thinking": {
            const cycle = Math.floor(t / 10) % 2;
            target = cycle === 0 ? -8 : 8;
            eyeHint = "lookUpLeft";
            break;
          }
          case "listening":
            target = Math.sin(t * 1.7) * 2.5;
            break;
          case "speaking":
            target = Math.sin(t * 2.6) * 1.6;
            break;
          case "sick":
            target = Math.sin(t * 0.85) * 4 - 6;
            break;
          case "angry":
            target = Math.sin(t * 10) * 1.4;
            break;
          case "sad":
            target = Math.sin(t * 1.2) * 2.8 - 5;
            break;
          case "shocked":
            target = Math.sin(t * 18) * 2.2;
            break;
          case "still":
          default:
            target = 0;
            break;
        }
      }

      currentRef.current = lerp(currentRef.current, target, SMOOTHING[state]);
      setAnimation({
        headDeg: currentRef.current,
        eyesClosed,
        grayscale,
        sleepMouth,
        sleepMouthOpen,
        eyeHint,
      });
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [manualTiltDeg, paused, state, phaseSeconds]);

  return animation;
}
