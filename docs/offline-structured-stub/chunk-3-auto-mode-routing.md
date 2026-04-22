# Chunk 3 — Auto-mode non-rich path renders stub without LLM

## Goal

When `response_mode === 'auto'` AND the turn is NOT rich/deep AND the knowledge skill returned a good ZIM hit with a populated `structured_markdown`, emit that markdown as the summary block directly — skip LLM synthesis entirely. Rich / Deep modes (including Auto → Rich escalation) still go through the LLM.

## Files

Touch:
- `lokidoki/orchestrator/response/mode.py`
- `lokidoki/orchestrator/fallbacks/llm_prompt_builder.py` (may need a fast-path escape — keep untouched if possible)
- `lokidoki/orchestrator/core/pipeline_phases.py` (the synthesis-dispatch site — locate the decision that currently calls `combine`/`direct_chat`)
- `tests/unit/test_response_mode.py` (extend)
- `tests/unit/test_llm_prompt_builder.py` (ensure no Rich/Deep regressions)

Read-only reference:
- `lokidoki/orchestrator/fallbacks/llm_prompt_builder.py` L449–504 (`build_combine_prompt`, `_is_direct_chat_only`, `_RICH_MODE_DIRECTIVE`)
- `lokidoki/orchestrator/core/pipeline_phases.py` L707–822 (envelope event emission)
- Chunk-12 planner-mode plan: `docs/rich-response/chunk-12-planner-mode-backend.md`

## Actions

1. Add a helper `should_use_structured_stub(spec, decomposition_result, skill_results) -> bool` in `response/mode.py`:
   - `spec.response_mode == 'auto'`
   - The decomposer output indicates a biographical/definitional intent (use existing decomposer fields; DO NOT add a new regex — if no suitable field exists, this chunk emits a `## Blocker` and defers to a decomposer-schema chunk).
   - The knowledge skill's `MechanismResult.success == True` with `data["structured_markdown"]` present and non-empty.
   - The router has not already escalated to `rich` or `deep`.
2. In the synthesis-dispatch site in `pipeline_phases.py`, branch on `should_use_structured_stub(...)`:
   - If true: skip the `combine` / `direct_chat` LLM call. Build the response envelope directly with `summary.content = skill.data["structured_markdown"]` and `spoken_text = skill.data["lead"]` (TTS reads the lead, not the section list).
   - Emit the same `response_init` → `block_init(summary)` → `block_patch(summary, delta=structured_markdown)` → `block_ready(summary)` → `response_snapshot` → `response_done` sequence so the frontend progressive-rendering + TTS paths behave identically to a synthesized turn.
   - The emission may be done in a single `block_patch` with the full text — progressive rendering still animates via the frontend typewriter (chunk-10 progressive-rendering + streaming-inline plan chunk 3).
3. Source surface: emit a single source chip for the ZIM article (use the existing `source_url` / `source_title` fields from `MechanismResult`). Chunk-11 offline trust chip logic unchanged.
4. Rich / Deep path: verify untouched. `should_use_structured_stub` returns False; the normal LLM synthesis path runs as today.
5. Auto mode with a knowledge miss (no ZIM hit): falls through to normal synthesis, unchanged.
6. If a decomposer field required by step 1 doesn't exist yet, **stop** and file a `## Blocker` — do NOT add a regex classifier. Per CLAUDE.md: regex/keyword classification of user intent is banned.

## Verify

```
uv run pytest tests/unit/test_response_mode.py tests/unit/test_llm_prompt_builder.py tests/unit/test_knowledge_skill.py -v
```

Manual: `./run.sh`, load the frontend. Ask "who is Luke Skywalker" in Auto mode. Expect: sub-second response, structured markdown with lead + section headers, single Wikipedia source chip, no LLM warmup in logs. Switch to Rich mode, ask the same: LLM synthesis runs (logs show combine prompt build), response is conversational.

## Commit message

```
feat(orchestrator): Auto-mode structured stub skips LLM synthesis

When a ZIM-backed knowledge hit satisfies the Auto-mode non-rich
criteria, the orchestrator emits the structured markdown stub from the
skill directly into the summary block and bypasses combine/direct_chat
synthesis. The envelope event sequence is identical to a synthesized
turn so progressive rendering, citations, and voice behave the same
way. Rich/Deep modes still route through the LLM.

Refs docs/offline-structured-stub/PLAN.md chunk 3.
```

## Deferrals

(append-only)
