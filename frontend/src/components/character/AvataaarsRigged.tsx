/**
 * AvataaarsRigged — fork of `avataaars`'s <Avatar> that splits the
 * skin silhouette into HEAD and BODY paths so the head can rotate as
 * a real rigid <g>. Uses Pablo Stanley's original avataaars artwork
 * via the `avataaars` npm package (Fang-Pen Lin's React port).
 *
 * Why this exists: DiceBear's avataaars (and the underlying art)
 * ships the entire skin — head circle, neck, body U-shape — as one
 * monolithic <path>. Rigging the head requires either a pixel mask
 * (which produces seams under any rotation) or splitting that path.
 * The avataaars npm package gives us per-piece React components
 * (Face, Top, Clothes), so we can compose two SVG groups manually
 * and substitute our own split skin paths instead of the original.
 *
 * Path split: the original skin path (`path3` in
 * node_modules/avataaars/dist/avatar/index.js) is one closed shape
 * tracing the jaw line at y=144.611 across [76, 124] and looping
 * around either the body U or the head circle. We cut at that jaw
 * line and emit two closed sub-paths:
 *   HEAD = head circle + ear notches, closed across the jaw line.
 *   BODY = neck rect + U-shaped torso, closed across the jaw line.
 *
 * Both fill with the chosen skin color. The HEAD group is wrapped in
 * a <g transform="rotate(deg 100 144.611)">, pivoting at the jaw line
 * center. The BODY group has no transform — it's stiff.
 *
 * Context plumbing: avataaars uses legacy React childContext to pass
 * an OptionContext down to its part components (Clothes/Face/Top read
 * the chosen variant from there). We set up the same OptionContext
 * here, mirroring the AvatarComponent wrapper from
 * node_modules/avataaars/dist/index.js.
 */
import * as React from "react";
import { OptionContext, allOptions } from "avataaars";
// Selector is not re-exported from the main entry — deep import.
import * as SelectorMod from "avataaars/dist/options/Selector";

// ----- React 19 compat shim -----
// `avataaars@2.0.0` was built for React 17 and uses LEGACY context
// (`Selector.contextTypes = { optionContext: ... }`) to receive the
// option-context from its parent Avatar. React 19 removed legacy
// contextTypes on class components, so `this.context.optionContext`
// is now `undefined` and the Selector crashes inside
// `UNSAFE_componentWillMount`. We patch Selector's prototype getter
// to read from a module-level singleton that AvataaarsRigged sets
// before its own render. This means only one AvataaarsRigged can
// render at a time on a page — fine for the playground preview, but
// will need rework before we use this on a list view.
let currentOptionContext: OptionContext | null = null;

