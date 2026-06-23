# Voice/Companion — clean rebuild & layered verification

## Why
Debugging happened top-down on the full hands-free stack while the bottom layer (the
model) was broken, so it never converged. This plan rebuilds **bottom-up**: establish a
clean baseline, verify one layer, add the next, verify again. Each layer has **automated
tests I run** and, only where audio/mic/perception is involved, **one test you run**.

## Principles
- One layer at a time. Do not add layer N+1 until layer N passes.
- Maximize automated tests (pure functions: stripping, chunking, prosody, DSP).
- You only test what can't be automated: does it *sound* right, does hands-free work.
- Keep a single self-test script (`backend/scripts/voice-selftest.ts`) green at every layer.

## Known-good facts (established)
- Model was the real Corey bug: the 3B fast model returned 1–3 word stubs; the 8B (chat
  model) is coherent. Companion now uses `getModel()` (8B). ← keep.
- AudioContext is `running` in hands-free (not suspended). ← not a problem.
- The playback path works (full multi-sentence replies played in clean logs). ← keep.

---

## Phase 0 — Clean baseline
Strip the codebase back to a minimal, coherent voice path. Remove every temporary hack
and diagnostic added during the guessing phase.

**Remove (diagnostics):** all `[VOICE]`, `[COMP-STREAM]`, `[COMPANION-REPLY]`,
`[TTS-PROSODY] text=` logs in: voicePlaybackStore, voice-playback, tts-playback-scheduler,
useCompanionVoice, useCompanionStream, companions.ts, tts.ts.

**Restore to correct (not passthrough/disabled):**
- `emoteParser.stripTags` + `speechText.stripForSpeech`: content-preserving rule —
  `<action>…</action>` DROP, `<i>/<em>/<b>` UNWRAP (keep words), `*…*`/`(…)`/`[…]` DROP.
- `useHandsFree`: barge-in stays code-enabled but hardened (0.16 / 22 frames / 700ms arm);
  it only runs in hands-free, which is OFF until Layer 4.
- `useCompanionVoice`: keep the text-continuation cursor reset (good); restore the
  new-gen `stopSpeech` (needed to cut old audio on a real new turn).

**Keep (real fixes):** 8B companion model; KV-cache contextLine-last; newline soft-wrap;
yt-dlp re-download guard; db/pod log fixes; prosody system code (dormant until Layer 3).

**Baseline config:** voice plain — emote stripping ON (content-preserving), prosody
rate/gain forced neutral (1.0), per-sentence pause = constant, hands-free OFF.

**My tests:** `bun run backend/scripts/voice-selftest.ts` green; `bun build` of touched
backend entries; frontend `tsc -b` clean for touched files.
**Your test:** none yet.

---

## Layer 0 — Model / text reply (no voice)
**Config:** Voice OFF, Hands-free OFF.
**My tests:** companionPrompt builds; system-prompt assembly unit (no tags requested).
**Your test:** type "corey feldman is in the hospital" → **full coherent typed reply**
(not a stub). PASS = full sentence(s).
**If fail:** stays on backend (model/params/router), voice provably out of scope.

---

## Layer 1 — Plain voice (TTS, no hands-free, no prosody)
**Config:** Voice ON, Hands-free OFF, prosody neutral.
**My tests (automated):**
- `stripForSpeech`/`stripEmotes`: content preserved for `<i>`, `<em>`, plain text; tags/
  `<action>`/emoji removed; orphan/streaming partial tags cleaned; **no content deleted**.
- `segmentSentences`: correct sentence splits; soft `\n` joined; paragraph `\n\n` splits.
- `pcm.wavToPcm`: gain=1 is identity; soft-clip never overflows int16.
**Your test:** type a 2–3 sentence message, Voice ON → **entire reply spoken, start to
finish, no cutoff, no tags read aloud.** PASS = whole thing plays.

---

## Layer 2 — Emote/markup correctness
**Config:** as Layer 1.
**My tests (automated):** table of real model shapes →
- `<action>winks</action> hey` → "hey"
- `that's <i>terrible</i>` → "that's terrible"  (content kept)
- `*sigh* ok` → "ok"; `**bold**` → "bold"
- mixed/orphan/streaming partials → clean, never empty when there are real words.
**Your test:** a reply containing an emphasis word → spoken in full, nothing weird printed.

---

## Layer 3 — Prosody (rate / gain / pauses)
**Config:** prosody enabled (`EXPRESSIVENESS` 1.0 backend-scaled by `expressiveness`).
**My tests (automated):**
- `prosodyForChunk`: excited line > 1.1 rate, somber < 0.9, neutral = 1.0 (spread check).
- `refineSentence`: aux-led `?`, trailing `…` pause, clause fragment not terminated.
- `tts.ts` rate math: `finalRate = clamp(base*rateScale, .8, 1.3)`; gain clamps.
**Your test:** excited vs somber replies → audibly faster/brighter vs slower/softer.

---

## Layer 4 — Hands-free (wake / STT / FSM / barge-in)
**Config:** Hands-free ON; barge-in armed (hardened); safety timer dead-reply-only.
**My tests:** build/typecheck; FSM transition table review.
**Your test (the real one):**
1. Greeting → full reply, no cut.
2. Emotional prompt (Corey) → full reply, no cut.
3. Talk over it after ~1s → barge-in interrupts (deliberate), but normal replies are
   never cut by echo.
**If a cut returns here:** it's hands-free-specific (FSM/barge-in/STT echo) — and every
lower layer is already proven, so the search space is tiny.

---

## Rollback / flags
Each layer is a small, self-contained change set. If a layer regresses, revert just that
layer's edits; lower layers stay green. The self-test script is the regression gate.

## Cleanup (final)
Remove the self-test script's temporary scaffolding only if desired (it's cheap to keep),
and delete any remaining debug flags. Re-decide whether to re-introduce `<action>` emotes
(for avatar mood animation) now that the 8B model handles structured output — separate,
optional follow-up.
