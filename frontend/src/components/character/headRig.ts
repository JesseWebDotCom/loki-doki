/**
 * Per-style head-tilt rig.
 *
 * Coordinates are in each DiceBear style's NATIVE viewBox pixels (not
 * percentages) because the rig SVG renders inside the same viewBox as
 * the avatar content. Three knobs per style:
 *
 *   pivot{X,Y}   — rotation center (the throat). Head <g> rotates
 *                  around this point.
 *   bulgeRadius  — circle around the pivot. The head mask = top rect
 *                  + this circle, so the neck region is covered by a
 *                  rotation-invariant disc no matter how far the head
 *                  tilts.
 *   torsoTopY    — top edge of the body's rectangular mask. A few
 *                  px ABOVE pivotY so the head's rect (0..pivotY) and
 *                  the torso's rect (torsoTopY..viewH) overlap inside
 *                  the bulge zone, eliminating any 1px antialias gap.
 *
 * The numbers below match the loki-doki-animator rig (which the user
 * said was closer to right) for avataaars and toon-head, and were
 * derived empirically for bottts (which the animator didn't ship).
 */
import type { AvatarStyle } from "./Avatar";

export type HeadRig = {
  viewW: number;
  viewH: number;
  pivotX: number;
  // pivotY = SHOULDER line. Body starts here.
  pivotY: number;
  // neckTopY = JAW line. Head ends here. The head <g> rotates rigidly
  // around (pivotX, neckTopY); the band [neckTopY, pivotY) is the
  // neck, which shears (skewX) with its bottom planted at the shoulder.
  neckTopY: number;
  bulgeRadius: number;
  torsoTopY: number;
};

// Pivot lives at the BASE of the neck (where neck meets shoulders),
// not the throat. Real head tilts pivot from the neck base. The torso
// rectangle starts AT the pivot line (no exposed strip above it) so
// the body layer never renders any static chin/jaw/neck pixels behind
// the rotated head. The head rect (0..pivotY) carries the entire head
// PLUS the neck — the neck is part of the head and rotates with it.
// The bulge circle is only there to cover the few px below the pivot
// where the neck meets the shoulders, so the seam at the pivot line
// stays hidden when the head rotates around it.
const RIGS: Record<AvatarStyle, HeadRig> = {
  // 280x280. Pivot above the shirt collar so the collar V-tabs fall
  // in the torso region, not the head rect.
  avataaars: {
    viewW: 280,
    viewH: 280,
    pivotX: 140,
    pivotY: 180,
    neckTopY: 160,
    bulgeRadius: 18,
    torsoTopY: 180,
  },
  // 180x180. Thin robot neck around y=115.
  bottts: {
    viewW: 180,
    viewH: 180,
    pivotX: 90,
    pivotY: 115,
    neckTopY: 100,
    bulgeRadius: 14,
    torsoTopY: 115,
  },
  // 768x768. Pivot at the base of the toon-head neck nub. Bulge
  // tightened so the small neck-corner pixels stay in the static
  // torso layer instead of getting swept into the head group.
  "toon-head": {
    viewW: 768,
    viewH: 768,
    pivotX: 384,
    pivotY: 620,
    neckTopY: 555,
    bulgeRadius: 60,
    torsoTopY: 620,
  },
};

export const headRigFor = (style: AvatarStyle): HeadRig =>
  RIGS[style] ?? RIGS.bottts;
