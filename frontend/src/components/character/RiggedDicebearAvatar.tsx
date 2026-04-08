/**
 * RiggedDicebearAvatar — DiceBear avatar with a TRUE rigid head rotation.
 *
 * Pipeline:
 *   1. Render the avatar via @dicebear/core (same as AnimatedAvatar).
 *   2. Run the result through `splitDicebearSvg`, which slices the
 *      output into four layers: body, head-skin, clothes, head-features.
 *   3. Drop the four layers into one outer <svg>, with the head-skin
 *      and head-features layers wrapped in <g transform="rotate(...)">
 *      sharing the same pivot. The head turns as one rigid piece;
 *      neck/clothes/body never move.
 *
 * Lipsync + blink piggy-back on the existing AnimatedAvatar plumbing:
 * we override the DiceBear `mouth` / `eyes` options, re-render the SVG,
 * and re-run the splitter. The split is memoized on the rendered SVG
 * string so a viseme change only re-runs DiceBear and the (cheap)
 * DOMParser pass — not the full React tree.
 *
 * Falls back gracefully: if `splitDicebearSvg` reports `riggable: false`
 * (unsupported style or unexpected DiceBear structure), we render the
 * original inner markup as one static <g> with no rotation. The page
 * always shows *something*.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createAvatar, type Style } from "@dicebear/core";
import { avataaars, toonHead } from "@dicebear/collection";
import { type AvatarStyle } from "./Avatar";
import { ttsController } from "../../utils/tts";
import { useHeadTilt, type HeadTiltState } from "./useHeadTilt";
import {
  blinkEyeFor,
  defaultEyeFor,
  mouthForViseme,
  type Viseme,
} from "./visemeMap";
import { splitDicebearSvg } from "./splitDicebearSvg";
import { filterOptionsForStyle } from "./styleSchemas";

const STYLE_MAP: Partial<Record<AvatarStyle, Style<object>>> = {
  avataaars: avataaars as unknown as Style<object>,
  "toon-head": toonHead as unknown as Style<object>,
};

const BLINK_INTERVAL_MS = 4500;
const BLINK_DURATION_MS = 140;

type Props = {
  style: AvatarStyle;
  seed: string;
  baseOptions?: Record<string, unknown>;
  size?: number;
  className?: string;
  tiltState?: HeadTiltState;
  manualTiltDeg?: number;
};

const RiggedDicebearAvatar: React.FC<Props> = ({
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

  // Subscribe to TTS visemes.
  useEffect(() => {
    const unsub = ttsController.subscribeViseme((v) => {
      setViseme((v || "closed") as Viseme);
    });
    return () => {
      unsub();
    };
  }, []);

  // Idle blink loop.
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

  // Compose effective DiceBear options. Mirrors AnimatedAvatar's logic
  // so the rigged preview behaves like the existing renderer except
  // for the rigid head.
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

  // Render the underlying DiceBear SVG. Memoized on the option set so
  // unrelated re-renders (rotation tick) don't re-run DiceBear.
  const optionsKey = JSON.stringify(effectiveOptions);
  const svgString = useMemo(() => {
    const collection = STYLE_MAP[style];
    if (!collection) return null;
    try {
      const safe = filterOptionsForStyle(style, effectiveOptions);
      return createAvatar(collection, {
        seed: seed || "default",
        ...safe,
      }).toString();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[RiggedDicebearAvatar] DiceBear render failed", style, e);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style, seed, optionsKey]);

  // Run the splitter. Memoized on the SVG string — splitter is
  // pure-ish (DOMParser + string ops, no side effects).
  const split = useMemo(() => {
    if (!svgString) return null;
    return splitDicebearSvg(svgString, style);
  }, [svgString, style]);

  const wrapperStyle: React.CSSProperties = size
    ? { width: size, height: size, display: "inline-block" }
    : { width: "100%", height: "100%", display: "inline-block" };

  if (!split) {
    return <div className={className} style={wrapperStyle} />;
  }

  // Unsupported style / split failed → render the un-rigged SVG so
  // the user still sees something instead of a blank box.
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

  // Build the rigged SVG. The HEAD layers (back hair, head skin, head
  // features) all share the same rotate transform so they swing as
  // one piece. Z-order:
  //   1. backHair  (rotated) — behind everything; long hair draping
  //                            past the body in toon-head.
  //   2. body      (static)  — paints over the back hair from y=neck.
  //   3. headSkin  (rotated) — head circle + neck overhang.
  //   4. clothes   (static)  — collar paints over the neck overhang.
  //   5. headFeatures (rotated) — eyes/mouth/eyebrows/front hair/etc.
  const rot = `rotate(${headDeg.toFixed(3)} ${split.pivotX} ${split.pivotY})`;
  const markup =
    split.defs +
    `<g class="ld-rigged-back-hair" transform="${rot}">${split.backHair}</g>` +
    `<g class="ld-rigged-body">${split.body}</g>` +
    `<g class="ld-rigged-head-skin" transform="${rot}">${split.headSkin}</g>` +
    `<g class="ld-rigged-clothes">${split.clothes}</g>` +
    `<g class="ld-rigged-head-features" transform="${rot}">${split.headFeatures}</g>`;

  return (
    <div className={className} style={wrapperStyle}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={split.viewBox}
        style={{ width: "100%", height: "100%", display: "block" }}
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    </div>
  );
};

export default RiggedDicebearAvatar;
