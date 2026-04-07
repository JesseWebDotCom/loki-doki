/**
 * Single source of truth for the project icon palette + icon whitelist.
 *
 * Colors are CSS-var tokens defined in `index.css` (`--ld-swatch-N`),
 * NOT raw hex. Storage saves the token name (e.g. `"swatch-3"`), so a
 * theme switch automatically retints existing projects.
 */
import * as LucideIcons from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type SwatchToken =
  | "swatch-1" | "swatch-2" | "swatch-3" | "swatch-4"
  | "swatch-5" | "swatch-6" | "swatch-7" | "swatch-8"
  | "swatch-9" | "swatch-10" | "swatch-11" | "swatch-12";

export const SWATCH_TOKENS: SwatchToken[] = [
  "swatch-1", "swatch-2", "swatch-3", "swatch-4",
  "swatch-5", "swatch-6", "swatch-7", "swatch-8",
  "swatch-9", "swatch-10", "swatch-11", "swatch-12",
];

export const DEFAULT_SWATCH: SwatchToken = "swatch-1";
export const DEFAULT_ICON = "Folder";

/** Resolve a swatch token to a CSS color expression. */
export function swatchVar(token: string | undefined | null): string {
  const t = (token || DEFAULT_SWATCH).replace(/^swatch-/, "swatch-");
  return `var(--ld-${t})`;
}

/** Lucide icon names allowed in the picker. Curated to keep the grid sane. */
export const PROJECT_ICONS = [
  "Folder", "Briefcase", "Book", "BookOpen", "Code", "Code2", "Terminal",
  "MessageSquare", "Laptop", "Globe", "Cpu", "Database", "Cloud", "FileText",
  "Image", "Video", "Music", "Headphones", "Settings", "User", "Users",
  "Lock", "Key", "Hammer", "PenTool", "Hash", "Lightbulb", "Zap", "Rocket",
  "Star", "Heart", "Flag", "Bookmark", "Coffee", "Compass", "Map", "Target",
  "Trophy", "Gamepad2", "Camera", "Mic", "Brain", "Sparkles", "Beaker",
] as const;

export type ProjectIconName = (typeof PROJECT_ICONS)[number];

/** Look up a Lucide component by name with a Folder fallback. */
export function getIconComponent(name: string | undefined | null): LucideIcon {
  const Icons = LucideIcons as unknown as Record<string, LucideIcon>;
  return (name && Icons[name]) || Icons.Folder;
}
