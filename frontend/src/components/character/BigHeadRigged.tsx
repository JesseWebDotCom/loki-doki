/**
 * BigHeadRigged — a fork of @bigheads/core's <Avatar> that splits the
 * character into a static BODY group and a rigid HEAD group, so the
 * head can rotate around the neck pivot without any pixel-mask trickery.
 *
 * Why this exists: DiceBear's avataaars ships its skin (head + neck +
 * chest) as a single monolithic <path>, which makes a true rigged head
 * rotation impossible without modifying the source assets. @bigheads/core
 * is a React component library where every part is its own JSX element,
 * so we can re-compose them into two groups instead of one.
 *
 * The composition order below mirrors the original Base component
 * (node_modules/@bigheads/core/dist/core.esm.js, ~L417). The static
 * skin paths for the shoulders and neck are inlined verbatim from
 * Base because that file's Mask/BgCircle/internal helpers are not
 * exported. If @bigheads/core ever bumps and changes those paths,
 * regenerate them by re-reading Base.
 *
 * Pivot: the head circle's bottom sits at ~y=766 in the 1000x990 viewBox;
 * the neck rect starts at y=772. We rotate around (500, 758) — splitting
 * the difference so the chin barely moves and the seam stays tight at
 * the small angles we use (±8°).
 */
import React from "react";
import {
  ThemeContext,
  theme,
  eyesMap,
  eyebrowsMap,
  mouthsMap,
  hairMap,
  facialHairMap,
  clothingMap,
  accessoryMap,
  graphicsMap,
  hatMap,
  bodyMap,
  Noop,
} from "@bigheads/core";

const { colors } = theme;

export type BigHeadProps = {
  skinTone?: keyof typeof colors.skin;
  eyes?: keyof typeof eyesMap;
  eyebrows?: keyof typeof eyebrowsMap;
  mouth?: keyof typeof mouthsMap;
  hair?: keyof typeof hairMap;
  facialHair?: keyof typeof facialHairMap;
  clothing?: keyof typeof clothingMap;
  accessory?: keyof typeof accessoryMap;
  graphic?: keyof typeof graphicsMap;
  hat?: keyof typeof hatMap;
  body?: keyof typeof bodyMap;
  hairColor?: keyof typeof colors.hair;
  clothingColor?: keyof typeof colors.clothing;
  lipColor?: keyof typeof colors.lipColors;
  hatColor?: keyof typeof colors.clothing;
  lashes?: boolean;
  /** Head rotation in degrees, applied to the head <g> only. */
  headRotateDeg?: number;
  className?: string;
  style?: React.CSSProperties;
};

const PIVOT_X = 500;
const PIVOT_Y = 758;

