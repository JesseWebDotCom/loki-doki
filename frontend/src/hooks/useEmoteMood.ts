import { useEffect, useRef } from "react";
import { extractEmoteMoods, moodForSentence } from "@/components/companion/moods";
import { setMood, resetMood } from "@/lib/voice/moodStore";

// Watches the streaming assistant reply and drives the mood store (rate-limited
// there). Runs regardless of whether voice is on — the emotion overlay is a
// visual. Fires as the text streams in (roughly aligned with the spoken audio,
// which lags slightly), then lets the mood decay.
//
// Two signals, in priority order:
//   1. <action>…</action> / *action* emote tags — when a model emits them.
//   2. Plain-sentence sentiment (moodForSentence) on each COMPLETED sentence —
//      the primary path in practice, since VOICE_RULE bans emote tags and
//      compliant models never emit them (the tag-only design left the avatar's
//      emotion faces unreachable).

const SENTENCE_END_RE = /[.!?](?=\s|$)/g;

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

    // 1) Emote tags (models that emit them despite the voice rule).
    const { moods, lastEnd } = extractEmoteMoods(pending);
    for (const m of moods) setMood(m);

    // 2) Sentence sentiment over COMPLETED sentences only, so a mood never fires
    // twice for the same span and partial sentences wait for their terminator.
    let sentenceEnd = 0;
    SENTENCE_END_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let searchFrom = 0;
    while ((match = SENTENCE_END_RE.exec(pending)) !== null) {
      const end = match.index + match[0].length;
      const sentence = pending.slice(searchFrom, end);
      if (moods.length === 0) {
        const mood = moodForSentence(sentence);
        if (mood) setMood(mood);
      }
      searchFrom = end;
      sentenceEnd = end;
    }

    const advance = Math.max(lastEnd, sentenceEnd);
    if (advance > 0) consumed.current += advance;
  }, [text]);
}