// Unwrap Selector and patch its prototype lazily on first use, inside
// a try/catch. If anything goes wrong (Vite resolves the deep import
// to an unexpected shape, the lib version changes, etc.) we log and
// fall through — the rigged preview will be broken but the rest of
// the app continues to load instead of whitescreening.
let selectorPatched = false;
function ensureSelectorPatched(): void {
  if (selectorPatched) return;
  selectorPatched = true;
  try {
    let cur: unknown = SelectorMod;
    for (let i = 0; i < 4; i++) {
      if (cur && typeof cur === "object" && "prototype" in cur) break;
      if (cur && typeof cur === "object" && "default" in cur) {
        cur = (cur as { default: unknown }).default;
        continue;
      }
      break;
    }
    const cls = cur as { prototype?: object } | undefined;
    if (!cls || !cls.prototype) {
      // eslint-disable-next-line no-console
      console.error(
        "[AvataaarsRigged] could not find Selector class to patch",
        SelectorMod,
      );
      return;
    }
    Object.defineProperty(cls.prototype, "optionContext", {
      configurable: true,
      get() {
        return currentOptionContext;
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[AvataaarsRigged] Selector patch failed", e);
  }
}
// Deep imports — these are not officially exported but the files are
// stable in `avataaars@2.0.0`. They're shipped as CJS with the
// component on `module.exports.default`, and Vite doesn't always
// auto-unwrap the default through deep paths, so we use namespace
// imports and pull `.default` ourselves. If we ever upgrade past v2
// these paths must be re-validated.
import * as ClothesMod from "avataaars/dist/avatar/clothes";
import * as FaceMod from "avataaars/dist/avatar/face";
import * as TopMod from "avataaars/dist/avatar/top";
import * as AccessoriesMod from "avataaars/dist/avatar/top/accessories";
import * as SkinMod from "avataaars/dist/avatar/Skin";

type AnyComp = React.ComponentType<Record<string, unknown>>;
// Vite's CJS interop is unpredictable here: depending on the module
// format flags, a namespace import of these CJS files can produce
// the component directly, OR { default: Component }, OR even a
// double-wrapped { default: { default: Component } }. Walk through
// .default until we hit a function/class.
const unwrap = (m: unknown, label: string): AnyComp => {
  let cur: unknown = m;
  for (let i = 0; i < 4; i++) {
    if (typeof cur === "function") return cur as AnyComp;
    if (cur && typeof cur === "object" && "default" in cur) {
      cur = (cur as { default: unknown }).default;
      continue;
    }
    break;
  }
  // eslint-disable-next-line no-console
  console.error(`[AvataaarsRigged] failed to unwrap ${label}`, m);
  // Render a no-op so the error message is visible but the rest of
  // the page doesn't crash.
  return (() => null) as AnyComp;
};
const Clothes = unwrap(ClothesMod, "Clothes");
const Face = unwrap(FaceMod, "Face");
const Top = unwrap(TopMod, "Top");
const Accessories = unwrap(AccessoriesMod, "Accessories");
const Skin = unwrap(SkinMod, "Skin");

export type AvataaarsRiggedProps = {
  topType?: string;
  accessoriesType?: string;
  hairColor?: string;
  facialHairType?: string;
  facialHairColor?: string;
  clotheType?: string;
  clotheColor?: string;
  graphicType?: string;
  eyeType?: string;
  eyebrowType?: string;
  mouthType?: string;
  skinColor?: string;
  /** Head rotation in degrees, applied to the head <g> only. */
  headRotateDeg?: number;
  className?: string;
  style?: React.CSSProperties;
};

// Rotation pivot in SVG viewBox coordinates. We rotate at the BASE
// of the neck (y=163 in body-local), not the jaw line — this makes
// the head + neck rectangle swing as one rigid piece, like a
// bobblehead, instead of leaving a flat seam at the chin. Body-local
// (100, 163) → viewBox (132, 199) after the (32, 36) body translate.
const PIVOT_X = 132;
const PIVOT_Y = 199;

// HEAD silhouette. Head circle + an OVER-EXTENDED neck rectangle that
// runs all the way down to y=190 — well below the body's top edge at
// y=163. We need this overhang so that under rotation the bottom
// corners of the rotated neck rect stay below y=163 across the full
// width [76, 124]; the static body and clothes cover the overhang
// from below, so the neck always reads as connected.
//
// Path traversal (clockwise from bottom-left of neck overhang):
//   bottom-left → up left neck wall → left jaw curve → left ear
//   notches → top of head → right ear notches → right jaw curve →
//   down right neck wall → close across neck overhang bottom
//   (hidden under the body + clothes).
const HEAD_PATH =
  "M76,190 " +
  "L76,144.610951 " +
  "C58.7626345,136.422372 46.3722246,119.687011 44.3051388,99.8812385 " +
  "C38.4803105,99.0577866 34,94.0521096 34,88 " +
  "L34,74 " +
  "C34,68.0540074 38.3245733,63.1180731 44,62.1659169 " +
  "L44,56 " +
  "C44,25.072054 69.072054,0 100,0 " +
  "C130.927946,0 156,25.072054 156,56 " +
  "L156,62.1659169 " +
  "C161.675427,63.1180731 166,68.0540074 166,74 " +
  "L166,88 " +
  "C166,94.0521096 161.51969,99.0577866 155.694861,99.8812385 " +
  "C153.627775,119.687011 141.237365,136.422372 124,144.610951 " +
  "L124,190 Z";

// BODY silhouette (the U-shaped torso only, top edge at y=163). The
// neck rectangle is intentionally NOT in the body — it lives in the
// head group and rotates with the head. The body's flat top at y=163
// runs from x=72 to x=128, slightly wider than the neck-rect bottom
// (x=76 to x=124), so the body's outline visually extends 4px past
// each neck wall to match the original silhouette's curve corners.
const BODY_PATH =
  "M72,163 " +
  "C32.235498,163 0,195.235498 0,235 " +
  "L0,244 " +
  "L200,244 " +
  "L200,235 " +
  "C200,195.235498 167.764502,163 128,163 " +
  "L72,163 Z";

// Original neck shadow path from `path3`'s sibling — clipped to the
// body mask so it sits inside the body silhouette only.
const NECK_SHADOW_PATH =
  "M156,79 L156,102 C156,132.927946 130.927946,158 100,158 " +
  "C69.072054,158 44,132.927946 44,102 L44,79 L44,94 " +
  "C44,124.927946 69.072054,150 100,150 C130.927946,150 156,124.927946 156,94 L156,79 Z";

type ContextValue = { optionContext: OptionContext };

// Stable suffixes for the per-instance mask ids so multiple avatars
// on one page don't trample each other's defs.
let nextInstanceId = 0;

export default class AvataaarsRigged extends React.Component<AvataaarsRiggedProps> {
  // Legacy React childContext requires a "validator" function per
  // key. We use a no-op so we don't have to take a runtime dep on
  // prop-types just for the type plumbing.
  static childContextTypes = {
    optionContext: () => null,
  };

  private optionContext: OptionContext;
  private uid: string;

  constructor(props: AvataaarsRiggedProps) {
    super(props);
    this.optionContext = new OptionContext(allOptions);
    this.uid = `ld-av-${++nextInstanceId}`;
    this.updateOptionContext(props);
  }

  getChildContext(): ContextValue {
    return { optionContext: this.optionContext };
  }

  componentDidUpdate(prevProps: AvataaarsRiggedProps) {
    // Cheap shallow equality on the option-bearing props. If any
    // changed, push the new values into the OptionContext so the
    // child Clothes/Face/Top re-render with the new variant.
    let dirty = false;
    for (const opt of allOptions) {
      const k = opt.key as keyof AvataaarsRiggedProps;
      if (prevProps[k] !== this.props[k]) {
        dirty = true;
        break;
      }
    }
    if (dirty) this.updateOptionContext(this.props);
  }

  private updateOptionContext(props: AvataaarsRiggedProps) {
    const data: { [key: string]: string } = {};
    for (const option of allOptions) {
      const value = (props as Record<string, unknown>)[option.key];
      if (typeof value === "string" && value) data[option.key] = value;
    }
    this.optionContext.setData(data);
  }

  render() {
    const { className, style, headRotateDeg = 0 } = this.props;
    const headMaskId = `${this.uid}-head-mask`;
    const bodyMaskId = `${this.uid}-body-mask`;
    // Publish this instance's optionContext via the module-level
    // singleton so the patched Selector prototype getter can read it.
    // The patch itself is applied lazily on first render.
    ensureSelectorPatched();
    currentOptionContext = this.optionContext;

    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="264px"
        height="280px"
        viewBox="0 0 264 280"
        version="1.1"
        className={className}
        style={style}
      >
        {(() => {
          const rot = `rotate(${headRotateDeg} ${PIVOT_X} ${PIVOT_Y})`;
          return (
            <>
              {/* ----- 1. BODY skin (static) ----- */}
              <g id="ld-av-body-skin" transform="translate(32, 36)">
                <mask id={bodyMaskId} fill="white">
                  <path d={BODY_PATH} />
                </mask>
                <path d={BODY_PATH} fill="#D0C6AC" />
                <Skin maskID={bodyMaskId} />
                <path
                  d={NECK_SHADOW_PATH}
                  fillOpacity="0.1"
                  fill="#000000"
                  mask={`url(#${bodyMaskId})`}
                />
              </g>

              {/* ----- 2. HEAD skin (rotated) -----
                  Drawn BEFORE the clothes so the over-extended neck
                  rectangle is hidden under the collar/jacket of the
                  clothes layer. Without this layering, the rotating
                  neck would paint over the collar instead of tucking
                  beneath it. */}
              <g id="ld-av-head-skin" transform={rot}>
                <g transform="translate(32, 36)">
                  <mask id={headMaskId} fill="white">
                    <path d={HEAD_PATH} />
                  </mask>
                  <path d={HEAD_PATH} fill="#D0C6AC" />
                  <Skin maskID={headMaskId} />
                </g>
              </g>

              {/* ----- 3. Clothes (static) -----
                  Renders ON TOP of the head skin's neck overhang,
                  hiding it. The collar V-tabs draw their own shape
                  in the neck region, which is exactly what we want. */}
              <Clothes />

              {/* ----- 4. HEAD features (rotated, same transform) -----
                  Face + hair/hat + accessories. These all sit above
                  the clothes in the original z-order. They share the
                  same rotation transform as the head skin so the
                  whole head reads as a single rigid unit. */}
              <g id="ld-av-head-features" transform={rot}>
                <Face />
                <Top>
                  <Accessories />
                </Top>
              </g>
            </>
          );
        })()}
      </svg>
    );
  }
}
