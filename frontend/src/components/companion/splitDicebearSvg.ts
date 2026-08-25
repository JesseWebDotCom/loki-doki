import type { CharacterStyle } from "./styles";

// Ported verbatim from maipai-home-v2. Splits a DiceBear SVG into riggable parts and
// returns a FIXED neck pivot (pivotX/pivotY) so the head rotates on the neck — the
// exact mechanism that makes the head-tilt read naturally.

export type SplitResult =
  | {
      riggable: true;
      viewBox: string;
      defs: string;
      backHair: string;
      body: string;
      headSkin: string;
      clothes: string;
      headFeatures: string;
      pivotX: number;
      pivotY: number;
    }
  | {
      riggable: false;
      viewBox: string;
      inner: string;
    };

const serializer =
  typeof XMLSerializer !== "undefined" ? new XMLSerializer() : null;

const AVATAAARS_PIVOT_X = 132;
const AVATAAARS_PIVOT_Y = 199.01;
const AVATAAARS_HEAD_PATH =
  "M132 36a56 56 0 0 0-56 56v6.17A12 12 0 0 0 66 110v14a12 12 0 0 0 10.3 11.88a56.04 56.04 0 0 0 31.7 44.73L108 210L156 210L156 180.62a56.04 56.04 0 0 0 31.7-44.73A12 12 0 0 0 198 124v-14a12 12 0 0 0-10-11.83V92a56 56 0 0 0-56-56Z";
const AVATAAARS_BODY_PATH =
  "M104 199.01a72 72 0 0 0-72 72v9h200v-9a72 72 0 0 0-72-72Z";
const BOTTTS_PIVOT_X = 90;
const BOTTTS_PIVOT_Y = 180;
const TOONHEAD_PIVOT_X = 384;
const TOONHEAD_PIVOT_Y = 590;
const TOONHEAD_Y_CUTOFF = 600;
const BOTTTS_BLINK_BARS =
  '<rect x="10" y="22" width="28" height="6" rx="3" fill="#000" fill-opacity=".8"/>' +
  '<rect x="66" y="22" width="28" height="6" rx="3" fill="#000" fill-opacity=".8"/>';

function serialize(node: Node): string {
  if (!serializer) return "";
  return serializer.serializeToString(node);
}

function firstMY(path: string | null | undefined): number {
  if (!path) return Number.NaN;
  const match = path.match(/[Mm]\s*-?[\d.eE+-]+\s*[, ]\s*(-?[\d.eE+-]+)/);
  return match ? parseFloat(match[1]!) : Number.NaN;
}

function elementFirstY(element: Element): number {
  if (element.tagName === "path") {
    return firstMY(element.getAttribute("d"));
  }
  const paths = element.getElementsByTagName("path");
  let minY = Number.NaN;
  for (let index = 0; index < paths.length; index += 1) {
    const y = firstMY(paths[index]!.getAttribute("d"));
    if (!Number.isNaN(y) && (Number.isNaN(minY) || y < minY)) minY = y;
  }
  if (!Number.isNaN(minY)) return minY;
  const ellipses = element.getElementsByTagName("ellipse");
  for (let index = 0; index < ellipses.length; index += 1) {
    const y = parseFloat(ellipses[index]!.getAttribute("cy") || "NaN");
    if (!Number.isNaN(y) && (Number.isNaN(minY) || y < minY)) minY = y;
  }
  return minY;
}

function defsFor(svg: Element): string {
  return Array.from(svg.children)
    .filter((child) => child.tagName === "defs" || child.tagName === "mask")
    .map(serialize)
    .join("");
}

