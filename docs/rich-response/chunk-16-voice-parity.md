# Chunk 16 — Voice parity (one-call synthesis + barge-in)

## Goal

Enforce the design doc §20.3 contract: `spoken_text` and the visual summary come from the **same synthesis call**, never two model passes. Add barge-in durability so TTS interruption does not speak stale content mid-sentence, and ensure each new block type has a clear "read / don't read" policy.

## Files

- `lokidoki/orchestrator/synthesis/<the synthesis module>` — edit so the JSON shape explicitly includes both `response` and `spoken_text` in one call. Do NOT add a second LLM invocation under any circumstance.
- `lokidoki/orchestrator/response/spoken.py` — new. `resolve_spoken_text(envelope) -> str` — authoritative source for TTS input, pulling from `envelope.spoken_text`, falling back to a trimmed summary if empty, never speaking block items (sources, media, follow_ups).
- `frontend/src/lib/tts.ts` — edit (or wherever TTS is initiated). Snapshot `resolve_spoken_text(envelope)` once at synthesis completion; ignore subsequent block patches for speech purposes. Surface a barge-in handler that cuts TTS cleanly on user input or `block_failed`.
- `lokidoki/orchestrator/response/planner.py` — annotate each block type with a `tts_policy` (`speak` | `skip`).
- `tests/unit/test_spoken_text.py` — new.
- `frontend/src/lib/__tests__/tts.test.ts` — new.

Read-only: synthesis prompt file, existing TTS initiation path.

## Actions

1. **Synthesis schema** — the synthesizer's JSON output must include both `response` (visual summary) and `spoken_text` (short form for TTS). If the existing schema already has both (Chunk 7 wires `spoken_text` into the envelope), this step confirms and asserts. If only `response` exists, extend the JSON grammar to require `spoken_text`. Keep the schema tight — two required fields.

2. **TTS policy table** (in `planner.py` or a dedicated `tts_policy.py` helper):

   | Block type | Policy |
   |---|---|
   | `summary` | speak (via `spoken_text`, not block content verbatim) |
   | `key_facts` | skip |
   | `steps` | skip |
   | `comparison` | skip |
   | `sources` | skip |
   | `media` | skip (YouTube card titles are not read aloud) |
   | `cta_links` | skip |
   | `clarification` | speak (the question needs to be heard) |
   | `follow_ups` | skip |
   | `status` | speak at most once per phase when turn > 3 s |

   Implement as a static dict; consumers look it up.

3. **`resolve_spoken_text`**:
   - Prefer `envelope.spoken_text` when non-empty.
   - If empty/missing, fall back to the summary block's first 200 chars ending at a sentence boundary.
   - If no summary is ready either, return `""` (don't speak anything yet; TTS will catch up when the summary lands).
   - NEVER concatenate item lists (sources, follow-ups) into spoken output.

4. **Barge-in handling** (frontend `tts.ts`):
   - Maintain a single "current utterance" handle.
   - On user input focus, key press, voice wake word, or `block_failed` event for the summary block: cancel the current utterance immediately.
   - Do NOT wait for the sentence to finish before canceling.
   - Prevent TTS from starting for the same turn twice (idempotent).

5. **Snapshot semantics** for spoken text:
   - TTS input is resolved exactly once per turn, when the summary block transitions to `ready` (or `partial` if the first patch is already a complete sentence, for snappier voice response on fast turns).
   - Subsequent `block_patch` events for the summary DO update the visual but do NOT retroactively edit what is being spoken — design doc §20.4.

6. **Profile gating**:
   - On `pi_cpu`, the spoken_text-first UX means TTS can start speaking the `spoken_text` before all visual blocks are ready. That's the point.
   - On `mac` dev, the same path runs; no profile-specific branches needed here.

7. **Tests**:
   - `test_spoken_text`: envelope with populated `spoken_text` returns it; empty fallback returns trimmed summary; no URL or follow-up item ever appears in the output.
   - Frontend: barge-in cancels the utterance within 50 ms of the cancel trigger; duplicate utterances don't stack.
   - Synthesis-schema test: the JSON shape requires both `response` and `spoken_text`; missing `spoken_text` raises.

## Verify

```
pytest tests/unit/test_spoken_text.py tests/unit/test_synthesis.py -v && npm --prefix frontend run test -- tts && npm --prefix frontend run build
```

All tests pass. Manual: send a long query with a `rich` response → `spoken_text` plays the short form while the visual hydrates with structure; interrupt by typing → TTS cuts immediately; verify no second LLM call was fired (check backend logs / metrics).

## Commit message

```
feat(voice): one-call synthesis + barge-in durability

Enforce that spoken_text and the visual summary come from the
single synthesis JSON call — no second LLM pass, ever. Introduce
resolve_spoken_text as the authoritative TTS input (never reads
sources/media/follow-ups aloud) and a per-block-type tts_policy
table.

Barge-in cancels the current utterance immediately on user input,
wake word, or summary-block failure. Subsequent block patches
update the visual only; what is being spoken is snapshot at first
ready.

Refs docs/rich-response/PLAN.md chunk 16.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
