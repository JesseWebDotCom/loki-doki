/**
 * characterMode — tiny pub/sub store for the character display mode.
 *
 * The mode is selected in two places (the hover toolbar on the avatar
 * itself AND the Settings → Character section), and consumed in a
 * third (ChatPage's render layout). A module-level store with a React
 * hook keeps all three in lockstep within the same tab — `storage`
 * events only fire across tabs, so we can't rely on them here.
 *
 * Persistence is to localStorage so the user's pick survives reloads.
 */
import { useEffect, useState } from "react";

export type CharacterMode = "mini" | "docked" | "fullscreen";

const STORAGE_KEY = "lokidoki.character.mode";

function readInitial(): CharacterMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "mini" || v === "docked") return v;
    // We never start in fullscreen mode automatically — it requires
    // a user gesture and can feel like a "stuck" UI if browser blocks
    // the actual fullscreen request.
    if (v === "fullscreen") return "docked";
  } catch {
    /* localStorage unavailable */
  }
  return "docked";
}

let current: CharacterMode = readInitial();
const listeners = new Set<(m: CharacterMode) => void>();

export function getCharacterMode(): CharacterMode {
  return current;
}

export function setCharacterMode(mode: CharacterMode): void {
  if (mode === current) return;
  current = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn(mode));
}

/** Subscribe to mode changes. Returns an unsubscribe fn. */
export function subscribeCharacterMode(fn: (m: CharacterMode) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React hook — re-renders the consumer whenever the mode changes. */
export function useCharacterMode(): [CharacterMode, (m: CharacterMode) => void] {
  const [mode, setMode] = useState<CharacterMode>(current);
  useEffect(() => subscribeCharacterMode(setMode), []);
  return [mode, setCharacterMode];
}
