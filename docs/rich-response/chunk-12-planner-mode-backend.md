# Chunk 12 — Response mode derivation (planner backend)

## Goal

Derive the response mode (`direct` / `standard` / `rich` / `deep` / `search` / `artifact`) from existing decomposer fields + explicit user override, and feed it into the planner so block allocation and enrichment budgets can branch per mode. **No regex over `user_input`.** If the derivation proves insufficient, extend the decomposer's schema carefully — this chunk first attempts pure derivation.

## Files

- `lokidoki/orchestrator/response/mode.py` — new. `derive_response_mode(decomposition, user_override) -> Literal[...]`.
- `lokidoki/orchestrator/response/planner.py` — edit. `plan_initial_blocks(adapter_outputs, mode, decomposition)` now consults `mode` to shape the block list (e.g. omit `key_facts` for `direct`; pre-allocate `comparison` when decomposer flagged a comparison intent).
- `lokidoki/orchestrator/core/pipeline_phases.py` — edit `run_synthesis_phase` to call `derive_response_mode` and thread the mode through to the planner and envelope.
- `lokidoki/orchestrator/decomposer/types.py` — OPTIONAL. If derivation cannot cover the deep/search distinction without a new field, add exactly one new field (e.g. `user_effort_hint`). Must keep total required fields ≤ 12 and the prompt ≤ 8,000 chars (CI check in `tests/unit/test_decomposer.py`).
- `lokidoki/core/prompts/decomposition.py` — OPTIONAL. Only edit if the decomposer schema change is unavoidable.
- `tests/unit/test_response_mode.py` — new.

Read-only: design doc §10 and §16.0; decomposer fields list in PLAN.md global context.

## Actions

1. **Derivation rules** — write as a pure function that takes a structured `decomposition` plus an optional `user_override: Literal["direct","standard","rich","deep","search","artifact"] | None`:
   - If `user_override` is set, return it (explicit user control always wins).
   - If `decomposition.intent` indicates explicit retrieval ("find", "look up docs", based on decomposer's existing `intent` field, **not** regex) → `search`.
   - If `decomposition.reasoning_complexity == "thinking"` AND the user has also supplied a deep hint → `deep`. Deep NEVER triggers without explicit user consent.
   - If `decomposition.response_shape == "verbatim"` AND the `capability_need` is a deterministic skill (calculator, datetime, unit_conversion) → `direct`.
   - If `decomposition.response_shape == "synthesized"` AND multiple skills fired OR `requires_current_data == True` → `rich`.
   - Otherwise → `standard`.

2. **Prompt budget preflight**. Before touching `decomposition.py`, run the existing budget guard test (`tests/unit/test_decomposer.py` has a prompt-size guard per CLAUDE.md). Only edit the prompt if derivation empirically fails to distinguish the cases you need. Document the decision in this chunk's `## Deferrals` if a schema change was required.

3. **Planner mode-aware shaping** (in `planner.py`):
   - `direct`: summary only. Source block omitted unless the single deterministic skill produced one. No media, no follow-ups.
   - `standard`: summary + sources (if any) + media (if any) + follow_ups (up to 3 candidates).
   - `rich`: summary + sources + media + key_facts (pre-allocated, populated by Chunk 14) + follow_ups. If comparison signal detected, pre-allocate `comparison` too.
   - `deep`: summary + sources + key_facts + steps + comparison (all pre-allocated; populated progressively in Chunk 18).
   - `search`: summary (short "takeaway") + sources (primary, rendered in list mode by Chunk 14) + follow_ups.
   - `artifact`: summary (short supervisory text) + artifact_surface (populated in Chunks 19–20).

4. **Envelope propagation** — `run_synthesis_phase` sets `envelope.mode = derived_mode` and emits that in the `response_init` event (Chunk 9 event already reserves `mode` in the init payload).

5. **Legacy fallback**. If anything in the derivation path raises, default to `standard` and log a warning. The chunk must never break a turn because mode derivation threw.

6. **Tests** (`test_response_mode.py`):
   - Each derivation branch with a minimal fake `decomposition` fixture.
   - `user_override` wins over every automatic rule.
   - The planner output block list differs by mode in the expected ways.
   - Grep invariant: `rg -n "re.match\|re.search\|\.find(\"\|\.lower\(\)" lokidoki/orchestrator/response/mode.py lokidoki/orchestrator/response/planner.py` returns nothing. No regex, no lowercased keyword scans over user text.

## Verify

```
pytest tests/unit/test_response_mode.py tests/unit/test_decomposer.py tests/unit/test_phase_synthesis.py -v
```

All tests pass. The decomposer prompt-size guard remains green.

## Commit message

```
feat(response): derive response mode from decomposer fields

Add lokidoki/orchestrator/response/mode.py — pure derivation from
the decomposer's existing intent / response_shape /
reasoning_complexity / capability_need / requires_current_data
fields, with optional user_override taking precedence. No regex or
keyword scanning of user_input.

plan_initial_blocks now shapes the block list per mode (direct =
summary only; rich/deep pre-allocate key_facts/steps/comparison;
search uses a takeaway + source-list shape). Envelope.mode is set
per-turn and emitted via response_init.

Refs docs/rich-response/PLAN.md chunk 12.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
