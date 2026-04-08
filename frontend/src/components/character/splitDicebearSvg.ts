/**
 * splitDicebearSvg — surgical splitter that takes a DiceBear-rendered
 * SVG string and partitions its inner content into four layers so the
 * head can rotate as a rigid <g> while the body stays stiff.
 *
 * Output layers (drawn in this z-order):
 *   1. body          — body skin / shoulders / chest shadow. Static.
 *   2. headSkin      — head skin only (no face features). Rotated.
 *   3. clothes       — clothing/collar. Static. Sits ON TOP of the
 *                      head skin's neck overhang so the collar always
 *                      covers the head's tail end.
 *   4. headFeatures  — face features + hair + hat + accessories.
 *                      Rotated with the same transform as the head
 *                      skin so the whole head reads as one piece.
 *
 * Per-style logic:
 *
 * - **avataaars**: the skin silhouette is one monolithic <path>. We
 *   replace it with TWO derived paths: an overhanging head outline
 *   (head circle + neck rect extended below the chin line) and the
 *   body U. The path data is hard-coded against the structure shipped
 *   with `@dicebear/avataaars@9`. If DiceBear ever changes the source
 *   path the splitter falls back to returning the SVG as-is, marked
 *   `riggable: false`.
 *
 * - **toon-head**: head and body are already separate <path> elements
 *   in the source. We bucket children by their KNOWN INDEX for the
 *   stable prefix (back hair, body, body shadow, head, cheek shadow)
 *   and by a Y-coordinate heuristic for the variable tail (clothes vs
 *   face features). Clothes paths in toon-head consistently start at
 *   y > 600 and face/hair paths at y < 600.
 *
 * Other styles (bottts, etc.) are not supported and return
 * `riggable: false`.
 */
import type { AvatarStyle } from "./Avatar";

export type SplitResult =
  | {
      riggable: true;
      viewBox: string;
      defs: string;
      /** Hair that drapes BEHIND the body (toon-head only). Rotated
       *  with the head, but renders in z-order BEFORE the body so the
       *  body and clothes paint over it. Empty string if none. */
      backHair: string;
      body: string;
      headSkin: string;
      clothes: string;
      headFeatures: string;
      /** Rotation pivot in SVG viewBox coordinates. */
      pivotX: number;
      pivotY: number;
    }
  | {
      riggable: false;
      /** Original inner markup; the caller can render it un-rigged. */
      viewBox: string;
      inner: string;
    };

// ----- avataaars constants -----
// Original skin path bounds (translated frame, post `<g transform="translate(8)">`).
// The chin line — where the head outline meets the neck rect top — is
// at body-local y=180.61 across x ∈ [108, 156]. Pivot at the center of
// that line. After translate(8), viewBox x adds 8 → pivotX = 132.
const AVATAAARS_PIVOT_X = 132;
const AVATAAARS_PIVOT_Y = 180.61;

// HEAD path (head circle + neck rect extended down to y=210 for
// rotation overhang). Coordinates are in pre-translate (translate(8))
// space, so the transform on the parent <g> still applies.
const AVATAAARS_HEAD_PATH =
  "M132 36" +
  "a56 56 0 0 0-56 56" +
  "v6.17" +
  "A12 12 0 0 0 66 110" +
  "v14" +
  "a12 12 0 0 0 10.3 11.88" +
  "a56.04 56.04 0 0 0 31.7 44.73" +
  "L108 210" + // overhang straight down (was v25 from 180.61)
  "L156 210" + // close horizontally (hidden under body+clothes)
  "L156 180.62" + // back up the right neck wall
  "a56.04 56.04 0 0 0 31.7-44.73" +
  "A12 12 0 0 0 198 124" +
  "v-14" +
  "a12 12 0 0 0-10-11.83" +
  "V92" +
  "a56 56 0 0 0-56-56" +
  "Z";

// BODY path (the U-shaped torso, with a flat top at y=199.01 — the
// neck rect bottom in the original). The head's overhang at y∈[180.61,
// 210] sits ON TOP of this U; the head skin's bottom edge is hidden
// under the body skin from y=199.01 down.
const AVATAAARS_BODY_PATH =
  "M104 199.01" +
  "a72 72 0 0 0-72 72" +
  "v9" +
  "h200" +
  "v-9" +
  "a72 72 0 0 0-72-72" +
  "Z";

