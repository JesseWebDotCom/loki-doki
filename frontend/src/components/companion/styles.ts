export const CHARACTER_STYLES = ["avataaars", "bottts", "toon-head"] as const;

export type CharacterStyle = (typeof CHARACTER_STYLES)[number];

export function isCharacterStyle(value: unknown): value is CharacterStyle {
  return typeof value === "string" && (CHARACTER_STYLES as readonly string[]).includes(value);
}

export function coerceStyle(value: unknown): CharacterStyle {
  return isCharacterStyle(value) ? value : "avataaars";
}

// Non-DiceBear style ids live OUTSIDE CHARACTER_STYLES so the DiceBear machinery
// (STYLE_MAP / visemeMap / faceForState / splitDicebearSvg) never sees them:
// CharacterAvatar branches to the dedicated renderer before coerceStyle runs.
export const ROBO_EYES_STYLE = "robo-eyes";
