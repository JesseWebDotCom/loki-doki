/**
 * One-shot route TTS readout hook.
 *
 * The Directions panel exposes a "Read directions" button. Pressing it
 * joins the route's `instructions_text` lines with " · " and pipes the
 * result through v3's voice playback singleton — the same one that powers
 * chat read-aloud — so we never spin up a parallel TTS pipeline. Pressing
 * it again while still speaking stops playback.
 */
import { useCallback } from "react";

import { speak, stopSpeech, useVoicePlaying } from "@/lib/voice/voicePlaybackStore";

const JOIN = " · ";

export function joinInstructions(lines: readonly string[]): string {
  return lines
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(JOIN);
}

export interface UseRouteReadoutResult {
  speaking: boolean;
  speak: () => Promise<void>;
  stop: () => void;
}

export function useRouteReadout(
  instructions: readonly string[],
): UseRouteReadoutResult {
  const speaking = useVoicePlaying();
  const text = joinInstructions(instructions);

  const doSpeak = useCallback(async () => {
    if (!text) return;
    if (speaking) {
      stopSpeech();
      return;
    }
    await speak({ text });
  }, [text, speaking]);

  return { speaking, speak: doSpeak, stop: stopSpeech };
}
