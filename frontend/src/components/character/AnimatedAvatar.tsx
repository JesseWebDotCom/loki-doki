import React, { useEffect, useMemo, useRef, useState } from "react";
import { type AvatarStyle } from "./Avatar";
import { ttsController } from "../../utils/tts";
import {
  blinkEyeFor,
  defaultEyeFor,
  mouthForViseme,
  type Viseme,
} from "./visemeMap";
import { headRigFor } from "./headRig";
import { useHeadTilt, type HeadTiltState } from "./useHeadTilt";
import { renderAvatarSvg } from "./svgRender";

/**
 * AnimatedAvatar — DiceBear avatar with TTS-driven lipsync, idle
 * blink, and a real head tilt (body planted, head sways).
 *
 * Architecture:
 *   - Renders the avatar as INLINE SVG inside a single outer <svg>
 *     that defines two masks (animator-style):
 *       ld-mask-torso : a rectangle covering the bottom of the
 *                       viewBox (the static body region).
 *       ld-mask-head  : a rectangle covering the top of the viewBox
 *                       PLUS a circle centered at the rotation
 *                       pivot. The circle is rotation-invariant so
 *                       the neck stays fully covered no matter how
 *                       far the head tilts.
 *     The avatar's inner markup is dropped into TWO sibling <g>
 *     groups under those masks. The head group is then wrapped in
 *     another <g> with a CSS rotate transform pivoted at the bulge
 *     center. Because everything composes inside one SVG, mask
 *     edges antialias correctly and there's no DOM-compositing
 *     seam between layers — which is the bug the previous CSS
 *     mask-image approach hit.
 *   - Lipsync/blink work by re-deriving the DiceBear options on
 *     viseme/blink change and re-running the SVG render. The result
 *     is memoized so the rotation animation (which only updates the
 *     transform on a wrapper element) doesn't re-parse the SVG.
 *   - Head rotation comes from ``useHeadTilt(state)``: a rAF + LERP
 *     loop that targets a per-state center+sine and eases the
 *     displayed angle toward it. State changes ease over instead of
 *     snapping. Default state is ``"idle"``; the playground passes
 *     ``manualTiltDeg`` to override the target with a slider value.
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
  /** Per-instance rig override (pivotY/bulgeRadius/torsoTopY) for the
   *  playground tuning panel. Other fields fall back to the static
   *  rig table. */
  rigOverride?: { pivotY?: number; neckTopY?: number; bulgeRadius?: number; torsoTopY?: number };
  /** Debug overlay: red dot at pivot, red circle at bulge boundary,
   *  red dashed line at torsoTopY. */
  debugRig?: boolean;
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
  rigOverride,
  debugRig = false,
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

  // Memoize the SVG render. Re-derives only when the underlying
  // option set actually changes (style/seed/options/viseme/blink).
  // The rotation animation lives outside this memo via a CSS
  // transform on a wrapper <g>, so the rAF loop never re-renders
  // the SVG markup.
  const optionsKey = JSON.stringify(effectiveOptions);
  const rendered = useMemo(
    () => renderAvatarSvg(style, seed, effectiveOptions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [style, seed, optionsKey],
  );

  const baseRig = headRigFor(style);
  const rig = {
    ...baseRig,
    pivotY: rigOverride?.pivotY ?? baseRig.pivotY,
    neckTopY: rigOverride?.neckTopY ?? baseRig.neckTopY,
    bulgeRadius: rigOverride?.bulgeRadius ?? baseRig.bulgeRadius,
    torsoTopY: rigOverride?.torsoTopY ?? baseRig.torsoTopY,
  };
  const wrapperStyle: React.CSSProperties = {
    display: "inline-block",
    ...(size ? { width: size, height: size } : { width: "100%", height: "100%" }),
  };

  if (!rendered) {
    return <div className={className} style={wrapperStyle} />;
  }

  // ``ld-`` ids are scoped per-style/seed so multiple avatars on
  // the same page don't trample each other's mask defs.
  const idSuffix = `${style}-${seed.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const headMaskId = `ld-mask-head-${idSuffix}`;
  const bodyMaskId = `ld-mask-body-${idSuffix}`;

  // Build the dual-group rig SVG. Both <g> elements receive the same
  // inner markup; the masks pick which region is visible. The head
  // group's rotation is driven by a CSS custom property
  // ``--ld-head-rotate`` set on the wrapper div — that way the SVG
  // markup string is stable, only the wrapper's style updates per
  // frame, and React skips re-applying dangerouslySetInnerHTML.
  const svgMarkup = useMemo(
    () =>
      `<defs>` +
      // Head mask = rect above the shoulder line + bulge disc at the
      // pivot. Applied to the avatar BEFORE rotation, so only the
      // head/neck pixels enter the rotating layer.
      `<mask id="${headMaskId}" maskUnits="userSpaceOnUse">` +
      `<rect x="0" y="0" width="${rig.viewW}" height="${rig.pivotY}" fill="white"/>` +
      `<circle cx="${rig.pivotX}" cy="${rig.pivotY}" r="${rig.bulgeRadius}" fill="white"/>` +
      `</mask>` +
      // Body mask = inverse of the head mask. White everywhere except
      // a head-shaped hole at the top (rect + bulge). The static base
      // uses this so the original (untilted) head is removed; long
      // hair / accessories that hang below the shoulder line are kept.
      `<mask id="${bodyMaskId}" maskUnits="userSpaceOnUse">` +
      `<rect x="0" y="0" width="${rig.viewW}" height="${rig.viewH}" fill="white"/>` +
      `<rect x="0" y="0" width="${rig.viewW}" height="${rig.pivotY}" fill="black"/>` +
      `<circle cx="${rig.pivotX}" cy="${rig.pivotY}" r="${rig.bulgeRadius}" fill="black"/>` +
      `</mask>` +
      `</defs>` +
      // 1. Static base with a head-shaped hole — body + anything that
      //    sits below the shoulder line. No original head visible.
      `<g mask="url(#${bodyMaskId})">${rendered.inner}</g>` +
      // 2. Rotated head on top — only the head/neck cutout, rotated
      //    rigidly around (pivotX, pivotY). The cutout overdraws the
      //    static base's head with the tilted version. Gumby bend.
      `<g class="ld-head-group" ` +
      `style="transform: rotate(var(--ld-head-rotate, 0deg)); ` +
      `transform-origin: ${rig.pivotX}px ${rig.pivotY}px; ` +
      `transform-box: view-box;">` +
      `<g mask="url(#${headMaskId})">${rendered.inner}</g>` +
      `</g>` +
      (debugRig
        ? // Red overlay: dashed torso line, bulge circle, pivot dot.
          // Stroke widths scale with the viewBox so they're visible
          // on both the 180 and 768 styles.
          `<g pointer-events="none" fill="none" stroke="red" stroke-width="${Math.max(1, rig.viewW / 200)}">` +
          `<line x1="0" y1="${rig.torsoTopY}" x2="${rig.viewW}" y2="${rig.torsoTopY}" stroke-dasharray="${rig.viewW / 40},${rig.viewW / 40}"/>` +
          `<circle cx="${rig.pivotX}" cy="${rig.pivotY}" r="${rig.bulgeRadius}"/>` +
          `<circle cx="${rig.pivotX}" cy="${rig.pivotY}" r="${Math.max(2, rig.viewW / 100)}" fill="red"/>` +
          `</g>`
        : ""),
    [rendered, rig, headMaskId, bodyMaskId, debugRig],
  );

  const wrapperWithVar: React.CSSProperties = {
    ...wrapperStyle,
    // CSS custom properties live on the style object as-is. The SVG
    // group reads it via ``var(--ld-head-rotate)`` so per-frame
    // updates only touch this one declaration on the wrapper div.
    ["--ld-head-rotate" as never]: `${headDeg.toFixed(3)}deg`,
  };

  return (
    <div className={className} style={wrapperWithVar}>
      <svg
        viewBox={rendered.viewBox}
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%", display: "block" }}
        dangerouslySetInnerHTML={{ __html: svgMarkup }}
      />
    </div>
  );
};

export default AnimatedAvatar;
