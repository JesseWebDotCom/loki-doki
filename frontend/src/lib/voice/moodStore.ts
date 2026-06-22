import { useEffect, useState } from "react";
import type { Mood } from "@/components/companion/moods";

// Current emote mood + rate-limited setter. Module pub/sub (companionState
// pattern). Subtlety controls: a new mood is held for at least HOLD_MS before
// another can replace it (no twitchy flicker when the LLM over-emotes), and the
// mood decays back to 'neutral' after DECAY_MS of no new emote.

const HOLD_MS = 2500;
const DECAY_MS = 3500;

let mood: Mood = "neutral";
let lastSetAt = -Infinity;
let decayTimer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();
const notify = () => subs.forEach((fn) => fn());

function armDecay() {
  if (decayTimer) clearTimeout(decayTimer);
  decayTimer = mood === "neutral" ? null : setTimeout(() => {
    mood = "neutral";
    notify();
  }, DECAY_MS);
}

export function setMood(next: Mood): void {
  const now = performance.now();
  if (next === mood) {
    armDecay(); // refresh the hold on a repeat of the same emote
    return;
  }
  // Rate-limit: keep the current mood for HOLD_MS before switching (neutral
  // decay is exempt so it can always settle).
  if (next !== "neutral" && now - lastSetAt < HOLD_MS) return;
  mood = next;
  lastSetAt = now;
  armDecay();
  notify();
}

export function resetMood(): void {
  mood = "neutral";
  lastSetAt = -Infinity;
  if (decayTimer) {
    clearTimeout(decayTimer);
    decayTimer = null;
  }
  notify();
}

export function useMood(): Mood {
  const [, force] = useState(0);
  useEffect(() => {
    const sub = () => force((n) => n + 1);
    subs.add(sub);
    return () => {
      subs.delete(sub);
    };
  }, []);
  return mood;
}
