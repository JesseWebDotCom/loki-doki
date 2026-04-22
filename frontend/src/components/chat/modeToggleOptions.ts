import type { ResponseMode } from "./SlashCommandParser";

export type ToggleMode = "auto" | "rich" | "deep" | "search";

export const TOGGLE_MODES: readonly ToggleMode[] = [
  "auto",
  "rich",
  "deep",
  "search",
] as const;

export function toggleModeToOverride(mode: ToggleMode): ResponseMode | null {
  if (mode === "auto") return null;
  return mode;
}
