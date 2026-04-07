/**
 * useHeadTilt — state-driven head rotation with rAF + LERP smoothing.
 *
 * Returns a continuously-updated rotation in degrees that the
 * AnimatedAvatar's head layer applies via inline ``transform``. The
 * rotation is computed every animation frame from a behavioral
 * ``state`` plus ``performance.now()``, then LERP-smoothed toward
 * its target so state changes ease over instead of snapping.
 *
 * Why this exists (vs. CSS keyframes):
 *   - Swapping CSS ``animation-name`` mid-flight pops to the new
 *     keyframe's 0% value. Behavioral states (idle → thinking →
 *     speaking → sleeping) need to ease *from* the current angle to
 *     the new target, not jump.
 *   - We want to compose: e.g. ``speaking`` micro-tilts riding on
 *     top of ``idle`` sway. CSS can't stack transforms on the same
 *     element without overwriting.
 *   - Per-state smoothing curves (snappy thinking, drifty sleeping,
 *     gentle idle) drop out of one ``smoothing`` knob in JS.
 *
 * v1 only drives ``idle`` from AnimatedAvatar. The other states are
 * implemented and ready — wiring them to TTS-active / inactivity /
 * decomposer-thinking signals is a follow-up that can land without
 * touching the rendering layer.
 *
 * The ``displayed`` state is held in a ref (not React state), so the
 * rAF loop never triggers a React re-render. The hook returns a
 * snapshot via ``useState`` that's updated once per frame — that one
 * setState per frame is intentional: it's how we get React to
 * re-render the head wrapper's inline ``transform``.
 */
import { useEffect, useRef, useState } from "react";

export type HeadTiltState =
  | "still"
  | "idle"
  | "dozing"
  | "sleeping"
  | "thinking"
  | "listening"
  | "speaking"
  | "sick";

type StateProfile = {
  /** Center angle in degrees. Static states sit here. */
  center: number;
  /** Sine amplitude in degrees. 0 = static. */
  amplitude: number;
  /** Sine period in ms. Ignored when amplitude=0. */
  periodMs: number;
  /** LERP factor per frame (0..1). Higher = snappier. */
  smoothing: number;
};

const PROFILES: Record<HeadTiltState, StateProfile> = {
  // Stop-all. Eases the head back to upright.
  still: { center: 0, amplitude: 0, periodMs: 0, smoothing: 0.10 },
  // Gentle, slow head sway. ±8° is the agreed expressive range.
  idle: { center: 0, amplitude: 8, periodMs: 8000, smoothing: 0.06 },
  // Slow nod-down, head dips to +12° on a long cycle.
  dozing: { center: 8, amplitude: 4, periodMs: 14000, smoothing: 0.03 },
  // Held drop. Drifts in slowly.
  sleeping: { center: 18, amplitude: 0, periodMs: 0, smoothing: 0.02 },
  // Snappy lean to the side.
  thinking: { center: -10, amplitude: 0, periodMs: 0, smoothing: 0.12 },
  // Tiny attentive bob.
  listening: { center: 0, amplitude: 3, periodMs: 4000, smoothing: 0.10 },
  // Small fast tilt while talking. Composes nicely with viseme mouth.
  speaking: { center: 0, amplitude: 2, periodMs: 2500, smoothing: 0.15 },
  // Slow droopy sway around a forward lean.
  sick: { center: 8, amplitude: 4, periodMs: 12000, smoothing: 0.04 },
};

export function useHeadTilt(
  state: HeadTiltState = "idle",
  /** When set, overrides the state's target with this exact angle.
   *  The hook still LERPs toward it, so dragging a slider feels smooth.
   *  Used by the playground's manual tilt control. */
  manualDeg?: number,
): number {
  const [displayed, setDisplayed] = useState(0);
  const displayedRef = useRef(0);
  const stateRef = useRef<HeadTiltState>(state);
  stateRef.current = state;
  const manualRef = useRef<number | undefined>(manualDeg);
  manualRef.current = manualDeg;

  useEffect(() => {
    let raf = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const profile = PROFILES[stateRef.current] ?? PROFILES.idle;
      const t = performance.now();
      const manual = manualRef.current;
      const target =
        manual !== undefined
          ? manual
          : profile.amplitude === 0
          ? profile.center
          : profile.center +
            profile.amplitude *
              Math.sin((2 * Math.PI * t) / profile.periodMs);
      const cur = displayedRef.current;
      const next = cur + (target - cur) * profile.smoothing;
      displayedRef.current = next;
      // One setState per frame — React re-renders the head wrapper's
      // inline ``transform`` only. Cheap because the wrapper has one
      // child <img> and no other dependencies.
      setDisplayed(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  return displayed;
}
