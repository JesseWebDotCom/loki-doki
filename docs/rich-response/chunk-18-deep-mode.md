# Chunk 18 — Deep-work path with wall-clock cap + checkpoints

## Goal

Implement deep mode as a **dedicated async path**, not a bigger standard turn. Enforces the design doc §10.4 contract: explicit user opt-in (Chunk 13 shipped the UI), wall-clock cap per profile, checkpointed block writes so the user sees progress, single concurrent deep turn per session, dedicated task isolation.

## Files

- `lokidoki/orchestrator/deep/__init__.py` — new package.
- `lokidoki/orchestrator/deep/runner.py` — new. `run_deep_turn(request_spec, envelope, emit)` — async generator that yields intermediate `block_patch` / `block_ready` events and returns the final envelope.
- `lokidoki/orchestrator/deep/stages.py` — new. Staged evidence pipeline: expand the ask → query multiple skills → dedupe sources → progressive summarization → final synthesis.
- `lokidoki/orchestrator/deep/gate.py` — new. Single-concurrent-deep-turn enforcement (per session) via an asyncio lock or a session-state flag.
- `lokidoki/orchestrator/core/pipeline.py` — branch into the deep runner when `envelope.mode == "deep"`; keep standard path otherwise.
- `frontend/src/components/chat/DeepWorkFrame.tsx` — new. Progress-oriented shell for deep turns, highlighting the active stage and accumulated evidence.
- `frontend/src/components/chat/MessageItem.tsx` — render `DeepWorkFrame` when `envelope.mode == "deep"` and `status == "streaming"`.
- `tests/unit/test_deep_runner.py` — new.

Read-only: Chunks 6, 7, 9, 12.

## Actions

1. **Wall-clock cap per profile** (in `runner.py`):
   - `mac`: 45 s.
   - `pi_hailo`: 60 s.
   - `pi_cpu`: 90 s.
   - Implement as `asyncio.wait_for` around the deep stage pipeline. On timeout, do NOT raise to the user — materialize the partial envelope, run a short final-synthesis pass over what we have, and emit `block_ready` on everything populated so far. The `status` block explains the timeout neutrally.

2. **Stages** (`stages.py`):
   - `expand_ask` — one LLM call (fast model) that produces 2–4 sub-queries from the user's request. Constrained JSON output. Input is decomposer output, not raw user text.
   - `gather` — run each sub-query through the existing skill routing. Collect adapter outputs. This is the slow stage; emit `block_patch` on `sources` as each sub-query completes.
   - `dedupe` — normalize sources (by URL + title similarity) into the envelope's `source_surface`.
   - `progressive_summary` — one LLM call (thinking model) that writes the summary block, with the full deduped source pool as context. Emit `block_patch` on the summary as tokens stream.
   - `finalize` — populate `key_facts` / `comparison` / `steps` as Chunk 14's helper allows, using the gathered material.

3. **Concurrency gate** (`gate.py`):
   - Per-session lock. A second deep request while one is in-flight returns a clarification block: "Finishing your previous deep turn first; reply /cancel to stop it."
   - Do NOT queue silently; the user should know.

4. **Checkpointed writes**:
   - Every stage transition persists the current envelope snapshot to `messages.response_envelope` so a browser refresh or transient disconnect doesn't lose the in-progress turn.
   - The snapshot is overwritten each checkpoint (the final `response_snapshot` wins).

5. **Mode-aware frontend frame** (`DeepWorkFrame.tsx`):
   - Shows a progress bar with stage labels (Expanding → Gathering → Summarizing → Finalizing).
   - Renders evidence as it arrives (source cards appear under the progress bar).
   - Uses the block registry for inner content — no bespoke block rendering.
   - Collapses to the normal rich frame when `status == "complete"`.

6. **Offline safety** — deep turns that need network skills must degrade gracefully: a fully-offline device either refuses the deep turn (clarification block explaining why) or runs a local-knowledge-only deep turn using adapter outputs from non-network skills.

7. **Metrics** — emit the stage timings via the existing instrumentation hooks so §23 deep-mode-completion-under-cap target is measurable.

8. **Tests**:
   - Timeout path: mock a slow stage; assert partial materialization and no exception surfaces.
   - Concurrency: second deep request while one is in-flight returns a clarification block.
   - Offline: no-network deep turn returns a clarification rather than a thrashed retry loop.
   - Checkpointing: simulate a client disconnect mid-turn; the final persisted envelope is consistent with the last-emitted snapshot.

## Verify

```
pytest tests/unit/test_deep_runner.py tests/unit/test_phase_synthesis.py -v && npm --prefix frontend run test -- DeepWorkFrame && npm --prefix frontend run build
```

All tests pass. Manual on `mac`: send `/deep compare Tesla Model Y and Ford Mustang Mach-E`; progress bar advances; evidence accumulates; final envelope shows summary + comparison + sources within the cap.

## Commit message

```
feat(deep): dedicated deep-work path with wall-clock cap + checkpoints

Deep mode now runs in a dedicated async task with staged evidence
gathering (expand → gather → dedupe → summarize → finalize),
per-profile wall-clock caps (45/60/90 s), single-concurrent
enforcement per session, and checkpointed envelope persistence so
client reconnects don't lose state.

DeepWorkFrame renders a progress-oriented shell over the block
registry — no bespoke rendering.

Refs docs/rich-response/PLAN.md chunk 18.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
