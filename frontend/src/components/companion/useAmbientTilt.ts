import { useEffect, useMemo, useRef, useState } from "react";
import type { HeadTiltState } from "./useHeadTilt";

// Ambient "alive" behaviour for avatars shown as static previews (e.g. the
// companion store grid). Each avatar gets a stable resting pose derived from its
// seed so a wall of them never looks identical, and very occasionally one perks
// up with a brief, characterful emote before settling back.

// Calm at-rest poses — mostly gentle idle sway, some sleepy dozing, the odd
// curious head-turn. No negative/emotional states at rest.
const RESTING: HeadTiltState[] = ["idle", "idle", "idle", "dozing", "dozing", "thinking"];

// Brief "engaged" emotes only — reads as lively/curious, never as something
// wrong with the character. (Avoids sad/angry/sick in a browsing context.)
const EMOTES: HeadTiltState[] = ["shocked", "thinking", "listening"];

const EMOTE_MS = 2200;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Module-level cap: at most one preview avatar emotes at a time, so a dense grid
// never turns into a fidget-fest. Avatars that want to emote while the slot is
// taken simply stay at rest and try again later.
let activeEmotes = 0;
const MAX_CONCURRENT_EMOTES = 1;
function acquireEmote(): boolean {
  if (activeEmotes >= MAX_CONCURRENT_EMOTES) return false;
  activeEmotes++;
  return true;
}
function releaseEmote(): void {
  activeEmotes = Math.max(0, activeEmotes - 1);
}

export function useAmbientTilt(seed: string, enabled: boolean): HeadTiltState {
  const resting = useMemo(() => RESTING[hash(seed) % RESTING.length]!, [seed]);
  const [state, setState] = useState<HeadTiltState>(resting);
  const holdingRef = useRef(false);

  useEffect(() => {
    setState(resting);
    if (!enabled) return;

    let cancelled = false;
    let timer: number;

    const loop = () => {
      // Seed-jittered idle stretch (~9–21s) so cards never sync their attempts.
      const wait = 9000 + (hash(seed) % 6000) + Math.random() * 6000;
      timer = window.setTimeout(() => {
        if (cancelled) return;
        if (acquireEmote()) {
          holdingRef.current = true;
          setState(EMOTES[Math.floor(Math.random() * EMOTES.length)]!);
          timer = window.setTimeout(() => {
            releaseEmote();
            holdingRef.current = false;
            if (cancelled) return;
            setState(resting);
            loop();
          }, EMOTE_MS);
        } else {
          loop(); // slot busy — stay at rest and try again later
        }
      }, wait);
    };
    loop();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (holdingRef.current) {
        releaseEmote();
        holdingRef.current = false;
      }
    };
  }, [seed, enabled, resting]);

  return state;
}
