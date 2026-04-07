import React, { useEffect, useRef, useState } from "react";
import Avatar, { type AvatarStyle } from "./Avatar";
import { ttsController } from "../../utils/tts";
import {
  blinkEyeFor,
  defaultEyeFor,
  mouthForViseme,
  type Viseme,
} from "./visemeMap";
import { headRigFor } from "./headRig";
import { useHeadTilt, type HeadTiltState } from "./useHeadTilt";

/**
 * AnimatedAvatar — DiceBear avatar with TTS-driven lipsync, idle
 * blink, and a real head tilt (body planted, head sways).
 *
 * Architecture:
 *   - Subscribes to ttsController's viseme stream and re-derives the
 *     DiceBear ``mouth`` option per frame. The data-URI render is
 *     cached internally by DiceBear so the cost is just a JS call.
 *   - Renders the avatar TWICE, stacked, with the same ``src``:
 *       body layer : full image, mask hides the head region
 *       head layer : full image, mask shows only the head, rotated
 *                    around a per-style neck pivot
 *     The seam at the neck is invisible because both layers are the
 *     exact same pixels — when the head rotates, only the head image
 *     sweeps. A 4-5% feathered mask gradient hides any residual
 *     ghosting at ±8°.
 *   - Head rotation comes from ``useHeadTilt(state)``: a rAF + LERP
 *     loop that targets a per-state center+sine and eases the
 *     displayed angle toward it. The default state is ``"idle"``;
 *     callers can pass other states (``"thinking"``, ``"sleeping"``,
 *     etc.) and the head smoothly transitions.
 *   - Idle blink runs on a setInterval cycle (avataaars + toon-head
 *     only — bottts has no blinking eye variant).
 */
type Props = {
  style: AvatarStyle;
  seed: string;
  baseOptions?: Record<string, unknown>;
  size?: number;
  className?: string;
  /** Behavioral state driving head tilt. Default: "idle". */
  tiltState?: HeadTiltState;
  /** When set, overrides the state's target angle (degrees). The
   *  head still LERPs toward it. Used by the playground manual slider. */
  manualTiltDeg?: number;
};

const BLINK_INTERVAL_MS = 4500;
const BLINK_DURATION_MS = 140;

const AnimatedAvatar: React.FC<Props> = ({
  style,
  seed,
  baseOptions,
  size,
  className,
  tiltState = "idle",
  manualTiltDeg,
}) => {
  const [viseme, setViseme] = useState<Viseme>("closed");
  const [blinking, setBlinking] = useState(false);
  const blinkTimer = useRef<number | null>(null);
  const headDeg = useHeadTilt(tiltState, manualTiltDeg);

  // Subscribe to TTS viseme stream. The subscriber pushes the current
  // viseme synchronously, so first paint is consistent.
  useEffect(() => {
    const unsub = ttsController.subscribeViseme((v) => {
      setViseme((v || "closed") as Viseme);
    });
    return () => {
      unsub();
    };
  }, []);

  // Idle blink loop. Skipped if the style has no blinkable eye.
  useEffect(() => {
    if (!blinkEyeFor(style)) return;
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
  }, [style]);

  // Compose the effective DiceBear options. Order matters: caller
  // baseOptions first, then mouth/eye overrides so the animation
  // always wins. Probability companions get bumped to 100 so the
  // override actually shows (matches CharacterPlayground rules).
  const effectiveOptions: Record<string, unknown> = { ...(baseOptions ?? {}) };
  const mouth = mouthForViseme(style, viseme);
  effectiveOptions.mouth = [mouth];
  effectiveOptions.mouthProbability = 100;

  const blinkEye = blinkEyeFor(style);
  const defaultEye = defaultEyeFor(style);
  if (blinking && blinkEye) {
    effectiveOptions.eyes = [blinkEye];
    effectiveOptions.eyesProbability = 100;
  } else if (defaultEye && !("eyes" in (baseOptions ?? {}))) {
    effectiveOptions.eyes = [defaultEye];
    effectiveOptions.eyesProbability = 100;
  }

  const rig = headRigFor(style);
  const wrapperStyle: React.CSSProperties = {
    position: "relative",
    display: "inline-block",
    ...(size ? { width: size, height: size } : { width: "100%", height: "100%" }),
  };

  // Body layer: hide the head region. Soft seam via a downward
  // gradient that goes black (visible) below the feathered band and
  // transparent (hidden) above it.
  const bodyTop = rig.neckPercent - rig.featherPercent;
  const bodyBot = rig.neckPercent + rig.featherPercent;
  const bodyMask = `linear-gradient(to bottom, transparent ${bodyTop}%, black ${bodyBot}%)`;

  // Head layer: inverse — visible above the feathered band, fading
  // out below it. Same band coords so the two gradients meet exactly.
  const headMask = `linear-gradient(to bottom, black ${bodyTop}%, transparent ${bodyBot}%)`;

  const layerStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
  };

  return (
    <div className={className} style={wrapperStyle}>
      {/* Body layer — planted */}
      <div
        style={{
          ...layerStyle,
          WebkitMaskImage: bodyMask,
          maskImage: bodyMask,
        }}
      >
        <Avatar style={style} seed={seed} options={effectiveOptions} />
      </div>
      {/* Head layer — rotates around the neck pivot */}
      <div
        style={{
          ...layerStyle,
          WebkitMaskImage: headMask,
          maskImage: headMask,
          transform: `rotate(${headDeg.toFixed(3)}deg)`,
          transformOrigin: `50% ${rig.pivotY}%`,
          willChange: "transform",
        }}
      >
        <Avatar style={style} seed={seed} options={effectiveOptions} />
      </div>
    </div>
  );
};

export default AnimatedAvatar;
