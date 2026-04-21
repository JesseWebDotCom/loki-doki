# Chunk 5 — Adapter cutover

## Goal

Adapters are populated for every skill (chunks 1–4). This chunk flips the orchestrator to **consume** adapter output as the canonical shape for sources, media, and facts, retiring ad-hoc skill-shape sniffing. After this chunk, the synthesis/media/sources code paths read from `AdapterOutput`, and the legacy per-skill dict handling is gone.

No frontend changes. No new events. Still a pure backend refactor.

## Files

- `lokidoki/orchestrator/core/pipeline_phases.py` — edit `run_media_augmentation_phase` (L301) and `run_synthesis_phase` (L329) to consume `execution.adapter_output` as the source of truth for media and sources respectively.
- `lokidoki/orchestrator/media/augmentor.py` — edit `augment_with_media` to accept and prefer adapter-provided media over its current re-derivation; keep the legacy derivation path as a fallback for ~1 chunk only (remove in the same chunk if the test matrix allows).
- `lokidoki/orchestrator/core/types.py` — if `request_spec.media` / `request_spec.sources` typing needs to tighten, widen/narrow carefully; do not break existing consumers yet.
- `tests/unit/test_phase_synthesis.py` — update assertions to the adapter-driven shape.
- `tests/unit/test_phase_media_augmentation.py` — update assertions.
- `tests/unit/test_adapter_cutover.py` — new. End-to-end check: a mock calc + wiki + search turn produces sources/media entirely from adapters, with zero references to legacy dict shapes.

Read-only: prior adapter files, `lokidoki/orchestrator/core/streaming.py` (confirm we don't break the event payload shape).

## Actions

1. **Sources path** — in `run_synthesis_phase` (or wherever sources are aggregated for synthesis + response emission), build the sources list by flattening `execution.adapter_output.sources` across all successful executions. Remove the per-skill `if skill_id == "..."` branches.

2. **Media path** — in `run_media_augmentation_phase`:
   - First source: `execution.adapter_output.media` if populated.
   - Second source (fallback): the existing `augment_with_media` derivation — keep it for one release cycle so we aren't betting the turn on adapter correctness alone.
   - Emit a one-line logger warning when the fallback activates so we can watch for skills whose adapter under-populates media.

3. **Facts path** — synthesis already has a `chunks` / `supporting_context` input. Add `execution.adapter_output.facts` into that input so the synthesis prompt can cite atomic facts. Do NOT yet add a `key_facts` block — that lands in Chunk 14. Here we only stop throwing the facts away.

4. **Type tightening** — `RequestSpec.media` is `list[dict]` today; keep it as `list[dict]` in this chunk. Don't tighten the type until Chunk 6 introduces `Block` dataclasses.

5. **Legacy removal scope** — remove *only* the per-skill sniffing conditionals that adapter output now replaces. Leave the existing `ResponseObject.output_text` wiring alone (still produced exactly as before). This chunk must be shape-compatible with the current frontend.

6. **Tests** — update the assertion fixtures in the existing phase tests to the adapter-driven shape. Add the new end-to-end cutover test:
   - Inject mock `MechanismResult`s for three skills.
   - Assert the synthesis input payload has sources aggregated from `adapter_output.sources`.
   - Assert the media list is populated from adapters.
   - Assert no code path reads `mechanism_result.data` directly for sources or media extraction (grep invariant: `rg -n "mechanism_result.data\[" lokidoki/orchestrator/` should return only pure passthrough / logging contexts, not decision logic).

## Verify

```
pytest tests/unit/test_adapter_cutover.py tests/unit/test_phase_synthesis.py tests/unit/test_phase_media_augmentation.py tests/unit/test_streaming.py tests/unit/test_synthesis.py -v
```

All tests pass. The frontend still receives byte-compatible events — manual check: start the backend and hit `/api/v1/chat` with a calculator turn, confirm the SSE event payload shape is unchanged.

## Commit message

```
refactor(orchestrator): cut over sources and media to adapter output

run_synthesis_phase and run_media_augmentation_phase now read sources
and media from execution.adapter_output, eliminating the per-skill
dict-shape sniffing that accumulated as new skills shipped. The
legacy media-derivation path remains one release cycle as a
fallback, with a logger warning on activation.

The frontend event shape is unchanged; this chunk is purely internal.

Refs docs/rich-response/PLAN.md chunk 5.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
