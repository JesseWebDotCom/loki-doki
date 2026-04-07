/**
 * Per-style head-tilt rig.
 *
 * AnimatedAvatar renders the same DiceBear data-URI twice, stacked:
 *   - body layer  : full image, masked to HIDE the head region
 *   - head layer  : full image, masked to SHOW only the head region,
 *                   and rotated around a neck pivot
 *
 * Because both layers share an identical ``src``, the seam at the
 * neck is invisible by construction (the pixels match exactly). When
 * the head rotates, only the head image sweeps; the torso never
 * moves. That body-stays-planted, head-only-tilts cue is what reads
 * as "alive" — it's the look DiceBear can't give us natively.
 *
 * The only style-specific knobs are *where* the neck is in the
 * viewBox and where the head should pivot from. ``neckPercent`` is
 * the vertical line (0–100, % from top) that splits head from body.
 * ``pivotY`` is the rotation origin (we lift it slightly above the
 * neck so the chin sweeps less than the crown — keeps the seam tight
 * even at ±8°). ``featherPercent`` is the half-width of the soft
 * mask gradient that hides any residual ghost at the seam.
 *
 * Toon-head's viewBox is essentially head-only, so its neck line
 * sits very low and the body region is just the small shoulder nub.
 */
import type { AvatarStyle } from "./Avatar";

export type HeadRig = {
  /** Vertical split between body (above) and head (below=hidden). 0-100 from top. */
  neckPercent: number;
  /** Rotation origin Y, 0-100 from top. ~3% above neckPercent. */
  pivotY: number;
  /** Half-width of the soft seam blend, in percent of full height. */
  featherPercent: number;
};

const RIGS: Record<AvatarStyle, HeadRig> = {
  // Avataaars: human bust. Neck sits a touch above middle.
  avataaars: { neckPercent: 52, pivotY: 49, featherPercent: 4 },
  // Bottts: robot. Head/body split is roughly mid-image.
  bottts: { neckPercent: 48, pivotY: 45, featherPercent: 4 },
  // Toon-head: head-only viewBox. The whole top is head; only the
  // last ~22% is shoulder/neck nub.
  "toon-head": { neckPercent: 78, pivotY: 75, featherPercent: 5 },
};

export const headRigFor = (style: AvatarStyle): HeadRig =>
  RIGS[style] ?? RIGS.bottts;
