import type { ResponseMode } from "./SlashCommandParser";

export type ToggleMode = "auto" | "simple" | "rich";

export const TOGGLE_MODES: readonly ToggleMode[] = [
  "auto",
  "simple",
  "rich",
] as const;

export function toggleModeToOverride(mode: ToggleMode): ResponseMode | null {
  if (mode === "auto") return null;
  if (mode === "simple") return "standard";
  return "rich";
}
