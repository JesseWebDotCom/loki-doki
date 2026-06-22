import { useEffect, useRef } from "react";
import { extractEmoteMoods } from "@/components/companion/moods";
import { setMood, resetMood } from "@/lib/voice/moodStore";

// Watches the streaming assistant reply for *…* / (…) emotes and drives the mood
// store (rate-limited there). Runs regardless of whether voice is on — the
// emotion overlay is a visual. Fires as the text streams in (roughly aligned
// with the spoken audio, which lags slightly), then lets the mood decay.

export function useEmoteMood(opts: { text: string; streaming: boolean }) {
  const { text, streaming } = opts;
  const consumed = useRef(0);
  const prevStreaming = useRef(false);

  useEffect(() => {
    if (streaming && !prevStreaming.current) {
      consumed.current = 0;
      resetMood();
    }
    prevStreaming.current = streaming;
  }, [streaming]);

  useEffect(() => {
    const pending = text.slice(consumed.current);
    if (!pending) return;
    const { moods, lastEnd } = extractEmoteMoods(pending);
    for (const m of moods) setMood(m);
    if (lastEnd > 0) consumed.current += lastEnd;
  }, [text]);
}
