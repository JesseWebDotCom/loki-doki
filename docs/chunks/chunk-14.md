# Chunk 14 — Refactor Oversized Code + Full-Spectrum E2E Test Suite

**Source:** Quality audit during C10/C13 planning.
**Prereqs:** C13 (promotion complete — all paths are `lokidoki.orchestrator.*`).

---

## Goal

Two deliverables:

**A. Refactor** — Break oversized files and functions down to the project ceiling (300 lines / 40 lines). Eliminate over-fetching patterns where the pipeline loads all N rows when it needs K.

**B. End-to-end test suite** — Build a regression corpus and parametrized test runner that exercises every capability, every compound pattern, and the pure-LLM fallback path. Coverage gate: every registered capability has at least one corpus entry, and the compound tier covers simple → two-skill → complex (3+ intents) inputs.

---

## Part A: Refactor

### Oversized files (post-C13 paths shown)

| File (post-promotion) | Lines | Limit | Action |
|---|---|---|---|
| `lokidoki/orchestrator/memory/store.py` | 1479 | 300 | Split into `store.py` (connection + schema), `store_facts.py`, `store_social.py`, `store_sessions.py`, `store_affect.py`, `store_behavior.py` |
| `lokidoki/orchestrator/core/pipeline.py` | 843 | 300 | Extract `pipeline_memory.py` (read/write path, ~200 lines), `pipeline_hooks.py` (sentiment, behavior event, session state, ~150 lines), keep `pipeline.py` as the top-level orchestration (<300 lines) |
| `lokidoki/orchestrator/memory/reader.py` | 797 | 300 | Split into `reader_fts.py`, `reader_vector.py`, `reader_rrf.py` |
| `lokidoki/orchestrator/memory/gates.py` | 479 | 300 | Split into `gates.py` (core gate chain) and `gate_rules.py` (individual rule implementations) |
| `lokidoki/orchestrator/fallbacks/llm_fallback.py` | 428 | 300 | Extract `llm_prompt_builder.py` (prompt assembly) from `llm_fallback.py` (decision + call logic) |
| `lokidoki/orchestrator/skills/travel_local.py` | 468 | 300 | Split into `flights.py`, `hotels.py`, `visa.py` (one file per capability family) |
| `lokidoki/orchestrator/memory/slots.py` | 371 | 300 | Inline the duplicated `assemble_slots()` logic — pipeline.py's `_run_memory_read_path` is the authoritative path; remove the duplicate in slots.py or have one call the other |

### Oversized functions

| Function | File | Lines | Action |
|---|---|---|---|
| `write_social_fact()` | `store.py` | 108 | Extract `_upsert_person_for_social_fact()` and `_link_relationship()` helpers |
| `_run_memory_read_path()` | `pipeline.py` | 79 | Move to `pipeline_memory.py`, split per-tier assembly into named helpers |
| `build_combine_prompt()` | `llm_fallback.py` | 66 | Move to `llm_prompt_builder.py` |
| `write_semantic_fact()` | `store.py` | 71 | Extract dedup/supersede logic into `_check_and_supersede()` |
| `_stub_synthesize()` | `llm_fallback.py` | 54 | Simplify — each branch (unresolved, ambiguous, supporting) becomes a named helper |
| `_run_memory_write_path()` | `pipeline.py` | 51 | Move to `pipeline_memory.py` |

### Over-fetching fixes

| Location | Problem | Fix |
|---|---|---|
| `reader.py` vector scan | `SELECT id, embedding FROM facts WHERE status='active'` — loads ALL embeddings into Python, computes cosine in a loop | Add `LIMIT 500` safety cap; long-term: use sqlite-vec or pre-filter by FTS5 hit set before vector scoring |
| `reader.py` subject scan | `SELECT id, subject FROM facts WHERE status='active'` — full table scan per query | Add `LIMIT 200`; consider FTS5 subject index |
| `store.py` `get_active_facts()` | No LIMIT — dev tools and dump endpoints load everything | Add optional `limit: int = 200` parameter; dev dump can pass `limit=0` for unbounded |
| `store.py` `get_behavior_events()` | No LIMIT on event history | Add `limit: int = 1000` default |
| `store.py` `get_people()`, `get_relationships()` | No LIMIT | Add optional limit, default 100 |
| `pipeline.py` slot assembly | `assemble_slots()` in `slots.py` duplicates `_run_memory_read_path()` logic | Delete the duplicate; have one canonical path gated by `need_*` flags |

---

## Part B: Full-Spectrum E2E Test Suite

### Current state

- **87** registered capabilities in `function_registry.json`
- **29** covered by regression corpus (33%)
- **58** with zero corpus entries (67% gap)
- Compound tests: 5 entries (2 two-skill, 3 subordinate/supporting)
- No pure-LLM fallback entry
- No 3+ intent compound entry
- No memory-context + skill compound entry

### Target

