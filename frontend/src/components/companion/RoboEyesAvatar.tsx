import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";

import AngryFlames from "./AngryFlames";
import SleepingZs from "./SleepingZs";
import ThinkingDots from "./ThinkingDots";
import { useHeadTilt, type HeadTiltState } from "./useHeadTilt";
import type { Viseme } from "./visemeMap";
import { BOUNCE_MOODS, type Mood } from "./moods";

// Procedural "just eyes" renderer (desk-robot-pet face): two glowing
// rounded-rect eyes on a transparent background, all expression carried by
// parametric eyelids + squash/stretch + gaze - no mouth, no head.
// Deliberately NOT a DiceBear style: CharacterAvatar branches here before any
// of the DiceBear machinery (visemeMap/faceForState/splitDicebearSvg) runs.
//
// Parameter model follows the classic desk-robot procedural-eye convention:
// per-eye scale, offset, upper-lid coverage at the inner/outer corner (angled
// lids), lower-lid lift with an optional smile bow, plus corner-radius
// roundness. A single rAF loop lerps current → target params (same pattern as
// useHeadTilt) and runs the blink + gaze-saccade state machines on timestamps.

// ── Parameter model ───────────────────────────────────────────────────────────

interface EyeTarget {
  sx: number;    // width scale
  sy: number;    // height scale (blink multiplies this)
  dx: number;    // gaze/expression offset px
  dy: number;
  lidIn: number;  // upper-lid drop at the INNER corner, fraction of eye height
  lidOut: number; // upper-lid drop at the OUTER corner, fraction of eye height
  lift: number;   // lower-lid lift, fraction of eye height
  curve: number;  // upward bow of the lower lid (smiling eyes), fraction of height
  round: number;  // 0 = configured corner radius, 1 = fully circular
}

interface FaceTarget {
  l: EyeTarget;
  r: EyeTarget;
  hearts: boolean; // replace both eyes with heart shapes (love)
}

const OPEN: EyeTarget = { sx: 1, sy: 1, dx: 0, dy: 0, lidIn: 0, lidOut: 0, lift: 0, curve: 0, round: 0 };
const eye = (p: Partial<EyeTarget>): EyeTarget => ({ ...OPEN, ...p });
const both = (p: Partial<EyeTarget>): FaceTarget => ({ l: eye(p), r: eye(p), hearts: false });

// Emotion → eye-shape vocabulary (the established desk-robot grammar):
// happy = raised lower lid ("smiling eyes"), angry = upper lids angled down at
// the inner corners, sad = angled down at the outer corners, surprised = big
// and fully round, tired = flat droopy upper lids, thinking = squint + look up.
const MOOD_FACE: Partial<Record<Mood, FaceTarget>> = {
  // Happy's bottom-lid arc is deliberately exaggerated - eyes-only faces lose
  // "happy" the most since the mouth normally carries it.
  happy: both({ lift: 0.4, curve: 0.22, sy: 0.95 }),
  laugh: both({ lift: 0.52, curve: 0.3, lidIn: 0.08, lidOut: 0.08, sx: 1.06 }),
  wink: { l: eye({ lift: 0.18, curve: 0.1 }), r: eye({ sy: 0.07, dy: 6 }), hearts: false },
  love: { l: eye({ sx: 1.06, sy: 1.06 }), r: eye({ sx: 1.06, sy: 1.06 }), hearts: true },
  surprised: both({ sx: 1.14, sy: 1.16, round: 1 }),
  confused: { l: eye({ dx: 5 }), r: eye({ sx: 0.78, sy: 0.78, dx: 5, dy: -7, lidOut: 0.14 }), hearts: false },
  tired: both({ lidIn: 0.38, lidOut: 0.46, dy: 3 }),
  sad: both({ lidIn: 0.1, lidOut: 0.44, dy: 5 }),
  // Steep inner-lid diagonal + eyes nudged together (AU4+5+7) - the diagonal
  // must stay steep or anger reads as disgust on an eyes-only face.
  angry: { l: eye({ lidIn: 0.46, lidOut: 0.06, sy: 0.92, dx: 3 }), r: eye({ lidIn: 0.46, lidOut: 0.06, sy: 0.92, dx: -3 }), hearts: false },
  sick: { l: eye({ lidIn: 0.3, lidOut: 0.5, dy: 4 }), r: eye({ lidIn: 0.4, lidOut: 0.3, dy: 5 }), hearts: false },
  think: both({ dx: -7, dy: -8, lidIn: 0.16, lidOut: 0.16 }),
};

