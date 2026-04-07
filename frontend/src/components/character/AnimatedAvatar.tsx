import React, { useEffect, useRef, useState } from "react";
import Avatar, { type AvatarStyle } from "./Avatar";
import { ttsController } from "../../utils/tts";
import {
  blinkEyeFor,
  defaultEyeFor,
  mouthForViseme,
  type Viseme,
} from "./visemeMap";

/**
 * AnimatedAvatar — DiceBear avatar with TTS-driven lipsync and idle
 * micro-animation (blink + sway).
 *
 * Architecture:
 *   - Subscribes to ttsController's viseme stream. The controller
 *     emits canonical visemes that VoiceStreamer derives from Piper's
 *     IPA phonemes (38 ms ahead of the audio for visual parity).
 *   - On every viseme change we re-derive the DiceBear `mouth` option
 *     for the active style via visemeMap. The data-URI render in
 *     Avatar.tsx is fast enough (synchronous JS, no network) to swap
 *     mouths at viseme cadence (~10-20 Hz).
 *   - Idle blink runs on a setInterval cycle (avataaars + toon-head
 *     only — bottts has no blinking eye variant). Sway is pure CSS
 *     keyframes on a wrapper div, no React re-renders.
 *
 * Drop-in replacement for <Avatar> for any place that wants liveness.
 * Static contexts (admin grid thumbnails, picker cards) keep using
 * the plain <Avatar> to avoid N subscriptions.
 */
type Props = {
  style: AvatarStyle;
  seed: string;
  baseOptions?: Record<string, unknown>;
  size?: number;
  className?: string;
};

const BLINK_INTERVAL_MS = 4500;
const BLINK_DURATION_MS = 140;

const AnimatedAvatar: React.FC<Props> = ({
  style,
  seed,
  baseOptions,
  size,
  className,
}) => {
  const [viseme, setViseme] = useState<Viseme>("closed");
  const [blinking, setBlinking] = useState(false);
  const blinkTimer = useRef<number | null>(null);

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
      // Randomize the gap a touch so blinks don't tick like a clock.
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

  return (
    <div className={`animated-avatar-sway ${className ?? ""}`} style={size ? { width: size, height: size } : undefined}>
      <Avatar style={style} seed={seed} options={effectiveOptions} size={size} />
    </div>
  );
};

export default AnimatedAvatar;
