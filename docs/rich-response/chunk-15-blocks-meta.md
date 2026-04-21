# Chunk 15 — `follow_ups` / `clarification` / `status` block renderers

## Goal

Finish the initial block family: short tappable follow-up chips, a clarification block for ambiguous turns, and a `status` block for in-flight activity text ("checking sources", "looking for a video") that is distinct from the pipeline popover. After this chunk, the registry covers every type declared in the design doc §11.3.

## Files

- `frontend/src/components/chat/blocks/FollowUpsBlock.tsx` — new.
- `frontend/src/components/chat/blocks/ClarificationBlock.tsx` — new.
- `frontend/src/components/chat/blocks/StatusBlock.tsx` — new.
- `frontend/src/components/chat/blocks/index.ts` — register the three new renderers.
- `lokidoki/orchestrator/response/planner.py` — allocate `follow_ups` when adapter `follow_up_candidates` are present (and mode allows); allocate `clarification` when the decomposer surfaces an ambiguity signal (reuse existing clarification event if present; see `docs/DESIGN.md` clarification_question).
- `lokidoki/orchestrator/response/status_strings.py` — new. Static map from pipeline phase → human-friendly activity text ("checking sources", "pulling a quick summary"). No regex, no LLM — a small dict.
- `lokidoki/orchestrator/core/pipeline_phases.py` — emit `status` block patches at phase transitions so the UI has live activity text.
- `tests/unit/test_status_strings.py` — new.
- `frontend/src/components/chat/__tests__/meta-blocks.test.tsx` — new.

Read-only: prior block renderers, Chunk 9 event shapes, `docs/DESIGN.md` clarification handling.

## Actions

1. **`FollowUpsBlock`** — horizontal row of shadcn `Button variant="secondary"` chips (wrapping on narrow). Clicking a chip submits it as the next user turn (reuse the existing submit path). Max 4 chips rendered; overflow hidden.

2. **`ClarificationBlock`** — highlighted card with the clarification question text and 2–4 quick-reply chips (shadcn `Button variant="outline"`) if the decomposer supplied candidate answers. Reusing the existing clarification event path from DESIGN.md — the clarification text may already be available; route it into this block instead of inline prose.

3. **`StatusBlock`** — single-line muted text with a subtle pulse animation (shadcn-compatible; no custom keyframes beyond Tailwind's built-ins). Updates as the backend emits new `status` block patches.

4. **Status strings** (`status_strings.py`):

   ```python
   STATUS_BY_PHASE = {
       "augmentation": "Looking up context",
       "decomposition": "Understanding your ask",
       "routing": "Picking the right skills",
       "execute": "Checking sources",
       "media_augment": "Looking for visuals",
       "synthesis": "Pulling a summary together",
   }
   ```

   Keep entries short, human, no internal jargon (design doc §22 "Good" / "Bad" lists).

5. **Pipeline status patches**:
   - At each phase transition, emit a `block_patch` for the `status` block with the new phrase.
   - On any block failure, update the `status` block to a neutral phrase ("finishing up") rather than dwelling on errors — users see failures on the actual failing block, the status block shouldn't double-report.
   - On `response_done`, set the `status` block to `state="omitted"` so it disappears (it's a live-only surface).

6. **Clarification integration**:
   - If synthesis emits a `clarification_question` (existing DESIGN.md event), the planner allocates a `clarification` block and marks the overall turn as awaiting the clarification response.
   - No new backend dependency; this is a wiring chunk.

7. **Voice behavior**:
   - `FollowUpsBlock` chips are NEVER read aloud. `spoken_text` stays focused on the summary (design doc §20.2).
   - `StatusBlock` text MAY be spoken on voice-first turns at most once per phase, and only if the turn is taking >3 s — avoids a constant narration.
   - `ClarificationBlock` IS spoken, because the user needs to hear the question to answer.

8. **Tests**:
   - Planner allocates `follow_ups` only when `adapter_output.follow_up_candidates` is non-empty (no fabrication).
   - Status block receives patches at phase transitions; renders the mapped string.
   - Clarification block renders + spoken output includes the question.

## Verify

```
pytest tests/unit/test_status_strings.py tests/unit/test_phase_synthesis.py -v && npm --prefix frontend run test -- meta-blocks && npm --prefix frontend run build
```

All tests pass. Manual: ambiguous query ("where's that place we talked about?") surfaces a clarification block; long-running queries show live status text that reads human.

## Commit message

```
feat(chat): follow_ups / clarification / status block renderers

Registry now covers every block type in the design doc:
FollowUpsBlock (tappable chips; never read aloud),
ClarificationBlock (spoken + rendered, routes existing
clarification_question event), StatusBlock (live activity text
from a small phase->phrase map, omitted on response_done).

Refs docs/rich-response/PLAN.md chunk 15.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