const STATE_FACE: Partial<Record<HeadTiltState, FaceTarget>> = {
  dozing: both({ lidIn: 0.26, lidOut: 0.3, dy: 2 }),
  sleeping: both({ sy: 0.06, dy: 9 }),
  thinking: MOOD_FACE.think,
  listening: both({ sx: 1.06, sy: 1.1, dy: -2 }),
  sick: MOOD_FACE.sick,
  angry: MOOD_FACE.angry,
  sad: MOOD_FACE.sad,
  shocked: both({ sx: 1.16, sy: 1.2, round: 1 }),
};

function faceTarget(tilt: HeadTiltState, mood: Mood): FaceTarget {
  // Sleep always wins (lids stay shut), otherwise mood beats the activity face -
  // same precedence RiggedDicebearAvatar uses so the two engines feel consistent.
  if (tilt === "sleeping") return STATE_FACE.sleeping!;
  if (mood !== "neutral" && MOOD_FACE[mood]) return MOOD_FACE[mood]!;
  return STATE_FACE[tilt] ?? both({});
}

// ── Geometry ──────────────────────────────────────────────────────────────────

const VIEW = 200;
// Base eye geometry per configured shape (w, h, corner radius). Default keeps
// the classic taller-than-wide robot-eye ratio, framed tight so the face fills
// the viewBox like the DiceBear heads do (store cards render avatars small).
const SHAPES: Record<string, { w: number; h: number; r: number }> = {
  rounded: { w: 72, h: 118, r: 26 },
  circle: { w: 84, h: 84, r: 42 },
  tall: { w: 58, h: 130, r: 28 },
  wide: { w: 88, h: 84, r: 24 },
};
const EYE_CX = 50; // eye-center distance from face center
const EYE_CY = 100;

/**
 * Rounded-rect eye path with independently dropped upper corners (angled lid),
 * a liftable lower lid, and an optional upward bow (smiling eyes). Degrades to
 * a rounded sliver when nearly closed (blink / sleep).
 */
function eyePath(cx: number, w: number, h: number, r: number, topL: number, topR: number, lift: number, curve: number): string {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const yT = EYE_CY - h / 2;
  const yB = EYE_CY + h / 2 - lift;
  const yTL = Math.min(yT + topL, yB - 2);
  const yTR = Math.min(yT + topR, yB - 2);
  const hL = yB - yTL;
  const hR = yB - yTR;
  const rTL = Math.min(r, hL / 2, w / 2);
  const rTR = Math.min(r, hR / 2, w / 2);
  const rB = Math.min(r, Math.min(hL, hR) / 2, w / 2);
  const bow = curve > 0 ? ` Q ${cx} ${yB - curve * 2} ${x0 + rB} ${yB}` : ` L ${x0 + rB} ${yB}`;
  return (
    `M ${x0} ${yTL + rTL}` +
    ` Q ${x0} ${yTL} ${x0 + rTL} ${yTL}` +
    ` L ${x1 - rTR} ${yTR}` +
    ` Q ${x1} ${yTR} ${x1} ${yTR + rTR}` +
    ` L ${x1} ${yB - rB}` +
    ` Q ${x1} ${yB} ${x1 - rB} ${yB}` +
    bow +
    ` Q ${x0} ${yB} ${x0} ${yB - rB}` +
    ` Z`
  );
}

// Heart centered on (cx, EYE_CY), sized to roughly match the eye box.
function heartPath(cx: number, scale: number): string {
  const s = scale;
  const y = EYE_CY;
  return (
    `M ${cx} ${y + 26 * s}` +
    ` C ${cx - 34 * s} ${y + 2 * s} ${cx - 26 * s} ${y - 26 * s} ${cx - 4 * s} ${y - 16 * s}` +
    ` Q ${cx} ${y - 13 * s} ${cx} ${y - 8 * s}` +
    ` Q ${cx} ${y - 13 * s} ${cx + 4 * s} ${y - 16 * s}` +
    ` C ${cx + 26 * s} ${y - 26 * s} ${cx + 34 * s} ${y + 2 * s} ${cx} ${y + 26 * s}` +
    ` Z`
  );
}

