# Voice Prosody Layer for Kokoro TTS

## Goal
Notably improve perceived speech inflection **without adding any model** (no Orpheus/
Chatterbox — no spare VRAM). Squeeze pacing, pausing, and dynamics out of Kokoro by
turning the LLM's roleplay emotes into per-sentence speech parameters.

## Honest ceiling (research)
Kokoro's maintainer + reviewers: it "can simulate labels through speed and punctuation
recipes, but the classifier mostly learns **tempo and pause structure** — delivering
speech really angry or sad is **not in its range**." So this layer controls **rate,
pause, and loudness (DSP gain)** — the levers that genuinely move inflection — but NOT
vocal-cord emotional timbre. That is the real ceiling at zero added resources.

Prior art:
- Kokoro community: punctuation recipes (commas=short pause, ellipses=suspense), short
  sentences=quick pace. Tempo/pause only.
- Companion apps (SillyTavern etc.): asterisk/`<action>` roleplay actions as the emotion
  source — strip them, or map them to engine expression settings.
- DSP without retraining: waveform gain + TD-PSOLA/WORLD pitch/time-stretch.

## KEY ARCHITECTURE CORRECTION (found during impl)
The original plan assumed the **backend** could parse emotes before TTS. **It cannot.**
`frontend/src/hooks/useCompanionVoice.ts` calls `stripEmotes()` on the **frontend**
(line 73/86) before any text reaches `/api/tts/stream`. The backend never sees the
`<action>…</action>` / `*…*` emotes for the companion path.

The LLM's primary emote channel is `<action>laughs softly</action>` XML tags
(`companionPrompt.ts` instructs ONLY this format; `*…*` is a fallback). These are already
parsed on the frontend for the **avatar mood** (`useEmoteMood` → `moods.ts`
`extractEmoteMoods` → `moodStore`).

**Therefore: derive prosody on the FRONTEND, co-located with mood extraction, and
transmit per-chunk `rateScale`/`gain` to the backend.** The backend shrinks to honoring
those two params. Same emote drives face + voice → they stay in sync.

## Data flow
```
useCompanionVoice: rawChunk ──prosodyForChunk()──▶ { rateScale, gain }   (BEFORE stripEmotes)
                          └─stripEmotes()─▶ cleanText
   enqueueSpeech({ text: cleanText, characterId, rateScale, gain })
        └─▶ VoicePlayback.enqueueText → POST /api/tts/stream { text, rateScale, gain, … }
              └─▶ tts.ts: finalRate = clamp(charBase * rateScale, 0.8, 1.3)
                          engine.synthesize(text, { voice, speechRate: finalRate, gain })
                            └─▶ kokoroEngine → wavToPcm(wav, { gain })  // DSP loudness
```
Frontend NDJSON contract unchanged (`SentencePayload` already carries everything).

## Mood → prosody lexicon (Phase 1)
Reuse `moods.ts` `extractEmoteMoods()` → dominant `Mood`, then:

| Mood      | rateScale | gain |
|-----------|-----------|------|
| laugh     | 1.10      | 1.06 |
| happy     | 1.08      | 1.04 |
| surprised | 1.12      | 1.08 |
| wink      | 1.00      | 1.00 |
| love      | 0.97      | 1.00 |
| think     | 0.93      | 0.95 |
| confused  | 0.95      | 0.97 |
| sick      | 0.88      | 0.85 |
| tired     | 0.86      | 0.85 |
| sad       | 0.85      | 0.82 |
| angry     | 1.06      | 1.08 |
| neutral   | 1.00      | 1.00 |

Scaled by an `EXPRESSIVENESS` factor (Phase 1: module constant ~0.85;
Phase 4: per-character DB column). `scaled = 1 + (raw - 1) * EXPRESSIVENESS`.
Clamp `rateScale ∈ [0.8, 1.25]`, `gain ∈ [0.5, 1.15]`.

## Files (Phase 1)
- NEW `frontend/src/lib/voice/prosody.ts` — lexicon + `prosodyForChunk(raw)`.
- EDIT `frontend/src/hooks/useCompanionVoice.ts` — prosody from raw chunk → enqueueSpeech.
- EDIT `frontend/src/lib/voice/voice-playback.ts` — `VoicePlaybackOptions` + body get
  `rateScale`/`gain`.
- EDIT `backend/src/routes/tts.ts` — `finalRate = clamp(base * rateScale)`, accept `gain`.
- EDIT `backend/src/lib/voice/types.ts` — `SynthOptions.gain?`.
- EDIT `backend/src/lib/voice/engines/kokoroEngine.ts` — pass `gain` to `wavToPcm`.
- EDIT `backend/src/lib/voice/pcm.ts` — `wavToPcm(buf, { gain })`, gain pre-quantization
  with hard clamp (soft limiter = later refinement).

Backward compat: `rateScale`/`gain` default `1.0` → admin preview / `speak()` unaffected.

## Later phases
2. DONE — `prosodyText.ts` `refineSentence()`: terminal punctuation, statement→`?` on
   auxiliary-led questions, `...`→`…`, per-sentence `pausePost`. Wired in `tts.ts`.
3. DONE — soft-knee tanh limiter `softClip()` in `pcm.ts` (knee 0.85×PEAK).
4. DONE — `characters.expressiveness` (0–1, null→default 0.6) DB column + Admin slider
   in `AdminCompanionsTab.tsx`; backend scales the frontend deviation per character.
   NOT done: mood→voice swap within allowed voices.
5. DEFERRED: pitch contour via TD-PSOLA (rising questions) — real but artifact-prone.

## Validation
- `prosodyForChunk("<action>sighs</action> I guess so.")` → rateScale≈0.86, gain≈0.85.
- `prosodyForChunk("<action>laughs</action> No way!")` → rateScale≈1.10.
- `bun build` backend (the project bar, not tsc). A/B listen old vs new path.

## Risks
- Timbre ceiling: still Kokoro, no true anger/sadness in voice.
- Gain on int16 post-quantization adds faint noise <~0.5×; keep gain ≥0.5.
- Latency: CPU regex + one array multiply/sentence — microseconds, no TTFB hit.
