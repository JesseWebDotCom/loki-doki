/**
 * useHeadTilt — state-driven character animation with rAF + LERP smoothing.
 *
 * Despite the name (kept for backwards compatibility with existing
 * imports), this hook is the single source of truth for *all*
 * behavioral animation a character does outside of TTS lipsync:
 *
 *   - Idle head sway (multi-sine, slow, quasi-random)
 *   - Scripted "dozing" sequence (rapid blinks → eyes shut → head
 *     tilt → hold → eyes open → return → loop)
 *   - "Sleeping" (same as dozing but locks at the head-tilted phase
 *     forever, with grayscale + slow snore mouth cycling)
 *   - "Thinking" (small fixed lean + eye-up hint for the renderer)
 *   - listening / speaking / sick (sine variants)
 *
 * The hook returns a {@link CharacterAnimation} snapshot updated once
 * per animation frame. The renderer reads `headDeg` for the rotation
 * transform and the boolean fields to drive blink / mouth / filter
 * overrides. Object identity changes every frame (we want React to
 * re-render the head transform anyway), but the heavy DiceBear
 * re-render is gated downstream by JSON-stringified options memoing
 * — so frame-by-frame snapshots only update the inline transform.
 *
 * Why a phase machine for dozing/sleeping (vs. CSS keyframes or pure
 * sines): the sequence is *coordinated* across head angle and eye
 * state, with random hold durations. A sine can't express "hold X for
 * 1.5-3.5s then move". CSS keyframes can't trigger eye closes. A
 * tiny imperative state machine driven from the rAF tick keeps both
 * channels in lockstep.
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
  | "sick"
  | "angry"
  | "sad";

/** Hint to the renderer about a non-default eye direction. The
 *  renderer maps this to a per-style DiceBear eye variant; styles
 *  without a matching variant just ignore it. */
export type EyeVariantHint = "lookUpLeft" | null;

export type CharacterAnimation = {
  /** Smoothed head rotation in degrees. */
  headDeg: number;
  /** When true, force eyes closed regardless of the random blink loop. */
  eyesClosed: boolean;
  /** When true, render the avatar in grayscale (sleeping). */
  grayscale: boolean;
  /** When true, the renderer should override the lipsync viseme with
   *  a slow snore cycle. Read together with `sleepMouthOpen`. */
  sleepMouth: boolean;
  /** Current snore phase: true = open ("hhhhh"), false = closed ("zzz"). */
  sleepMouthOpen: boolean;
  /** Eye-direction hint, or null. */
  eyeHint: EyeVariantHint;
};

/** Per-state LERP factor (0..1 per frame). Higher = snappier. */
const SMOOTHING: Record<HeadTiltState, number> = {
  still: 0.10,
  idle: 0.035,
  dozing: 0.045,
  sleeping: 0.025,
  thinking: 0.08,
  listening: 0.10,
  speaking: 0.15,
  sick: 0.04,
  // Snappier so the fast tremor reads as a vibration not a wobble.
  angry: 0.20,
  // Loose so the sob bobs feel weighted, not flicky.
  sad: 0.07,
};

// ---------- doze/sleep phase machine ----------
//
// Every duration in this machine is randomized per cycle. The blink
// burst is a *variable* number of rapid blinks (2-5), each with its
// own random length and inter-blink gap, so two consecutive doze
// cycles never look identical.
//
// The "tilting-over" phase uses a per-phase smoothing override so the
// head drifts to the side slowly (like a head actually nodding off),
// while "returning" uses the state default smoothing so snapping back
// upright still feels alert. Sleeping uses an even lower override to
// make the nod-off look heavy and final.

type DozePhase =
  | "blink"      // single rapid blink (eyes closed)
  | "blinkGap"   // gap between blinks (eyes open)
  | "closedHold" // eyes closed, head upright, before tilt-over
  | "tilting"    // head LERPing slowly toward tiltDeg, eyes closed
  | "tiltedHold" // head at tiltDeg, eyes closed; SLEEPING locks here
  | "opening"    // eyes open, head still tilted
  | "returning"  // head LERPing back to 0, eyes open
  | "gap";       // upright pause before the cycle repeats

type DozeContext = {
  state: HeadTiltState; // 'dozing' | 'sleeping'
  phase: DozePhase;
  phaseStart: number;
  phaseDur: number;
  /** When non-null, overrides the state-default smoothing for this
   *  phase only. Used to slow the tilt-over without slowing the
   *  return-to-upright. */
  phaseSmoothing: number | null;
  /** Random tilt target for this cycle, in degrees. Sign = side. */
  tiltDeg: number;
  /** Remaining rapid blinks before we drop into closedHold. */
  blinksLeft: number;
};