// ----- toon-head constants -----
// Head circle bottom meets the neck/body at body-local y≈590, x≈384.
const TOONHEAD_PIVOT_X = 384;
const TOONHEAD_PIVOT_Y = 590;
// Y cutoff for partitioning toon-head's variable tail (index 5+).
// Anything starting below this is clothing/body; above is face/hair.
const TOONHEAD_Y_CUTOFF = 600;

// ---------- helpers ----------

const serializer =
  typeof XMLSerializer !== "undefined" ? new XMLSerializer() : null;

function serialize(node: Node): string {
  if (!serializer) return "";
  return serializer.serializeToString(node);
}

/** Extract the y of the first M command in a path's data, or NaN. */
function firstMY(d: string | null | undefined): number {
  if (!d) return NaN;
  // Match M or m followed by x[, ]y. Allow scientific notation.
  const m = d.match(/[Mm]\s*-?[\d.eE+-]+\s*[, ]\s*(-?[\d.eE+-]+)/);
  return m ? parseFloat(m[1]) : NaN;
}

/** Walk a node's subtree and find the smallest "first M y" we can. */
function elementFirstY(el: Element): number {
  if (el.tagName === "path") {
    return firstMY(el.getAttribute("d"));
  }
  const paths = el.getElementsByTagName("path");
  let minY = NaN;
  for (let i = 0; i < paths.length; i++) {
    const y = firstMY(paths[i].getAttribute("d"));
    if (!isNaN(y) && (isNaN(minY) || y < minY)) minY = y;
  }
  // Also check ellipse/circle cy as a fallback (toon-head mouth uses
  // ellipses inside a mask).
  if (isNaN(minY)) {
    const ellipses = el.getElementsByTagName("ellipse");
    for (let i = 0; i < ellipses.length; i++) {
      const y = parseFloat(ellipses[i].getAttribute("cy") || "NaN");
      if (!isNaN(y) && (isNaN(minY) || y < minY)) minY = y;
    }
  }
  return minY;
}

// ---------- splitters ----------

function splitAvataaars(doc: Document, viewBox: string): SplitResult {
  // The structure we expect:
  //   <svg> <metadata>… </metadata> <mask id="viewboxMask">…</mask>
  //     <g mask="url(#viewboxMask)">
  //       <g transform="translate(8)">
  //         <path d="…skin…"/>
  //         <path d="…chest shadow…"/>
  //         <g transform="translate(0 170)">…clothes…</g>
  //         <g transform="translate(78 134)">…mouth…</g>
  //         …more face/hair groups…
  //       </g>
  //     </g>
  //   </svg>
  const svg = doc.documentElement;
  const outerMaskGroup = svg.querySelector('g[mask="url(#viewboxMask)"]');
  const inner = outerMaskGroup?.querySelector("g");
  if (!inner) return { riggable: false, viewBox, inner: svg.innerHTML };
  const children = Array.from(inner.children);
  if (children.length < 3) {
    return { riggable: false, viewBox, inner: svg.innerHTML };
  }
  const skin = children[0];
  if (skin.tagName !== "path") {
    return { riggable: false, viewBox, inner: svg.innerHTML };
  }
  const skinFill = skin.getAttribute("fill") || "currentColor";

  // Build the two split skin paths with the original fill.
  const headSkinSvg = `<path d="${AVATAAARS_HEAD_PATH}" fill="${skinFill}"/>`;
  const bodySkinSvg = `<path d="${AVATAAARS_BODY_PATH}" fill="${skinFill}"/>`;

  // Bucket the remaining children. The chest shadow is the second
  // <path>; the clothes group is the <g transform="translate(0 170)">;
  // every other <g> is a face/hair feature.
  const bodyParts: string[] = [bodySkinSvg];
  const clothesParts: string[] = [];
  const headFeaturesParts: string[] = [];

  for (let i = 1; i < children.length; i++) {
    const c = children[i];
    if (c.tagName === "path") {
      // Chest shadow — assume any bare <path> after the skin is body-side.
      bodyParts.push(serialize(c));
      continue;
    }
    if (c.tagName === "g") {
      const t = c.getAttribute("transform") || "";
      if (/translate\(0\s+170\)/.test(t)) {
        clothesParts.push(serialize(c));
      } else {
        headFeaturesParts.push(serialize(c));
      }
      continue;
    }
    // Anything else (defs, masks) — leave it on the body layer to be
    // safe, so refs from face groups still resolve.
    bodyParts.push(serialize(c));
  }

  // Inner group has translate(8); we keep that translate on each
  // wrapped layer so coordinates match the original.
  const wrap = (parts: string[]) =>
    `<g transform="translate(8)">${parts.join("")}</g>`;

  // Pull defs/masks from outside the inner group so referenced ids
  // (e.g., the viewboxMask) still resolve.
  const defs = Array.from(svg.children)
    .filter((c) => c.tagName === "defs" || c.tagName === "mask")
    .map(serialize)
    .join("");

  return {
    riggable: true,
    viewBox,
    defs,
    backHair: "", // avataaars has no behind-the-body hair layer
    body: wrap(bodyParts),
    headSkin: wrap([headSkinSvg]),
    clothes: wrap(clothesParts),
    headFeatures: wrap(headFeaturesParts),
    pivotX: AVATAAARS_PIVOT_X,
    pivotY: AVATAAARS_PIVOT_Y,
  };
}