// Deterministic per-seed phase offset so grids of idle robo-eyes don't blink
// and wander in unison (same trick as RiggedDicebearAvatar.seedPhase).
function seedPhase(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return (Math.abs(h % 10000) / 10000) * 20;
}

function first(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return typeof v === "string" ? v : undefined;
}

const lerp = (c: number, t: number, a: number) => c + (t - c) * a;

// ── Animation frame state ─────────────────────────────────────────────────────

interface EyeFrame extends EyeTarget { heart: number } // heart = 0..1 crossfade
interface Frame { l: EyeFrame; r: EyeFrame; blink: number; gazeX: number; gazeY: number; bob: number; pulse: number }

const initialFrame = (): Frame => ({
  l: { ...OPEN, heart: 0 },
  r: { ...OPEN, heart: 0 },
  blink: 1,
  gazeX: 0,
  gazeY: 0,
  bob: 0,
  pulse: 1,
});

// States where the eyes idly wander / saccade. Expression states hold their gaze.
const WANDER_STATES: ReadonlySet<HeadTiltState> = new Set(["still", "idle", "dozing", "speaking", "listening"]);

interface Props {
  seed: string;
  /** Rig config from the studio (eyeColor / eyeShape / glow, DiceBear ["v"] array convention). */
  config?: Record<string, unknown>;
  size?: number;
  className?: string;
  tiltState?: HeadTiltState;
  /** Explicit tilt override (studio slider); null resumes auto motion. */
  manualTiltDeg?: number | null;
  /** Tokens streaming → talking (glow pulse + bob fallback when no audio viseme). */
  speaking?: boolean;
  /** Live viseme from the TTS audio bridge - drives the talk pulse on the audio clock. */
  audioViseme?: Viseme | null;
  mood?: Mood;
  staticPose?: boolean;
  /** Skip ThinkingDots/SleepingZs/AngryFlames so callers can hoist them. */
  suppressOverlays?: boolean;
}