function rerollTilt(): number {
  const side = Math.random() < 0.5 ? -1 : 1;
  return side * (12 + Math.random() * 6); // ±[12..18]°
}

function randBlinkCount(): number {
  return 2 + Math.floor(Math.random() * 4); // 2..5
}

function randBlinkDur(): number {
  return 90 + Math.random() * 90; // 90..180 ms
}

function randBlinkGap(): number {
  return 70 + Math.random() * 140; // 70..210 ms
}

function initDozeContext(state: HeadTiltState, t: number): DozeContext {
  return {
    state,
    phase: "blink",
    phaseStart: t,
    phaseDur: randBlinkDur(),
    phaseSmoothing: null,
    tiltDeg: rerollTilt(),
    blinksLeft: randBlinkCount(),
  };
}

/** Mutate ctx in place: advance to the next phase. */
function advanceDoze(ctx: DozeContext, t: number): void {
  const st = ctx.state;
  ctx.phaseStart = t;
  switch (ctx.phase) {
    case "blink":
      // Just finished a blink. If more remain, gap then blink again;
      // otherwise enter the held-closed phase.
      ctx.blinksLeft -= 1;
      if (ctx.blinksLeft > 0) {
        ctx.phase = "blinkGap";
        ctx.phaseDur = randBlinkGap();
      } else {
        ctx.phase = "closedHold";
        ctx.phaseDur = 500 + Math.random() * 1300; // 0.5..1.8 s
      }
      ctx.phaseSmoothing = null;
      return;
    case "blinkGap":
      ctx.phase = "blink";
      ctx.phaseDur = randBlinkDur();
      ctx.phaseSmoothing = null;
      return;
    case "closedHold":
      // The slow nod-over. Sleeping noticeably slower than dozing.
      ctx.phase = "tilting";
      ctx.tiltDeg = rerollTilt();
      ctx.phaseDur =
        st === "sleeping"
          ? 4500 + Math.random() * 1500 // 4.5..6.0 s
          : 2400 + Math.random() * 1600; // 2.4..4.0 s
      // Per-phase smoothing override. Lower = slower easing.
      ctx.phaseSmoothing = st === "sleeping" ? 0.010 : 0.018;
      return;
    case "tilting":
      ctx.phase = "tiltedHold";
      ctx.phaseDur =
        st === "sleeping"
          ? Number.POSITIVE_INFINITY
          : 1800 + Math.random() * 2700; // 1.8..4.5 s
      ctx.phaseSmoothing = null;
      return;
    case "tiltedHold":
      ctx.phase = "opening";
      ctx.phaseDur = 250;
      ctx.phaseSmoothing = null;
      return;
    case "opening":
      ctx.phase = "returning";
      ctx.phaseDur = 800;
      // Null → state default smoothing (snappier than the tilt-over).
      ctx.phaseSmoothing = null;
      return;
    case "returning":
      ctx.phase = "gap";
      ctx.phaseDur = 700 + Math.random() * 1500; // 0.7..2.2 s
      ctx.phaseSmoothing = null;
      return;
    case "gap":
      // Start a fresh cycle with a fresh random blink count.
      ctx.phase = "blink";
      ctx.phaseDur = randBlinkDur();
      ctx.phaseSmoothing = null;
      ctx.blinksLeft = randBlinkCount();
      return;
  }
}

function phaseOutput(
  phase: DozePhase,
  tiltDeg: number,
): { target: number; eyesClosed: boolean } {
  switch (phase) {
    case "blink":
    case "closedHold":
      return { target: 0, eyesClosed: true };
    case "blinkGap":
      return { target: 0, eyesClosed: false };
    case "tilting":
    case "tiltedHold":
      return { target: tiltDeg, eyesClosed: true };
    case "opening":
      return { target: tiltDeg, eyesClosed: false };
    case "returning":
    case "gap":
      return { target: 0, eyesClosed: false };
  }
}

// ---------- the hook ----------

const EMPTY: CharacterAnimation = {
  headDeg: 0,
  eyesClosed: false,
  grayscale: false,
  sleepMouth: false,
  sleepMouthOpen: false,
  eyeHint: null,
};