const BigHeadRigged: React.FC<BigHeadProps> = ({
  skinTone = "light",
  eyes = "normal",
  eyebrows = "raised",
  mouth = "grin",
  hair = "short",
  facialHair = "none",
  clothing = "shirt",
  accessory = "none",
  graphic = "none",
  hat = "none",
  body = "chest",
  hairColor = "brown",
  clothingColor = "blue",
  lipColor = "red",
  hatColor = "blue",
  lashes = false,
  headRotateDeg = 0,
  className,
  style,
}) => {
  const skin = colors.skin[skinTone];
  const Eyes = eyesMap[eyes];
  const Eyebrows = eyebrowsMap[eyebrows];
  const Mouth = mouthsMap[mouth];
  const Hair = hairMap[hair];
  const FacialHair = facialHairMap[facialHair];
  const Clothing = clothingMap[clothing];
  const Accessory = accessoryMap[accessory];
  const Graphic = graphicsMap[graphic];
  const Hat = hatMap[hat];
  const Body = bodyMap[body];

  const FrontHair = Hair.Front;
  const BackHair = Hair.Back;
  const FrontHat = Hat.Front;
  const BackHat = Hat.Back;
  const FrontBody = Body.Front;
  const BackBody = Body.Back;
  const ClothingFront = Clothing.Front;
  const ClothingBack = Clothing.Back;

  return (
    <ThemeContext.Provider value={{ colors, skin }}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 1000 990"
        className={className}
        style={{ overflow: "hidden", display: "block", ...style }}
      >
        {/* ---------- BODY (static) ---------- */}
        {/* z-order matches the original Base: shoulders + neck +
            back-body + back-clothing + front-body + front-clothing.
            All static. */}
        <g className="ld-bh-body">
          {/* Right shoulder skin bump */}
          <path
            d="M610,758.72c90.76,0,72,114.24,72.87,241.28H610Z"
            fill={skin.base}
          />
          <path
            d="M632.74,831.87,610,870l11.38,130h31.76C653.91,819.73,632.74,831.87,632.74,831.87Z"
            fill={skin.shadow}
          />
          {/* Left shoulder skin bump */}
          <path
            d="M386.12,758.72c-90.77,0-72,114.24-72.87,241.28h72.87Z"
            fill={skin.base}
          />
          <path
            d="M367.23,831.87,390,870l-11.39,130H346.88C346.07,819.73,367.23,831.87,367.23,831.87Z"
            fill={skin.shadow}
          />
          {/* Neck/torso rectangle (the rect that holds the body shape) */}
          <path
            d="M619.47,1070H380.53a13.28,13.28,0,0,1-13.27-13.28V772a13.28,13.28,0,0,1,13.27-13.28H613.76c13.09,0,19,7.66,19,19.88v278.08A13.28,13.28,0,0,1,619.47,1070Z"
            fill={skin.base}
          />
          <path
            d="M629.05,766.62a19.33,19.33,0,0,1-2.51-4,17.25,17.25,0,0,0-8.28-3.51,28.88,28.88,0,0,0-4.5-.34H380.53A13.28,13.28,0,0,0,367.26,772c29,10.42,83.29,16.24,132.74,16.24C563.06,788.24,604.38,778.89,629.05,766.62Z"
            fill={skin.shadow}
          />
          <path
            d="M610,758.72c90.76,0,72,114.24,72.87,241.28H632.74"
            fill="none"
            stroke={colors.outline}
            strokeLinecap="square"
            strokeMiterlimit={10}
            strokeWidth="12px"
          />
          <path
            d="M386.12,758.72c-90.77,0-72,114.24-72.87,241.28h50.07"
            fill="none"
            stroke={colors.outline}
            strokeLinecap="square"
            strokeMiterlimit={10}
            strokeWidth="12px"
          />
          <path
            d="M380.53,758.82l233.23-.1"
            fill="none"
            stroke={colors.outline}
            strokeMiterlimit={10}
            strokeWidth="12px"
          />
          {/* Body shadow inside the neck rect */}
          <path
            d="M380.53,1070H497.15C388,1070,396.24,838.82,367.26,838.82v217.86A13.28,13.28,0,0,0,380.53,1070Z"
            fill={skin.shadow}
          />
          {/* Adam's apple */}
          <path
            d="M361.26,860.85c-.19-3.67-.11-7.34.05-11s.47-7.35.86-11c.2-1.84.4-3.67.65-5.51s.49-3.67.85-5.51a44.18,44.18,0,0,1,3.59-11,44.18,44.18,0,0,1,3.59,11c.36,1.84.62,3.67.85,5.51s.45,3.67.65,5.51c.38,3.67.68,7.34.85,11s.25,7.34.06,11Z"
            fill={colors.outline}
          />
          {/* Body rect outline */}
          <path
            d="M632.74,870v8c.26,34,.26,69,0,102.75,0,2.87,0,5.72,0,8.53v67.41A13.28,13.28,0,0,1,619.47,1070H380.53a13.28,13.28,0,0,1-13.27-13.28V998.52c0-2.51,0-5.07,0-7.65-.25-34.87-.25-69.87,0-105.3V860.85"
            fill="none"
            stroke={colors.outline}
            strokeMiterlimit={10}
            strokeWidth="12px"
          />
          <path
            d="M626.74,870c-.19-4.17-.1-8.35.06-12.53s.47-8.35.85-12.53c.2-2.09.41-4.18.65-6.27s.49-4.17.85-6.26a55.09,55.09,0,0,1,3.59-12.53,55.09,55.09,0,0,1,3.59,12.53c.36,2.09.62,4.18.85,6.26s.45,4.18.65,6.27c.38,4.18.69,8.35.85,12.53s.25,8.36.06,12.53Z"
            fill={colors.outline}
          />
          <BackBody clothingColor={clothingColor} braStraps={true} />
          <ClothingBack color={clothingColor} graphic={Graphic} />
          {!(ClothingFront === Noop && ClothingBack === Noop) && (
            <FrontBody clothingColor={clothingColor} braStraps={true} />
          )}
          <ClothingFront color={clothingColor} graphic={Graphic} />
        </g>

        {/* ---------- HEAD (rotated) ---------- */}
        {/* Everything from the back-hat up through accessories rotates
            as one rigid unit around (PIVOT_X, PIVOT_Y). */}
        <g
          className="ld-bh-head"
          style={{
            transform: `rotate(${headRotateDeg}deg)`,
            transformOrigin: `${PIVOT_X}px ${PIVOT_Y}px`,
            transformBox: "view-box",
          }}
        >
          <BackHat scale={1} />
          <BackHair hairColor={hairColor} hasHat={FrontHat !== Noop} />
          {/* Head circle skin */}
          <path
            d="M233.25,500c0-147.32,119.43-266.75,266.75-266.75S766.75,352.68,766.75,500A266.22,266.22,0,0,1,668.1,707.12q-8.21,6.68-16.94,12.69C591,758,515,758,446.39,751.89c-6.66-1-13.3-2.26-19.89-3.71-26.33-5.8-51.82-14.75-75.37-27.8Q342.4,715,334.2,708.76a199.59,199.59,0,0,1-15.8-13.38q-7.14-6.63-13.79-13.78A265.86,265.86,0,0,1,233.25,500Z"
            fill={skin.base}
          />
          {/* Head shadow (the long swept fill on the left side) */}
          <path
            d="M269.61,634.48c.7,1.2,1.39,2.4,2.11,3.58.43.72.88,1.42,1.33,2.14.66,1.07,1.32,2.14,2,3.19.48.76,1,1.5,1.46,2.24.66,1,1.32,2,2,3,.51.76,1,1.52,1.56,2.28.66,1,1.32,1.92,2,2.88.54.77,1.1,1.53,1.65,2.3s1.34,1.85,2,2.77,1.15,1.53,1.73,2.29,1.37,1.8,2.07,2.7,1.19,1.51,1.79,2.26,1.41,1.76,2.12,2.63,1.23,1.49,1.85,2.23,1.44,1.72,2.17,2.57,1.27,1.47,1.91,2.2l2.22,2.5c.65.73,1.31,1.44,2,2.16.86.94,1.73,1.87,2.6,2.79l1.21,1.28c1.29,1.34,2.59,2.68,3.91,4l.26.27c1.29,1.28,2.6,2.55,3.91,3.81l1.58,1.5c.95.89,1.9,1.78,2.86,2.66l1.16,1.06c1,.94,2.09,1.86,3.14,2.78q4.9,4.27,10,8.19,8.19,6.24,16.93,11.62c23.55,13,49,22,75.37,27.8,6.59,1.45,13.23,2.7,19.89,3.71,42.1,3.75,87,5.18,129.28-3.08C508.45,729,185.59,612.74,388.8,257.48Z"
            fill={skin.shadow}
          />
          {/* Head outline */}
          <path
            d="M233.25,500c0-147.32,119.43-266.75,266.75-266.75S766.75,352.68,766.75,500A266.22,266.22,0,0,1,668.1,707.12q-8.21,6.68-16.94,12.69C591,758,515,758,446.39,751.89c-6.66-1-13.3-2.26-19.89-3.71-26.33-5.8-51.82-14.75-75.37-27.8Q342.4,715,334.2,708.76a199.59,199.59,0,0,1-15.8-13.38q-7.14-6.63-13.79-13.78A265.86,265.86,0,0,1,233.25,500Z"
            fill="none"
            stroke={colors.outline}
            strokeMiterlimit={10}
            strokeWidth="12px"
          />
          <FacialHair color={hairColor} />
          <Eyes withLashes={lashes} />
          <Mouth lipColor={lipColor} />
          <FrontHair hairColor={hairColor} hasHat={FrontHat !== Noop} />
          <Eyebrows />
          <FrontHat color={hatColor} scale={1} />
          <Accessory />
        </g>
      </svg>
    </ThemeContext.Provider>
  );
};

export default BigHeadRigged;