**Corpus expands to 200+ entries** across 4 tiers:

#### Tier 1: Single-capability (one entry per registered capability = 87 minimum)

Every capability in `function_registry.json` gets at least one regression entry. For capabilities without a real provider (e.g., `search_flights`, `play_music`), the entry asserts the correct capability is routed and the handler returns a graceful "unavailable" or stub response — not that it returns real data.

Format per entry:
```json
{
  "id": "single.<capability>",
  "utterance": "...",
  "expect": {
    "capability": "<capability>",
    "fast_lane_matched": false
  }
}
```

#### Tier 2: Two-capability compounds (20+ entries)

Each entry sends two distinct intents joined by "and", comma, or sequential sentences. Asserts both capabilities are routed.

Families to cover:
- skill + skill (weather + time, joke + recipe, etc.)
- skill + fast-lane (weather + greeting, math + spell)
- skill + knowledge (weather + "who invented the thermometer")
- device + device (turn on lights and set thermostat)

Format:
```json
{
  "id": "compound.two.<family>",
  "utterance": "...",
  "expect": {
    "chunk_count": 2,
    "capabilities": ["<cap_a>", "<cap_b>"]
  }
}
```

#### Tier 3: Complex inputs (15+ entries)

Three or more intents, mixed skill families, subordinate clauses, follow-up context, ambiguous referents.

Examples:
- "When did the movie John Carter come out and is there going to be a sequel" (knowledge + knowledge, requires movie context)
- "What's the weather tomorrow, remind me to bring an umbrella, and tell me a joke" (weather + reminder + joke)
- "Turn off the living room lights, what time is it in Tokyo, and how do you spell chrysanthemum" (device + time + spell)
- "My brother Luke said the new Star Wars movie is great — when is it showing near me and what's the rating" (social context + showtimes + knowledge)

#### Tier 4: Edge cases and fallback (15+ entries)

- Pure LLM fallback: queries that match no skill ("explain the trolley problem", "write me a haiku about rain")
- Memory-dependent: queries that need `user_facts` or `social_context` to route correctly
- Ambiguous: queries where multiple capabilities could match ("what's playing" — music vs. movies vs. TV)
- Adversarial: prompt injection attempts, empty-after-normalization, emoji-only, extremely long input
- Course correction: "no I meant the other one", "actually never mind"

### Test runner

The existing parametrized runner at `tests/integration/test_v2_regression_prompts.py` already calls `run_pipeline_async()` per entry. Extend it to support the new `expect` fields:

- `capabilities` (list) — assert all listed capabilities appear in the routed chunks
- `chunk_count` — assert the splitter produced exactly N primary chunks
- `llm_used` + `llm_reason` — assert LLM fallback triggered (or didn't)
- `response_not_empty` — assert non-empty synthesis output
- `memory_slot_present` — assert a named slot was assembled (for memory-dependent cases)

### Naming convention (post-C13)

All fixture and test files will be promoted names (no `v2_` prefix):
- `tests/fixtures/regression_prompts.json`
- `tests/integration/test_regression_prompts.py`

---

## Execution Order

### Sub-session A: Refactor oversized files
1. Split `store.py` → 6 files
2. Split `pipeline.py` → 3 files
3. Split `reader.py` → 3 files
4. Split remaining oversized files
5. Fix oversized functions
6. Add LIMIT clauses to over-fetching queries
7. Eliminate slot assembly duplication
8. Run tests — all green, no behavior change

### Sub-session B: Corpus expansion
1. Add Tier 1 entries (single-capability) for all 58 uncovered capabilities
2. Add Tier 2 entries (two-capability compounds)
3. Add Tier 3 entries (complex multi-intent)
4. Add Tier 4 entries (edge cases, fallback, memory-dependent)
5. Extend test runner `expect` schema
6. Run full corpus — document any routing failures as known gaps for tuning

### Sub-session C: Integration + gate
1. Run full test suite — all green
2. Generate coverage report: capabilities hit, compound patterns, LLM paths
3. Update PROGRESS.md, IMPLEMENTATION_PLAN.md

---

## Gate Checklist

- [ ] Zero files over 300 lines in `lokidoki/orchestrator/` (post-promotion path)
- [ ] Zero functions over 40 lines
- [ ] All `SELECT` queries that return user data have a LIMIT (or explicit unbounded justification)
- [ ] No duplicated slot assembly logic
- [ ] Regression corpus >= 200 entries
- [ ] Every registered capability (87) has >= 1 corpus entry
- [ ] Compound tier: >= 20 two-capability, >= 15 three-or-more
- [ ] Edge tier: >= 5 pure-LLM fallback, >= 3 memory-dependent, >= 3 adversarial
- [ ] Test runner supports `capabilities` (list), `chunk_count`, `memory_slot_present` assertions
- [ ] All corpus entries pass (routing correct) or are documented as known tuning gaps