export default function RoboEyesAvatar({
  seed,
  config,
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
  const color = `#${first(config?.["eyeColor"]) ?? "00e5c3"}`; // signature robot teal
  const shape = SHAPES[first(config?.["eyeShape"]) ?? "rounded"] ?? SHAPES.rounded!;
  const glow = first(config?.["glow"]) ?? "soft";

  const phase = useMemo(() => seedPhase(seed || "default"), [seed]);
  // Same continuous whole-face motion engine as the DiceBear companions: the
  // per-state sway/tilt (dozing drift, speaking sway, sleeping droop, shocked
  // snap...) rotates the whole eye pair about the face center.
  const anim = useHeadTilt(tiltState, manualTiltDeg ?? null, staticPose, phase);
  const [frame, setFrame] = useState<Frame>(initialFrame);
  const frameRef = useRef<Frame>(frame);

  const audioDriven = audioViseme !== undefined && audioViseme !== null;
  const playing = audioDriven ? audioViseme !== "closed" : speaking;

  // Timestamp-driven blink + saccade state machines, folded into one rAF loop.
  const machines = useRef({ nextBlinkAt: 0, blinkStart: -1, doubleBlink: false, nextGazeAt: 0, gazeTX: 0, gazeTY: 0 });

  useEffect(() => {
    if (staticPose) {
      const t = faceTarget(tiltState, mood);
      const f: Frame = {
        ...initialFrame(),
        l: { ...t.l, heart: t.hearts ? 1 : 0 },
        r: { ...t.r, heart: t.hearts ? 1 : 0 },
      };
      frameRef.current = f;
      setFrame(f);
      return undefined;
    }
    let raf = 0;
    let last = performance.now();
    const m = machines.current;
    if (m.nextBlinkAt === 0) m.nextBlinkAt = performance.now() + 1200 + (phase % 1) * 3000;

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const t = (now / 1000) + phase;
      const target = faceTarget(tiltState, mood);
      const cur = frameRef.current;
      const asleep = tiltState === "sleeping";

      // Blink machine - 3s base + 0-2s jitter (the RoboEyes autoblinker
      // convention), ~10% double blinks, close fast / open ~40% slower.
      // Suppressed while asleep or heart-eyed.
      let blink = 1;
      if (!asleep && !target.hearts) {
        if (m.blinkStart < 0 && now >= m.nextBlinkAt) {
          m.blinkStart = now;
          m.doubleBlink = Math.random() < 0.1;
        }
        if (m.blinkStart >= 0) {
          const p = (now - m.blinkStart) / 150;
          if (p >= 1) {
            if (m.doubleBlink) {
              m.doubleBlink = false;
              m.blinkStart = now + 70;
            } else {
              m.blinkStart = -1;
              m.nextBlinkAt = now + 3000 + Math.random() * 2000;
            }
          } else if (p >= 0) {
            blink = Math.max(0.04, p < 0.4 ? 1 - p / 0.4 : (p - 0.4) / 0.6);
          }
        }
      }

      // Gaze machine - small saccades + idle wander in relaxed states; snaps
      // home when an expression owns the gaze (its own dx/dy applies instead).
      if (WANDER_STATES.has(tiltState) && mood === "neutral") {
        if (now >= m.nextGazeAt) {
          // Saccade to a point inside a circular gaze cone (y bounded by x so
          // the corners of the box are never hit), then hold 0.4–1.8s.
          const range = tiltState === "dozing" ? 4 : 8;
          const gx = (Math.random() * 2 - 1) * range;
          const maxY = Math.sqrt(range * range - gx * gx) * 0.6;
          m.gazeTX = gx;
          m.gazeTY = (Math.random() * 2 - 1) * maxY + (tiltState === "dozing" ? 2 : 0);
          m.nextGazeAt = now + 400 + Math.random() * 1400;
        }
      } else {
        m.gazeTX = 0;
        m.gazeTY = 0;
        m.nextGazeAt = now + 600;
      }

      const smooth = 1 - Math.exp(-dt * (tiltState === "shocked" || tiltState === "angry" ? 18 : 8));
      const gazeSmooth = 1 - Math.exp(-dt * 14);
      const heartT = target.hearts ? 1 : 0;
      const mix = (c: EyeFrame, tg: EyeTarget): EyeFrame => ({
        sx: lerp(c.sx, tg.sx, smooth),
        sy: lerp(c.sy, tg.sy, smooth),
        dx: lerp(c.dx, tg.dx, smooth),
        dy: lerp(c.dy, tg.dy, smooth),
        lidIn: lerp(c.lidIn, tg.lidIn, smooth),
        lidOut: lerp(c.lidOut, tg.lidOut, smooth),
        lift: lerp(c.lift, tg.lift, smooth),
        curve: lerp(c.curve, tg.curve, smooth),
        round: lerp(c.round, tg.round, smooth),
        heart: lerp(c.heart, heartT, 1 - Math.exp(-dt * 10)),
      });

      // Idle breathing (slow 1%-amplitude sy sine) + talk bob/glow-pulse, plus
      // the BOUNCE_MOODS physical flourish (laugh/surprised hop).
      const breathe = asleep ? Math.sin(t * 1.6) * 0.02 : Math.sin(t * 2.2) * 0.008;
      const hop = BOUNCE_MOODS.has(mood) ? -Math.abs(Math.sin(t * 2 * Math.PI * 2.2)) * 3.5 : 0;
      const next: Frame = {
        l: mix(cur.l, target.l),
        r: mix(cur.r, target.r),
        blink,
        gazeX: lerp(cur.gazeX, m.gazeTX, gazeSmooth),
        gazeY: lerp(cur.gazeY, m.gazeTY, gazeSmooth),
        bob: (playing ? Math.sin(t * 2 * Math.PI * 4.5) * 1.4 : lerp(cur.bob, 0, smooth)) + hop,
        pulse: playing ? 0.8 + 0.2 * Math.sin(t * 2 * Math.PI * 3.2) : lerp(cur.pulse, 1, smooth),
      };
      next.l.sy += breathe;
      next.r.sy += breathe;
      frameRef.current = next;
      setFrame(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [staticPose, tiltState, mood, playing, phase]);

  // ── Render ──────────────────────────────────────────────────────────────────

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

  // Glow is a STATIC stack of zero-offset drop-shadows (tight core + wide halo);
  // the talk pulse animates group opacity instead - animating blur radius forces
  // a filter re-rasterization every frame.
  const glowPx = glow === "none" ? 0 : glow === "strong" ? 9 : 5;
  const glowFilter =
    glowPx > 0
      ? `drop-shadow(0 0 ${glowPx}px ${color})${glow === "strong" ? ` drop-shadow(0 0 ${glowPx * 2.2}px ${color})` : ""}`
      : undefined;

  const renderEye = (side: "l" | "r") => {
    const e = frame[side];
    const mirror = side === "l" ? 1 : -1; // inner corner faces the face center
    const cx = 100 + (side === "l" ? -EYE_CX : EYE_CX);
    // The tilt engine can also close the eyes (static sleep pose). Dozing's
    // periodic eye closure is deliberately ignored: an eyes-only face that
    // closes vanishes (blank store card) - the drooped lids from the dozing
    // face target already read as resting.
    const closedByTilt = anim.eyesClosed && tiltState !== "dozing";
    const blinkF = closedByTilt ? Math.min(frame.blink, 0.05) : frame.blink;
    // Squash-and-stretch blink: eyes widen slightly as they close so the
    // blink reads cartoon-snappy instead of a flat shutter.
    const w = shape.w * e.sx * (1 + (1 - blinkF) * 0.12);
    const h = Math.max(4, shape.h * e.sy * blinkF);
    const r = lerp(shape.r, Math.min(w, h) / 2, e.round);
    // Map inner/outer lid drops onto left/right path corners per side.
    const topL = (mirror === 1 ? e.lidOut : e.lidIn) * h;
    const topR = (mirror === 1 ? e.lidIn : e.lidOut) * h;
    const d =
      e.heart > 0.5
        ? heartPath(cx, (w / 54) * (0.9 + 0.1 * frame.pulse))
        : eyePath(cx, w, h, r, topL, topR, e.lift * h, e.curve * h);
    return <path key={side} d={d} fill={color} transform={`translate(${(e.dx + frame.gazeX).toFixed(2)} ${(e.dy + frame.gazeY + frame.bob).toFixed(2)})`} />;
  };

  return (
    <div className={className} style={wrapperStyle}>
      {!staticPose && !suppressOverlays && tiltState === "sleeping" ? <SleepingZs tiltDeg={anim.headDeg} grayscale={anim.grayscale} /> : null}
      {!staticPose && !suppressOverlays && tiltState === "thinking" ? <ThinkingDots tiltDeg={anim.headDeg} /> : null}
      {!staticPose && !suppressOverlays && isAngry ? (
        <div style={{ position: "absolute", inset: 0, opacity: 0.5, pointerEvents: "none" }}>
          <AngryFlames tiltDeg={anim.headDeg} />
        </div>
      ) : null}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          position: "relative",
          zIndex: 1,
          // Tight framing: let the glow halo render past the viewBox edges.
          overflow: "visible",
          filter,
          transition: "filter 600ms ease",
          ...(isAngry && !staticPose ? { animation: "ld-roboeyes-shake 0.18s linear infinite" } : null),
        }}
      >
        {isAngry && !staticPose ? (
          <style>{`@keyframes ld-roboeyes-shake {
            0% { transform: translate(0,0); } 25% { transform: translate(-1.5px,1px); }
            50% { transform: translate(1.5px,-1px); } 75% { transform: translate(-1px,-1.5px); }
            100% { transform: translate(0,0); } }`}</style>
        ) : null}
        <g
          transform={`rotate(${anim.headDeg.toFixed(3)} 100 100)`}
          style={{ ...(glowFilter ? { filter: glowFilter } : null), opacity: frame.pulse.toFixed(3) }}
        >
          {renderEye("l")}
          {renderEye("r")}
        </g>
      </svg>
    </div>
  );
}
