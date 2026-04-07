import React, { useMemo } from "react";
import { createAvatar, type Style } from "@dicebear/core";
import { avataaars, bottts, toonHead } from "@dicebear/collection";
import { filterOptionsForStyle } from "./styleSchemas";

/**
 * Reusable DiceBear renderer.
 *
 * Two responsibilities beyond a thin createAvatar wrapper:
 *
 * 1. **Style-name normalization.** The character system stores
 *    ``avatar_style`` as kebab-case (``toon-head``) to match
 *    DiceBear's canonical URL identifier. The JS package exports
 *    those collections as camelCase (``toonHead``), so this
 *    component owns the single mapping point.
 *
 * 2. **Option filtering.** Each DiceBear style has a non-overlapping
 *    ~30-property schema. Passing leftover keys from another style
 *    silently produces a degraded SVG (this was the v1 toon-head
 *    bug — leftover ``top``/``mouth`` from avataaars). The filter
 *    runs unconditionally so it can never silently break again.
 *
 * Render strategy: data-URI ``<img>`` rather than inline SVG. Two
 * reasons:
 *   - Inline SVG via dangerouslySetInnerHTML hit DOM-parsing edge
 *     cases that left certain styles invisible against dark UI
 *     backgrounds (toon-head specifically — its SVG had no default
 *     background and rendered the soft strokes against UI dark gray).
 *   - ``object-contain`` in CSS gives reliable letterbox-style
 *     fitting for any viewBox aspect ratio without us having to
 *     post-process the SVG markup.
 *   The Phase-5 viseme animation will need to switch back to inline
 *   SVG to drive per-element transforms — that change is local to
 *   this file when we get there.
 */
export type AvatarStyle = "avataaars" | "bottts" | "toon-head";

const STYLE_MAP: Record<AvatarStyle, Style<object>> = {
  avataaars: avataaars as unknown as Style<object>,
  bottts: bottts as unknown as Style<object>,
  "toon-head": toonHead as unknown as Style<object>,
};

type Props = {
  style: AvatarStyle;
  seed: string;
  /** Pixel size. If omitted, the avatar fills its parent. */
  size?: number;
  options?: Record<string, unknown>;
  className?: string;
};

const Avatar: React.FC<Props> = ({ style, seed, size, options, className }) => {
  const dataUri = useMemo(() => {
    const collection = STYLE_MAP[style] ?? STYLE_MAP.bottts;
    try {
      const safeOptions = filterOptionsForStyle(style, options ?? {});
      const avatar = createAvatar(collection, {
        seed: seed || "default",
        ...safeOptions,
      });
      return avatar.toDataUri();
    } catch (e) {
      console.error("[Avatar] render failed", style, e);
      return null;
    }
  }, [style, seed, options]);

  const sizing: React.CSSProperties = size
    ? { width: size, height: size }
    : { width: "100%", height: "100%" };

  if (dataUri === null) {
    return (
      <div
        className={`${className ?? ""} flex items-center justify-center bg-red-500/10 text-red-400 text-[10px] font-mono`}
        style={sizing}
      >
        err
      </div>
    );
  }

  return (
    <img
      src={dataUri}
      alt={`${style} avatar`}
      className={className}
      style={{ ...sizing, objectFit: "contain", display: "block" }}
      draggable={false}
    />
  );
};

export default Avatar;
