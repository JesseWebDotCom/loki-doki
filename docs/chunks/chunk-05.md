# Chunk 05 — Prompts / Decomposer Refinement

**Source:** `docs/v2-graduation-plan.md` §4.C.
**Prereqs:** None. Independent.

---

## Goal

Decide whether v2 needs an LLM decomposer at all, and if so, optimize it. v2 already does most decomposition deterministically (normalize -> parse -> split -> extract -> route). The question is where an LLM decomposer earns its place.

---

## Current State

- **v1:** 4,637-char decomposition prompt, `gemma4:e4b`, 20s timeout, repair loop with MAX_REPAIRS=2.
- **v2:** 4 small templates (~80-200 chars each) in `v2/orchestrator/fallbacks/prompts.py`. Strict slot validation. No decomposer-specific model call — the pipeline is deterministic up through routing.
- v2 already has 84-prompt regression corpus.

---

## Research Questions

1. Can v2 do without a decomposer entirely? The pipeline already does normalize -> parse -> split -> extract -> route deterministically.
2. If needed, what's the smallest model? (qwen3:0.6b? gemma3:270m?)
3. Constrained decoding vs prompt-only — does it help?

---

## Likely Outcome

v2's deterministic pipeline already handles routing. The "decomposer" role in v2 is reduced to:
- Emitting `need_*` flags for memory retrieval (already partially wired in M2/M3)
- Emitting `intent` classification for Gate 5 (already used in M1)
- Emitting `sentiment` for Tier 6 (needed in M6)

These are small structured fields the parse tree + a tiny model can handle. The 4,637-char v1 mega-prompt is dead.

---

## Deferred from C02 (Skills Foundation)

**Skill-local text heuristics.** C02 confirmed that 10 skills fall back to
`chunk_text` parsing (regex/keyword) when `params` are absent. All check
`params` first, so the fix is to have the decomposer/resolver emit structured
params for: `location` (weather), `zip` (showtimes), `city` (time_in_location),
`country`/`year` (holidays), `topic` (news), `word` (dictionary), `ticker`
(markets), `person`/`fact_type` (people_facts), `message_body` (contacts).
Once params are reliably populated, the fallback heuristics can be removed.

---

## What to Build

1. **Audit v2's decomposer needs.** List every structured field the pipeline consumes from a "decomposer": `need_preference`, `need_social`, `need_session_context`, `need_episode`, `intent`, `sentiment`, `complexity`. Check which are already derived deterministically. **Note from C01:** `need_session_context` and `need_episode` are wired as context flags but not yet emitted by a decomposer — they're currently caller-set (dev tools toggles or auto-raised by the pronoun resolver). This chunk should decide how they get set automatically.
2. **Implement missing derivations.** For fields that can be derived from the spaCy parse tree or simple heuristics, implement them in Python (not in a prompt).
3. **Prompt budget test.** Add `tests/unit/test_v2_decomposer_budget.py` enforcing < 2,000 chars total for any v2 prompt.
4. **Delete or justify repair loop.** If v2 still has any repair logic, delete it or document why it's necessary.

---

## Key Files

| File | Action |
|---|---|
| `v2/orchestrator/fallbacks/prompts.py` | Read + potentially shrink |
| `v2/orchestrator/pipeline/parser.py` | Read — what spaCy features are available |
| `v2/orchestrator/pipeline/extractor.py` | Read — what extraction already happens |
| `v2/orchestrator/core/pipeline.py` | Read — where decomposer-like logic runs |
| `tests/unit/test_v2_decomposer_budget.py` | New file |

---

## Gate Checklist

- [ ] 2+ approaches considered (documented even if one is obviously better)
- [ ] p95 decompose latency < 300ms warm
- [ ] Total prompt budget < 2,000 chars
- [ ] Repair loop deleted or justified