export function useHeadTilt(
  state: HeadTiltState = "idle",
  /** When set, overrides head target with this exact angle (still
   *  LERPed). Used by the playground's manual tilt slider. */
  manualDeg?: number,
): CharacterAnimation {
  const [snapshot, setSnapshot] = useState<CharacterAnimation>(EMPTY);
  const headRef = useRef(0);
  const stateRef = useRef<HeadTiltState>(state);
  stateRef.current = state;
  const manualRef = useRef<number | undefined>(manualDeg);
  manualRef.current = manualDeg;
  const dozeRef = useRef<DozeContext | null>(null);

  useEffect(() => {
    let raf = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const t = performance.now();
      const st = stateRef.current;
      const manual = manualRef.current;

      // If we left dozing/sleeping (or switched between them), drop
      // the phase context so re-entry restarts cleanly from the first
      // blink instead of resuming mid-cycle.
      if (dozeRef.current && dozeRef.current.state !== st) {
        dozeRef.current = null;
      }

      let target = 0;
      let eyesClosed = false;
      let grayscale = false;
      let sleepMouth = false;
      // null = use the state default; doze/sleep phases override this.
      let phaseSmoothing: number | null = null;

      if (manual !== undefined) {
        // Manual slider wins. Other channels stay neutral.
        target = manual;
      } else {
        switch (st) {
          case "still":
            target = 0;
            break;
          case "idle":
            // Slow, subtle, quasi-random sway. Two incommensurate
            // long-period sines so the wander never repeats. Max
            // amplitude ~3.3° but typically reads as 1-2° — closer
            // to "alive" than "moving". Earlier values (±5° on a
            // 15 s period) still felt boat-deck-like.
            target =
              2.4 * Math.sin((2 * Math.PI * t) / 22000) +
              0.9 * Math.sin((2 * Math.PI * t) / 13700 + 1.3);
            break;
          case "thinking":
            // Small fixed lean. Renderer also gets the eye-up hint.
            target = -8;
            break;
          case "listening":
            target = 2 * Math.sin((2 * Math.PI * t) / 4500);
            break;
          case "speaking":
            target = 1.5 * Math.sin((2 * Math.PI * t) / 2500);
            break;
          case "sick":
            target = 8 + 4 * Math.sin((2 * Math.PI * t) / 12000);
            break;
          case "angry":
            // Forward lean (chin down/jutted) plus a fast small
            // tremor — looks like a tense, vibrating glare. The
            // tremor is intentionally fast (~4 Hz) so the snappy
            // angry smoothing reads it as shake, not wobble.
            target =
              5 + 1.6 * Math.sin((2 * Math.PI * t) / 240);
            break;
          case "sad":
            // Sob bobs. Forward droop with a slow rhythmic dip
            // (~1.4 s cycle) so the head bobs like a person crying
            // into their hands. Amplitude is small so it reads as
            // bobbing, not nodding.
            target =
              7 + 2.5 * Math.sin((2 * Math.PI * t) / 1400);
            break;
          case "dozing":
          case "sleeping": {
            if (!dozeRef.current) dozeRef.current = initDozeContext(st, t);
            const ctx = dozeRef.current;
            if (t - ctx.phaseStart >= ctx.phaseDur) advanceDoze(ctx, t);
            const out = phaseOutput(ctx.phase, ctx.tiltDeg);
            target = out.target;
            eyesClosed = out.eyesClosed;
            // Per-phase smoothing override (e.g. slow tilt-over).
            if (ctx.phaseSmoothing != null) {
              phaseSmoothing = ctx.phaseSmoothing;
            }
            // Sleeping is locked at tiltedHold; grayscale + snore
            // mouth kick in once we've reached the held phase.
            if (st === "sleeping" && ctx.phase === "tiltedHold") {
              grayscale = true;
              sleepMouth = true;
            }
            break;
          }
        }
      }

      // LERP the head toward target. Phase override (if any) wins
      // over the state default — that's how the slow nod-over coexists
      // with the snappy return-to-upright in the same state.
      const sm = phaseSmoothing ?? SMOOTHING[st] ?? 0.06;
      const nextHead = headRef.current + (target - headRef.current) * sm;
      headRef.current = nextHead;

      // Snore mouth: slow ~3 s full cycle (1.5 s closed → 1.5 s open).
      // The previous 0.75 s flip felt like fast-forward snoring.
      const sleepMouthOpen =
        sleepMouth && Math.floor(t / 1500) % 2 === 0;

      // Thinking gets the eye-up hint; everything else clears it.
      const eyeHint: EyeVariantHint =
        manual === undefined && st === "thinking" ? "lookUpLeft" : null;

      setSnapshot({
        headDeg: nextHead,
        eyesClosed,
        grayscale,
        sleepMouth,
        sleepMouthOpen,
        eyeHint,
      });
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  return snapshot;
}
