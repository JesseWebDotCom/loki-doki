# Chunk 03 — Persona Injection + Confidence-Aware Synthesis

**Source:** `docs/v2-graduation-plan.md` §4.F (Persona) + §4.H (Synthesis) + §3.4 (canonical bad behavior).
**Prereqs:** None. Independent.

---

## Goal

1. Wire persona (character name + behavior prompt) into v2 synthesis so the assistant has personality.
2. Make the combine prompt confidence-aware so it doesn't parrot low-confidence skill output.

These are combined because both touch the combine prompt template and should land together to avoid merge conflicts.

---

## Persona (4.F)

### Current state
- v1 wires persona at `lokidoki/api/routes/chat.py:73-91` — fetches active character via `character_ops.get_active_character_for_user`, passes `behavior_prompt` to orchestrator.
- v2 has **nothing**. The combine prompt has no `{character_name}` or `{behavior_prompt}` slot.

### What to build
- Add `{character_name}` and `{behavior_prompt}` slots to `COMBINE_PROMPT` and `DIRECT_CHAT_PROMPT` in `v2/orchestrator/fallbacks/prompts.py`.
- Thread `character_name` + `behavior_prompt` into `run_pipeline_async` via `context`.
- **Persona never reaches the decomposer** — add a test asserting this.
- The simplest approach: free-text persona slot in templates (same as v1). No need for structured persona descriptors yet.

### Key files
- `v2/orchestrator/fallbacks/prompts.py` — add slots
- `v2/orchestrator/fallbacks/llm_fallback.py` — thread persona into prompt building
- `v2/orchestrator/core/pipeline.py` — pass persona through context
- `lokidoki/api/routes/chat.py:73-91` — read to understand v1 wiring (don't edit yet)

---

## Synthesis (4.H)

### Current state
- v2 combine prompt at `v2/orchestrator/fallbacks/prompts.py:63-78` tells the model to "mention each successful chunk's result" and "use ONLY information present in the RequestSpec."
- This means when the router is wrong (low-confidence route), the model parrots the bogus skill output.

### What to build
- Make the combine prompt **confidence-aware**: pass `chunk.confidence` + `chunk.source` into the prompt.
- Rules: high-confidence + structural source (people_db, home_assistant) = pass through. Low-confidence / borderline = "the following may not be relevant; use your judgment."
- Add a "no hallucination" path: when all chunks are `direct_chat` or low-confidence, the combine prompt should allow the model to say "I don't know."
- Remove the "mention each successful chunk's result" instruction.

### Key files
- `v2/orchestrator/fallbacks/prompts.py` — rewrite combine prompt
- `v2/orchestrator/execution/request_spec.py` — check what confidence data is available
- `v2/orchestrator/fallbacks/llm_fallback.py` — thread confidence into prompt

---

## Tests

- `tests/unit/test_v2_persona.py` (new): persona slot renders in combine, doesn't render in decomposer, empty persona = no extra tokens.
- `tests/unit/test_v2_synthesis.py` (new): confidence-aware prompt renders differently for high vs low confidence chunks.
- Regression: add a "no-hallucination" fixture to `v2_regression_prompts.json` where the right answer is "I don't know."

---

## Gate Checklist

- [ ] Persona slot in combine + direct_chat templates
- [ ] Persona never reaches the decomposer (test assertion)
- [ ] Combine prompt does not say "mention each successful chunk's result"
- [ ] Confidence metadata reaches the combine prompt
- [ ] "I don't know" path works for all-low-confidence specs
