/**
 * Helper that renders a DiceBear avatar as a raw SVG string and
 * extracts its inner markup (children of the root <svg>) so we can
 * embed it inside our own rig SVG.
 *
 * Used by AnimatedAvatar to build the dual-group head/torso rig
 * (animator-style) where the same avatar content is rendered twice
 * inside one outer <svg>: once masked to show the torso (static),
 * once masked to show the head (rotated around the neck pivot).
 *
 * The static <Avatar> component still uses the data-URI <img> path
 * for thumbnails / pickers / non-animated contexts.
 */
import { createAvatar, type Style } from "@dicebear/core";
import { avataaars, bottts, toonHead } from "@dicebear/collection";
import type { AvatarStyle } from "./Avatar";
import { filterOptionsForStyle } from "./styleSchemas";

const STYLE_MAP: Record<AvatarStyle, Style<object>> = {
  avataaars: avataaars as unknown as Style<object>,
  bottts: bottts as unknown as Style<object>,
  "toon-head": toonHead as unknown as Style<object>,
};

export type AvatarSvg = {
  /** The viewBox attribute of the rendered SVG (e.g., "0 0 280 280"). */
  viewBox: string;
  /** Inner markup of the root <svg>: defs + content groups, but no
   *  <svg> wrapper. Safe to drop into a parent <svg> via
   *  ``dangerouslySetInnerHTML``. */
  inner: string;
};

export function renderAvatarSvg(
  style: AvatarStyle,
  seed: string,
  options: Record<string, unknown> | undefined,
): AvatarSvg | null {
  try {
    const collection = STYLE_MAP[style] ?? STYLE_MAP.bottts;
    const safe = filterOptionsForStyle(style, options ?? {});
    const raw = createAvatar(collection, {
      seed: seed || "default",
      ...safe,
    }).toString();
    const vbMatch = raw.match(/viewBox="([^"]+)"/);
    const viewBox = vbMatch ? vbMatch[1] : "0 0 280 280";
    // Strip the outer <svg ...> opening tag and the closing </svg>.
    const inner = raw
      .replace(/^[\s\S]*?<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "");
    return { viewBox, inner };
  } catch (e) {
    console.error("[svgRender] failed", style, e);
    return null;
  }
}