function splitToonHead(doc: Document, viewBox: string): SplitResult {
  // Stable structure for indices [0..4]:
  //   [0] back-hair  <g transform="translate(0 10)">  → headFeatures
  //   [1] body skin  <path M432.5 556.5 …>            → body
  //   [2] body shadow <path M336 556 …>               → body
  //   [3] head skin  <path M191.5 452.5 …>            → headSkin
  //   [4] cheek shadow <path M202.22 410 …>           → headSkin
  //   [5+] variable: clothes / mouth / eyes / brows / hair
  //                  partitioned by first-M y coord against TOONHEAD_Y_CUTOFF.
  const svg = doc.documentElement;
  const outerMaskGroup = svg.querySelector('g[mask="url(#viewboxMask)"]');
  if (!outerMaskGroup) {
    return { riggable: false, viewBox, inner: svg.innerHTML };
  }
  const children = Array.from(outerMaskGroup.children);
  if (children.length < 5) {
    return { riggable: false, viewBox, inner: svg.innerHTML };
  }

  const backHairParts: string[] = [];
  const bodyParts: string[] = [];
  const headSkinParts: string[] = [];
  const clothesParts: string[] = [];
  const headFeaturesParts: string[] = [];

  // Stable prefix. Index [0] is the BACK hair (long hair that drapes
  // behind the body); it must render BEFORE the body in z-order so
  // the body and clothes paint over it. We rotate it with the head
  // group regardless.
  backHairParts.push(serialize(children[0]));
  bodyParts.push(serialize(children[1]));         // body skin
  bodyParts.push(serialize(children[2]));         // body shadow
  headSkinParts.push(serialize(children[3]));     // head skin
  headSkinParts.push(serialize(children[4]));     // cheek shadow

  // Variable tail
  for (let i = 5; i < children.length; i++) {
    const c = children[i];
    const y = elementFirstY(c);
    if (!isNaN(y) && y >= TOONHEAD_Y_CUTOFF) {
      clothesParts.push(serialize(c));
    } else {
      headFeaturesParts.push(serialize(c));
    }
  }

  const defs = Array.from(svg.children)
    .filter((c) => c.tagName === "defs" || c.tagName === "mask")
    .map(serialize)
    .join("");

  return {
    riggable: true,
    viewBox,
    defs,
    backHair: backHairParts.join(""),
    body: bodyParts.join(""),
    headSkin: headSkinParts.join(""),
    clothes: clothesParts.join(""),
    headFeatures: headFeaturesParts.join(""),
    pivotX: TOONHEAD_PIVOT_X,
    pivotY: TOONHEAD_PIVOT_Y,
  };
}

// ---------- public entry ----------

export function splitDicebearSvg(
  svgString: string,
  style: AvatarStyle,
): SplitResult {
  if (typeof DOMParser === "undefined") {
    return { riggable: false, viewBox: "0 0 280 280", inner: "" };
  }
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
  } catch {
    return { riggable: false, viewBox: "0 0 280 280", inner: "" };
  }
  const svg = doc.documentElement;
  const viewBox = svg.getAttribute("viewBox") || "0 0 280 280";

  try {
    if (style === "avataaars") return splitAvataaars(doc, viewBox);
    if (style === "toon-head") return splitToonHead(doc, viewBox);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[splitDicebearSvg] failed", style, e);
  }
  return { riggable: false, viewBox, inner: svg.innerHTML };
}
