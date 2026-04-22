# Chunk 4 — Tests: parser, Auto-mode fast-path, Rich/Deep unchanged

## Goal

End-to-end coverage for the structured-stub path. Lock in parser behavior, skill composition, orchestrator branching, and the Rich/Deep invariant.

## Files

Touch:
- `tests/unit/test_knowledge_parse.py` (extend)
- `tests/unit/test_knowledge_skill.py` (extend)
- `tests/unit/test_response_mode.py` (extend)
- `tests/integration/test_auto_mode_fast_path.py` (new — end-to-end orchestrator test)
- `tests/fixtures/wiki/luke_skywalker.html` (new — a pop-culture Wikipedia-shaped HTML fixture)

Read-only reference:
- Chunks 1–3 of this plan.

## Actions

1. **Fixture** — hand-craft `luke_skywalker.html` with realistic Wikipedia structure: `<div id="mw-content-text">`, multiple `<p>` in the lead, 4–5 `<h2>` sections including at least one "See also" and one "References", with each section having a first `<p>` and some `<table>` noise to exercise the skip logic.
2. **Parser tests**: feed the fixture through `parse_wiki_html`. Assert: lead has ≥2 paragraphs concatenated; `section_items` has the expected H2 count MINUS "See also"/"References" (those are filtered in chunk 2 at the skill layer — so the parser still yields them; the filtering test belongs in the skill suite).
3. **Skill tests**: mock `httpx.AsyncClient.get` to return the fixture. Assert `structured_markdown` starts with the lead, contains `## Early life` (or whichever section is first valid), does NOT contain `## See also` or `## References`, and is capped under 2500 chars.
4. **Orchestrator integration** (`test_auto_mode_fast_path.py`):
   - With `response_mode='auto'` and decomposer output flagged as biographical/definitional + a knowledge-skill hit: assert no LLM provider calls were made; assert the response envelope's summary block content equals `structured_markdown`; assert `spoken_text` equals `lead`; assert exactly one source chip present.
   - With `response_mode='rich'` and the same input: assert the LLM synthesis path was invoked; assert the summary is NOT a verbatim copy of `structured_markdown`.
   - With `response_mode='auto'` and a knowledge miss: assert synthesis still runs (fall-through path unchanged).
   - With `response_mode='deep'`: assert the deep path runs with wall-clock cap + checkpoints (chunk-18 invariant).
5. **Regression check**: re-run `test_llm_prompt_builder.py`. Zero failures attributable to this plan.
6. **Latency guard** (soft assertion): the Auto-mode fast-path test should complete in < 200ms on CI (no LLM call) — a timing assertion to catch accidental synthesis invocations.

## Verify

```
uv run pytest tests/unit/test_knowledge_parse.py tests/unit/test_knowledge_skill.py tests/unit/test_response_mode.py tests/unit/test_llm_prompt_builder.py tests/integration/test_auto_mode_fast_path.py -v
```

## Commit message

```
test(offline-structured-stub): lock in Auto-mode stub + Rich/Deep unchanged

End-to-end coverage: HTML parser section capture, skill-level
structured_markdown composition with navigation-section filtering,
orchestrator Auto-mode branching to the stub (no LLM calls, single
source chip, lead as spoken_text), Rich/Deep modes still routing
through the LLM synthesis path. Includes a sub-200ms latency guard to
catch accidental LLM invocation regressions.

Refs docs/offline-structured-stub/PLAN.md chunk 4.
```

## Deferrals

(append-only)
