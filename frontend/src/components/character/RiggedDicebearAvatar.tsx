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
import { avataaars, bottts, toonHead } from "@dicebear/collection";
import { type AvatarStyle } from "./Avatar";
import { ttsController } from "../../utils/tts";
import { useHeadTilt, type HeadTiltState } from "./useHeadTilt";
import {
  blinkEyeFor,
  defaultEyeFor,
  lookUpEyeFor,
  mouthForViseme,
  type Viseme,
} from "./visemeMap";
import { applyBotttsBlinkOverlay, splitDicebearSvg } from "./splitDicebearSvg";
import { filterOptionsForStyle } from "./styleSchemas";
import { faceForState } from "./faceForState";
import BotttsSparks from "./BotttsSparks";

const STYLE_MAP: Partial<Record<AvatarStyle, Style<object>>> = {
  avataaars: avataaars as unknown as Style<object>,
  bottts: bottts as unknown as Style<object>,
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
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [blinking, setBlinking] = useState(false);
  const blinkTimer = useRef<number | null>(null);
  const anim = useHeadTilt(tiltState, manualTiltDeg);
  const headDeg = anim.headDeg;

  // Subscribe to TTS visemes AND speaking state. We need both: the
  // viseme stream tells us *which* mouth shape to draw during a
  // phoneme, and the speaking-key listener tells us *whether* TTS is
  // active at all (the viseme stream emits transient `closed` frames
  // between phonemes that we don't want to confuse with "not talking").
  useEffect(() => {
    const unsubV = ttsController.subscribeViseme((v) => {
      setViseme((v || "closed") as Viseme);
    });
    const syncSpeaking = () => {
      setIsSpeaking(ttsController.speakingMessageKey() != null);
    };
    // Sync once immediately so an avatar mounted *while* TTS is already
    // playing picks up the speaking flag without waiting for the next
    // emit (which only fires on state transitions).
    syncSpeaking();
    const unsubS = ttsController.subscribe(syncSpeaking);
    return () => {
      unsubV();
      unsubS();
    };
  }, []);

  // Idle blink loop. Suppressed while dozing/sleeping — those states
  // run their own scripted blink sequence via the animation hook, and
  // a random blink on top would fight it.
  useEffect(() => {
    if (!blinkEyeFor(style)) return;
    if (tiltState === "dozing" || tiltState === "sleeping") return;
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
  }, [style, tiltState]);

  // Compose effective DiceBear options.
  //
  // Precedence (highest wins) for each face channel — mouth, eyes,
  // eyebrows — applied independently:
  //
  //   1. Lipsync / blink   (only when actively speaking or blinking)
  //   2. Sleep snore mouth (only while sleeping)
  //   3. Behavioral state face profile (sick / listening / thinking)
  //   4. User's `baseOptions` selection from the editor
  //   5. Style default eye (for blink fallback consistency)
  //
  // Critical bug fix: previous logic ALWAYS clobbered `baseOptions.mouth`
  // (and `eyes`) with the viseme value, even when TTS wasn't speaking
  // and no animation was running — so changing the mouth dropdown in
  // the editor visibly did nothing. We now only override these when
  // there's a real reason to.
  const effectiveOptions: Record<string, unknown> = { ...(baseOptions ?? {}) };
  const stateFace = faceForState(tiltState, style);
  // The user's editor selection always wins over state-face profiles.
  // We only apply a stateFace channel when the user hasn't picked
  // their own value for that channel. (sleep snore + live TTS lipsync
  // still override — those are involuntary.)
  const userSetMouth = "mouth" in (baseOptions ?? {});
  const userSetEyes = "eyes" in (baseOptions ?? {});
  const userSetEyebrows = "eyebrows" in (baseOptions ?? {});
  // `shocked` is a transient click-feedback reaction. Like sleep snore
  // it's involuntary, so it overrides the user's mouth/eyes/eyebrows
  // picks AND beats live TTS lipsync — otherwise clicking the avatar
  // mid-response would only jerk the head with no facial reaction.
  const isShockedOverride = tiltState === "shocked" && stateFace != null;

  // ---- mouth ----
  if (anim.sleepMouth) {
    // Snore cycle takes precedence over everything.
    const v: Viseme = anim.sleepMouthOpen ? "o" : "closed";
    effectiveOptions.mouth = [mouthForViseme(style, v)];
    effectiveOptions.mouthProbability = 100;
  } else if (isShockedOverride && stateFace?.mouth) {
    effectiveOptions.mouth = [stateFace.mouth];
    effectiveOptions.mouthProbability = 100;
  } else if (isSpeaking) {
    // Live lipsync. Use whatever viseme the TTS stream emitted last.
    effectiveOptions.mouth = [mouthForViseme(style, viseme)];
    effectiveOptions.mouthProbability = 100;
  } else if (stateFace?.mouth && !userSetMouth) {
    effectiveOptions.mouth = [stateFace.mouth];
    effectiveOptions.mouthProbability = 100;
  }
  // else: leave whatever the user picked in baseOptions intact.

  const blinkEye = blinkEyeFor(style);
  const defaultEye = defaultEyeFor(style);
  // Eyes-closed sources, in order of precedence:
  //   1. anim.eyesClosed — scripted close from dozing/sleeping
  //   2. blinking        — random idle blink loop
  // Both route through the same DiceBear `eyes` override (or the
  // bottts SVG overlay below), so the renderer doesn't care which
  // channel triggered the close.
  const eyesShouldClose = anim.eyesClosed || blinking;
  // Sentinels (prefix `__`) are not real DiceBear enum values — they
  // mean "this style needs an SVG post-process to blink" (see bottts).
  // Skip the eyes override in that case; the overlay runs below.
  const blinkViaOverride =
    eyesShouldClose && blinkEye != null && !blinkEye.startsWith("__");
  // Thinking eye-look hint. Only applies when eyes are NOT closing
  // (you can't roll closed eyes). Per-style mapping in visemeMap.
  const lookUpEye = !eyesShouldClose && anim.eyeHint === "lookUpLeft"
    ? lookUpEyeFor(style)
    : null;

  // ---- eyes ----
  if (isShockedOverride && stateFace?.eyes) {
    effectiveOptions.eyes = [stateFace.eyes];
    effectiveOptions.eyesProbability = 100;
  } else if (blinkViaOverride) {
    effectiveOptions.eyes = [blinkEye as string];
    effectiveOptions.eyesProbability = 100;
  } else if (lookUpEye) {
    effectiveOptions.eyes = [lookUpEye];
    effectiveOptions.eyesProbability = 100;
  } else if (stateFace?.eyes && !userSetEyes) {
    effectiveOptions.eyes = [stateFace.eyes];
    effectiveOptions.eyesProbability = 100;
  } else if (defaultEye && !userSetEyes) {
    // Style default — only when the user hasn't picked their own.
    effectiveOptions.eyes = [defaultEye];
    effectiveOptions.eyesProbability = 100;
  }
  // else: leave whatever the user picked in baseOptions intact.

  // ---- eyebrows ----
  if (isShockedOverride && stateFace?.eyebrows) {
    effectiveOptions.eyebrows = [stateFace.eyebrows];
    effectiveOptions.eyebrowsProbability = 100;
  } else if (stateFace?.eyebrows && !userSetEyebrows) {
    effectiveOptions.eyebrows = [stateFace.eyebrows];
    effectiveOptions.eyebrowsProbability = 100;
  }
  // else: leave whatever the user picked in baseOptions intact.

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

  // Bottts has no closed-eye DiceBear variant — patch the rendered
  // SVG with custom closed-eye bars whenever eyes should be closed
  // (random blink OR scripted dozing/sleeping close).
  const processedSvg = useMemo(() => {
    if (!svgString) return null;
    if (style === "bottts" && eyesShouldClose) {
      return applyBotttsBlinkOverlay(svgString);
    }
    return svgString;
  }, [svgString, style, eyesShouldClose]);

  // Run the splitter. Memoized on the SVG string — splitter is
  // pure-ish (DOMParser + string ops, no side effects).
  const split = useMemo(() => {
    if (!processedSvg) return null;
    return splitDicebearSvg(processedSvg, style);
  }, [processedSvg, style]);

  // Behavioral filter effects:
  //   - sleeping → desaturate to grayscale
  //   - sick     → sickly green tint (sepia + hue rotate towards green)
  // Both ease over 600ms so transitions don't snap.
  let wrapperFilter = "none";
  if (anim.grayscale) {
    wrapperFilter = "grayscale(1)";
  } else if (tiltState === "sick") {
    wrapperFilter =
      "sepia(0.55) hue-rotate(55deg) saturate(1.6) brightness(0.95)";
  }
  const wrapperStyle: React.CSSProperties = {
    ...(size
      ? { width: size, height: size }
      : { width: "100%", height: "100%" }),
    display: "inline-block",
    position: "relative",
  };
  // Filter is applied to the SVG (not the wrapper) so the sick green
  // tint doesn't recolor the bottts spark overlay.
  const svgFilterStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    display: "block",
    position: "relative",
    zIndex: 1,
    filter: wrapperFilter,
    transition: "filter 600ms ease",
  };
  // Bottts gets decorative sparks behind the head when sick.
  const showSparks = tiltState === "sick" && style === "bottts";

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
      {showSparks && <BotttsSparks />}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={split.viewBox}
        style={svgFilterStyle}
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    </div>
  );
};

export default RiggedDicebearAvatar;