function splitAvataaars(doc: Document, viewBox: string): SplitResult {
  const svg = doc.documentElement;
  const outerMaskGroup = svg.querySelector('g[mask="url(#viewboxMask)"]');
  const inner = outerMaskGroup?.querySelector("g");
  if (!inner) return { riggable: false, viewBox, inner: svg.innerHTML };
  const children = Array.from(inner.children);
  if (children.length < 3 || children[0]!.tagName !== "path") {
    return { riggable: false, viewBox, inner: svg.innerHTML };
  }
  const skinFill = children[0]!.getAttribute("fill") || "currentColor";
  const bodyParts = [`<path d="${AVATAAARS_BODY_PATH}" fill="${skinFill}"/>`];
  const clothesParts: string[] = [];
  const headFeaturesParts: string[] = [];

  for (let index = 1; index < children.length; index += 1) {
    const child = children[index]!;
    if (child.tagName === "path") {
      bodyParts.push(serialize(child));
      continue;
    }
    if (child.tagName === "g") {
      const transform = child.getAttribute("transform") || "";
      if (/translate\(0\s+170\)/.test(transform)) {
        clothesParts.push(serialize(child));
      } else {
        headFeaturesParts.push(serialize(child));
      }
      continue;
    }
    bodyParts.push(serialize(child));
  }

  const wrap = (parts: string[]) => `<g transform="translate(8)">${parts.join("")}</g>`;
  return {
    riggable: true,
    viewBox,
    defs: defsFor(svg),
    backHair: "",
    body: wrap(bodyParts),
    headSkin: wrap([`<path d="${AVATAAARS_HEAD_PATH}" fill="${skinFill}"/>`]),
    clothes: wrap(clothesParts),
    headFeatures: wrap(headFeaturesParts),
    pivotX: AVATAAARS_PIVOT_X,
    pivotY: AVATAAARS_PIVOT_Y,
  };
}

function splitToonHead(doc: Document, viewBox: string): SplitResult {
  const svg = doc.documentElement;
  const outerMaskGroup = svg.querySelector('g[mask="url(#viewboxMask)"]');
  if (!outerMaskGroup) return { riggable: false, viewBox, inner: svg.innerHTML };
  const children = Array.from(outerMaskGroup.children);
  if (children.length < 5) {
    return { riggable: false, viewBox, inner: svg.innerHTML };
  }

  const backHairParts = [serialize(children[0]!)];
  const bodyParts = [serialize(children[1]!), serialize(children[2]!)];
  const headSkinParts = [serialize(children[3]!), serialize(children[4]!)];
  const clothesParts: string[] = [];
  const headFeaturesParts: string[] = [];

  for (let index = 5; index < children.length; index += 1) {
    const child = children[index]!;
    const y = elementFirstY(child);
    if (!Number.isNaN(y) && y >= TOONHEAD_Y_CUTOFF) {
      clothesParts.push(serialize(child));
    } else {
      headFeaturesParts.push(serialize(child));
    }
  }

  return {
    riggable: true,
    viewBox,
    defs: defsFor(svg),
    backHair: backHairParts.join(""),
    body: bodyParts.join(""),
    headSkin: headSkinParts.join(""),
    clothes: clothesParts.join(""),
    headFeatures: headFeaturesParts.join(""),
    pivotX: TOONHEAD_PIVOT_X,
    pivotY: TOONHEAD_PIVOT_Y,
  };
}

function splitBottts(doc: Document, viewBox: string): SplitResult {
  const svg = doc.documentElement;
  const outerMaskGroup = svg.querySelector('g[mask="url(#viewboxMask)"]');
  if (!outerMaskGroup) return { riggable: false, viewBox, inner: svg.innerHTML };
  return {
    riggable: true,
    viewBox,
    defs: defsFor(svg),
    backHair: "",
    body: "",
    headSkin: "",
    clothes: "",
    headFeatures: Array.from(outerMaskGroup.children).map(serialize).join(""),
    pivotX: BOTTTS_PIVOT_X,
    pivotY: BOTTTS_PIVOT_Y,
  };
}

export function applyBotttsBlinkOverlay(svgString: string): string {
  if (typeof DOMParser === "undefined") return svgString;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
  } catch {
    return svgString;
  }
  const eyesGroup = doc.querySelector('g[transform="translate(38 76)"]');
  if (!eyesGroup) return svgString;
  while (eyesGroup.firstChild) eyesGroup.removeChild(eyesGroup.firstChild);
  try {
    (eyesGroup as unknown as { innerHTML: string }).innerHTML = BOTTTS_BLINK_BARS;
  } catch {
    return svgString.replace(
      /<g transform="translate\(38 76\)">[\s\S]*?<\/g>/,
      `<g transform="translate(38 76)">${BOTTTS_BLINK_BARS}</g>`,
    );
  }
  return serialize(doc.documentElement);
}

export function splitDicebearSvg(
  svgString: string,
  style: CharacterStyle,
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
    if (style === "bottts") return splitBottts(doc, viewBox);
  } catch (error) {
    console.error("[splitDicebearSvg] failed", style, error);
  }
  return { riggable: false, viewBox, inner: svg.innerHTML };
}
