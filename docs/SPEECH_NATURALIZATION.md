# Speech Naturalization Plan

## Problem
LokiDoki's TTS pipeline passes raw text to Piper with no preprocessing beyond markdown stripping. This causes:
- URLs read character-by-character ("h t t p s colon slash slash...")
- Numbers read as digit sequences or ambiguously ("42" vs "forty-two")
- Dates read unnaturally ("04/09/2026" instead of "April ninth, twenty twenty-six")
- Abbreviations read literally ("Dr." as "dee arr")
- Symbols read as names or skipped ("&", "%", "@")
- Flat pacing with no pauses between thoughts or emphasis on key words
- Monotone delivery regardless of emotional or conversational context

## Architecture
Two layers, both running before Piper synthesis:

```
Assistant text
  → stripMarkdownForSpeech()  (existing, frontend)
  → TextNormalizer              (new, backend)
  → ProsodyPlanner              (new, backend)
  → Piper synthesize()          (existing, backend)
  → VoiceStreamer playback      (existing, frontend)
```

All new work lives in the backend Python layer so the frontend stays unchanged.

## Phase S1: Text Normalization

### Goal
Convert written text into speakable text so Piper pronounces everything correctly.

### Approach
Compose a lightweight pipeline from small pure-Python libraries rather than a single heavyweight framework. This keeps the dependency footprint small and avoids architecture-incompatible native extensions (NeMo/Pynini don't run on Pi 5 ARM).

### Dependencies
- `num2words` (pure Python, 163 KB, actively maintained) — number/currency/ordinal conversion
- No other external dependencies needed — dates, abbreviations, symbols are small custom code

### Deliverables

#### Number normalization
- Cardinals: "42" → "forty-two"
- Ordinals: "1st" → "first", "3rd" → "third"
- Currency: "$3.50" → "three dollars and fifty cents"
- Percentages: "85%" → "eighty-five percent"
- Large numbers: "1,000,000" → "one million"
- Phone-style: preserve digit-by-digit for phone numbers ("555-1234" → "five five five, one two three four")
- Years: "2026" → "twenty twenty-six" (when in date context)

#### Date and time normalization
- Dates: "04/09/2026" → "April ninth, twenty twenty-six"
- Relative dates: pass through ("today", "tomorrow", "last week")
- Times: "3:30 PM" → "three thirty PM"
- Ranges: "9-5" in time context → "nine to five"
- ISO dates: "2026-04-09" → "April ninth, twenty twenty-six"

#### URL and link handling
- Full URLs: strip entirely or replace with "link" (the link text was already preserved by `stripMarkdownForSpeech`)
- Email addresses: "user@example.com" → "user at example dot com"
- File paths: skip or simplify

#### Abbreviation expansion
- Titles: "Dr." → "Doctor", "Mr." → "Mister", "Mrs." → "Missus"
- Common: "etc." → "et cetera", "vs" → "versus", "approx." → "approximately"
- Units: "km" → "kilometers", "lbs" → "pounds", "oz" → "ounces"
- Maintain a compact dictionary — not an exhaustive list, just the ones Piper actually mispronounces

#### Symbol handling
- "&" → "and"
- "%" → "percent" (handled with number normalization)
- "@" → "at"
- "#" → "number" or "hashtag" depending on context
- "+" → "plus"
- "=" → "equals"
- Citation markers: already stripped by `stripMarkdownForSpeech` (`[src:N]`)

#### Content filtering
- Strip residual markdown artifacts the frontend regex missed
- Strip emoji (Piper produces silence or garbage for emoji)
- Collapse excessive punctuation ("!!!" → "!")
- Strip parenthetical URLs that leaked through

### Implementation
- New file: `lokidoki/core/text_normalizer.py`
- Single entry point: `normalize_for_speech(text: str) -> str`
- Called from `synthesize_stream()` in `audio.py` before passing text to Piper
- Processing order: content filtering → URLs → abbreviations → dates → numbers → symbols → final cleanup
- Each stage is a pure function, individually testable

### Tests
- Unit tests for each normalization category with edge cases
- Round-trip test: markdown text → `stripMarkdownForSpeech` → `normalize_for_speech` → verify speakable output
- Regression test: plain conversational text passes through unchanged
- Performance test: normalization adds < 5ms per turn on Pi 5

## Phase S2: Prosody Control

### Goal
Make spoken responses sound more natural through pacing, pauses, and rate variation.

### Approach
Piper exposes two key synthesis parameters that are currently hardcoded to defaults:
- `sentence_silence` — seconds of silence inserted between sentences
- `length_scale` — phoneme duration multiplier (lower = faster, higher = slower)

These are per-synthesis-call parameters. By splitting text into segments and synthesizing each with different parameters, we get prosody variation without needing SSML or a different TTS engine.

### Deliverables

#### Sentence-level silence control
- Default inter-sentence pause: ~0.4s (Piper default is ~0.2s, slightly too fast for conversational feel)
- Longer pause after questions: ~0.6s
- Longer pause before a new topic or paragraph break: ~0.7s
- Short pause after commas/semicolons within a sentence: handled by Piper natively (no change needed)

#### Speaking rate variation
- Default `length_scale`: use voice config default (1.0 for lessac-medium)
- Slightly slower for emphasis phrases or key answers: 1.1
- Slightly faster for parenthetical/aside content: 0.9
- No extreme variation — keep range between 0.85-1.15 to avoid uncanny distortion

#### Segment-based synthesis
- Split response into segments: sentences, paragraph breaks, list items
- Assign each segment a `length_scale` and `post_silence` value
- Synthesize segments individually through Piper
- Stream PCM chunks with silence buffers injected between segments
- Frontend `VoiceStreamer` already handles sequential chunk playback — no frontend changes needed

#### Prosody assignment rules
- First sentence of a response: default rate (1.0)
- Direct answer to a question: slightly slower (1.05) for clarity
- List items: consistent moderate pace (1.0), uniform pause between items (0.3s)
- Emotional/empathetic content: slightly slower (1.05-1.1)
- Filler/transition phrases ("also", "by the way", "oh and"): slightly faster (0.95)
- Paragraph breaks: insert 0.5s silence
- End of response: no trailing silence (playback just stops)

### Implementation
- New file: `lokidoki/core/prosody_planner.py`
- Data structure: `SpeechSegment(text, length_scale, post_silence_s)`
- Entry point: `plan_prosody(text: str) -> list[SpeechSegment]`
- Modify `synthesize_stream()` to accept and apply per-segment Piper parameters
- Reuse existing `SentenceBuffer` class (currently unused) for segmentation
- Prosody rules are deterministic — no LLM call, no added latency beyond segment iteration

### Tests
- Unit tests for segment splitting and parameter assignment
- Unit tests for silence buffer generation (correct sample count at given sample rate)
- Integration test: multi-sentence response produces multiple segments with varied parameters
- Latency test: per-segment synthesis is not materially slower than single-call synthesis
- Regression test: single-sentence responses still work identically

## Phase S3: Expose Configuration

### Goal
Let users tune speech behavior through existing settings infrastructure.

### Deliverables
- New settings fields in `AudioConfig`:
  - `speech_rate`: float (0.8-1.3), maps to base `length_scale`, default 1.0
  - `sentence_pause`: float (0.1-1.0s), default 0.4
  - `normalize_text`: bool, default true
- Settings API (`PUT /api/v1/settings`) already handles arbitrary fields — just extend `AudioConfig`
- Frontend settings panel: add sliders for speech rate and pause duration under existing audio settings

### Tests
- Unit test: config values propagate to synthesis parameters
- Integration test: changed settings affect actual audio output parameters
- Regression test: default config produces identical output to pre-change behavior

## Dependency Summary

| Library | Purpose | Size | Pi 5 compatible | Maintained |
|---|---|---|---|---|
| `num2words` | Number/currency/ordinal → words | 163 KB, pure Python | Yes | Yes (v0.5.14, Dec 2024) |

All other normalization (dates, abbreviations, symbols, URLs) is custom Python — no additional dependencies.

### Libraries considered and rejected
- **gruut**: Most complete single-library option, but archived (Oct 2025). Code works today but no future fixes. Borrowing its date normalization logic is fine; depending on the full package is not.
- **nemo-text-processing**: Gold standard quality, but requires Pynini/OpenFST native C++ extensions. No ARM support — does not run on Pi 5.
- **inflect**: Overlaps with `num2words` on number conversion, adds pluralization. Not needed since we don't pluralize in TTS preprocessing.
- **piper-phonemize**: Handles phonemization, not normalization. Downstream of this work.

## Sequencing
- **S1 (Text Normalization)** should come first — it fixes outright mispronunciations and is independent of prosody work.
- **S2 (Prosody Control)** builds on S1's segment splitting and adds pacing variation.
- **S3 (Configuration)** is a small follow-up that exposes tuning knobs.
- These phases are independent of CODEX Phases 3-8 and can be implemented in parallel.

## Validation
After each phase:
- Listen to 10+ representative responses and compare before/after
- Verify no latency regression on time-to-first-audio
- Verify no audio artifacts (clicks, pops, unnatural cuts between segments)
- Test on both Mac (dev) and Pi 5 (prod target)
