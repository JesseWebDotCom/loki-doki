# LokiDoki v2 Graduation Plan

**Status:** Living document. Started 2026-04-11. Update as subsystems land.
**Audience:** future Claude sessions and the human picking up this work cold.
**Goal:** delete the v1 orchestrator and have one code path — v2 — serve every chat turn, **without** uncritically porting v1's worst habits.

> If `docs/spec.md` and this file conflict, this file wins for migration questions; `docs/spec.md` wins for product/architecture questions.

---

## 0. Why this document exists

The v2 prototype is functionally a superset of v1's skill catalog (99 capabilities vs ~36 v1 skills) and the dev tool already runs v2 end-to-end with a real LLM. The temptation is to "just flip the switch" by replacing the v1 orchestrator call in [lokidoki/api/routes/chat.py:82-104](../lokidoki/api/routes/chat.py#L82-L104) with `run_pipeline_async()`. **Don't.** v1 has accumulated several systems that are demonstrably broken or low-quality, and a blind cutover would carry that debt forward into v2 by default. We've already discovered three of these in two debugging sessions:

1. **Memory extraction over-fires.** The user reports that asking *"who is the current president"* causes the system to write a fact like *"user is the current president"* into long-term memory. v1's [decomposition prompt](../lokidoki/core/prompts/decomposition.py) has a one-line rule against this (Rule 11: *"Questions → zero items unless also asserting a fact"*), but the rule lives in a 4,637-char system prompt that a small local model frequently ignores. **The defect is structural, not prompt-tuning.**
2. **People resolution leaked test data.** Until 2026-04-11 the v2 dev tool resolved "my sister" to a hardcoded Star Wars character (`Leia`) because [v2/orchestrator/adapters/people_db.py](../v2/orchestrator/adapters/people_db.py)'s in-memory adapter defaulted to a seed roster. Now empty by default; real `LokiPeopleDBAdapter` not yet wired into the runtime pipeline.
3. **Router false-positives.** Until 2026-04-11 the v2 router committed to `lookup_person_birthday` for *"Maybe I'll take my sister to the movies"* because `ROUTE_FLOOR` was 0.45 and the cosine similarity scored 0.495 on a single shared bigram. Then the LLM combiner faithfully rendered the hallucinated birthday because the combine prompt told it to *"mention each successful chunk's result."*

These three defects share a single root cause: **v1 — and parts of v2 — encode safety rules as paragraphs in a prompt or as floats in a config, when the safer encoding is structural** (separate code paths, validated schemas, gated capabilities, deny-by-default defaults).

This plan exists so we don't accept that pattern. For every subsystem we touch on the way to graduation, we **research alternatives, bake them off against a corpus, and accept the winner only if it clears an explicit quality bar.**

---

## 1. Guiding principles

1. **Don't port v1 verbatim.** For each subsystem, ask: *"if I were building this from scratch today, knowing what we know, would I build it this way?"* If no, redesign.
2. **Structural over textual.** A behavior enforced by code or schema beats a behavior enforced by a prompt rule. A small model will obey a JSON schema; it will routinely violate a paragraph of English.
3. **Deny by default.** Empty rosters, missing data, unresolved references, low-confidence routes — all should *fail closed* (ask for clarification, return "missing", surface the unresolved marker) rather than fall through to a plausible-looking guess.
4. **Bake-off discipline.** No subsystem lands on `main` until at least two viable approaches have been measured against a fixed corpus on the dimensions that matter (correctness, latency, footprint). The existing [v2-llm-bakeoff-2026-04-11.md](benchmarks/v2-llm-bakeoff-2026-04-11.md) is the template.
5. **Every bug becomes a fixture.** When we fix a real bug, we add a row to [tests/fixtures/v2_regression_prompts.json](../tests/fixtures/v2_regression_prompts.json) so the corpus grows monotonically and the same bug can never re-ship.
6. **Phase gates are real.** Each subsystem section below has a **gate checklist**. We don't move to the next subsystem until the previous one's gate is green. This is the same rule [docs/PHASE_CURRENT.md](PHASE_CURRENT.md) enforces for product phases.
7. **Skills-first, LLM-last** (from CLAUDE.md). When choosing between an offline-first deterministic skill and a model call, the deterministic path wins on ties.
8. **Don't classify user intent with regex.** (CLAUDE.md hard rule.) The decomposer is a 2B local LLM; new branching needs new structured fields, not keyword lists.

---

## 2. Snapshot — where v2 is on 2026-04-11

### Entry points
| Surface | File:line | Today | After cutover |
|---|---|---|---|
| Real chat (frontend) | [lokidoki/api/routes/chat.py:82-104](../lokidoki/api/routes/chat.py#L82-L104) | builds v1 `Orchestrator`, streams SSE phase events | calls `run_pipeline_async`, streams equivalent events |
| Dev tool runner | [lokidoki/api/routes/dev.py:208-213](../lokidoki/api/routes/dev.py#L208-L213) | calls `run_pipeline_async` once | unchanged (becomes a thin wrapper) |
| Audio | [lokidoki/api/routes/audio.py](../lokidoki/api/routes/audio.py) | TTS only, no orchestration | unchanged (TTS is profile-locked to CPU) |
| Frontend chat client | [frontend/src/lib/api.ts:5](../frontend/src/lib/api.ts#L5) | hits `/api/v1/chat` | unchanged — endpoint URL stays, backend swaps |

### Pipeline (v2)
[v2/orchestrator/core/pipeline.py:35-213](../v2/orchestrator/core/pipeline.py#L35-L213) runs: normalize → signals → fast_lane → parse → split → extract → route → select_implementation → resolve → execute → request_spec → combine. LLM fallback is **live by default** in non-pytest processes per [v2/orchestrator/core/config.py:8-26](../v2/orchestrator/core/config.py#L8-L26). The dev tool trace the user shared on 2026-04-11 showed `qwen3:4b-instruct-2507-q4_K_M` actually being called.

### What v2 already does well
- 99-capability registry, superset of v1's skill catalog ([v2/data/function_registry.json](../v2/data/function_registry.json))
- Real LLM fallback wired ([v2/orchestrator/fallbacks/llm_fallback.py](../v2/orchestrator/fallbacks/llm_fallback.py))
- Per-step trace with timing ([v2/orchestrator/observability/tracing.py](../v2/orchestrator/observability/tracing.py)) — the dev tool already shows this
- Offline-first skills with mechanism chains ([v2/orchestrator/skills/](../v2/orchestrator/skills/))
- Hermetic test discipline (289 v2 tests passing, network-backed adapters faked in [tests/integration/conftest.py](../tests/integration/conftest.py))
- Empty-by-default people roster (as of 2026-04-11)

### What v2 is missing or stubbed
| Subsystem | State | Effect |
|---|---|---|
| Persona injection | missing | combine prompt has no character/behavior slot; v2 always sounds like a generic assistant |
| Conversation history | partial — request-context dict only | multi-turn is broken; no session-threaded memory reaches the resolver |
| Sentiment / short-term memory | missing | no `memory.get_sentiment()` call anywhere in v2 |
| Citation `[src:N]` markers | missing | `ResponseObject.sources` is never populated by skills |
| Clarification state machine | missing | "which theater?" follow-ups die after one turn |
| Humanization (tone/verbosity) | missing | always neutral |
| `LokiPeopleDBAdapter` wired | exists, not wired | resolver still uses empty in-memory `PeopleDBAdapter()` |
| `ConversationMemoryAdapter` backed by `MemoryProvider` | missing | only reads ephemeral request `context["recent_entities"]` |
| `HomeAssistantAdapter` backed by real HA | missing — `_DEFAULT_DEVICES` hardcoded | smart-home only resolves test devices |
| `MovieContextAdapter` persistence | missing | only reads ephemeral context |
| SSE streaming wrapper around `run_pipeline_async` | missing | `PipelineResult` is a single object; frontend expects progressive phase events |

### What v1 does that we explicitly do NOT want to port verbatim
The next section lists these as canonical bad behaviors with citations. The point of the migration is to fix them, not preserve them.

---

## 3. Quality bar — canonical bad behaviors and the bar we're aiming for

These are the failures we know about today. **Every one of them must be reproducible as a regression fixture before its subsystem section can be marked done.**

### 3.1 Memory: question-extracted-as-fact ("president" bug)
- **Symptom (user-reported, 2026-04-11):** asking "who is the current president" causes a fact like "user is the current president" to be saved to long-term memory.
- **v1 location:** call chain is [chat.py:96](../lokidoki/api/routes/chat.py#L96) → [orchestrator.py:635](../lokidoki/core/orchestrator.py#L635) → [decomposer.py:217](../lokidoki/core/decomposer.py#L217) → [orchestrator.py:739-760](../lokidoki/core/orchestrator.py#L739-L760) loops over `long_term_memory` items → [orchestrator_memory.py:116](../lokidoki/core/orchestrator_memory.py#L116) `persist_long_term_item()` writes to DB.
- **The "fix" v1 has:** Rule 11 in [decomposition.py:53](../lokidoki/core/prompts/decomposition.py#L53): *"Questions → zero items unless also asserting a fact."* And [decomposer.py:676-683](../lokidoki/core/decomposer.py#L676-L683) drops `long_term_memory` wholesale if every ask is a verbatim question lookup.
- **Why it still happens:** the rule is one line in a 4,637-char prompt and the small decomposer model ignores it on the wrong inputs. The post-hoc filter in [decomposer.py:676-683](../lokidoki/core/decomposer.py#L676-L683) only fires if **all** asks are question lookups; a single misclassified sub-clause defeats it.
- **The bar we want (v2):**
  - Memory write must require `kind=statement` AND `subject_type=self|named_person` AND a structural source signal (declarative clause from spaCy parse, not interrogative).
  - Memory write must be schema-validated by Pydantic *outside* the LLM, with reject-on-fail (no repair loop that "fixes" obviously-wrong items by lowering the bar).
  - Default: deny. Memory writes happen only when **all** structural conditions are met.
  - Acceptance test: a corpus of 50+ question utterances (from real WH-questions, polar questions, embedded questions, requests, commands) must produce **zero** memory writes.

### 3.2 People: in-memory seed roster leaked into production
- **Symptom (fixed 2026-04-11):** "Maybe I'll take my sister to the movies" → response *"Leia's birthday is June 12."*
- **Root cause:** [v2/orchestrator/adapters/people_db.py](../v2/orchestrator/adapters/people_db.py) defaulted to a Star Wars seed roster; [v2/orchestrator/resolution/resolver.py:35](../v2/orchestrator/resolution/resolver.py#L35) instantiated `PeopleDBAdapter()` with no arguments.
- **The bar we want:** in-memory adapter defaults to **empty**; the runtime resolver gets `LokiPeopleDBAdapter` constructed with the singleton `MemoryProvider` connection and the authenticated user id; tests inject seed via the conftest, not the production module.
- **Status:** half-done. Empty default + test fixture wiring landed 2026-04-11. The runtime swap is the next concrete task.

### 3.3 Routing: noise-floor cosine match committed to a skill
- **Symptom (fixed 2026-04-11):** the same "sister to the movies" utterance routed to `lookup_person_birthday` at confidence 0.495.
- **Root cause:** [v2/orchestrator/routing/router.py](../v2/orchestrator/routing/router.py) had `ROUTE_FLOOR = 0.45` while `CONFIG.route_confidence_threshold = 0.55`, creating a 0.10-wide band where the router would commit to a real skill but the LLM combiner was instructed to *"mention each successful chunk's result"* — including the bogus output.
- **The bar we want:** routing thresholds collapse to one number; `ROUTE_FLOOR == route_confidence_threshold`. Below it, the chunk becomes `direct_chat` and never reaches the people resolver, executor, or skill output. Above it, the LLM combine prompt is allowed to assume skill output is authoritative.
- **Status:** fixed (`ROUTE_FLOOR = 0.55`, regression fixture updated).

### 3.4 Synthesis: LLM is told to assume skill output is correct
- **Symptom:** even when the router was wrong, the combine prompt at [v2/orchestrator/fallbacks/prompts.py:63-78](../v2/orchestrator/fallbacks/prompts.py#L63-L78) told qwen3 to *"mention each successful chunk's result"* and *"use ONLY information present in the RequestSpec. Do not invent facts."* The model is being asked to repeat skill output uncritically.
- **The bar we want:** when synthesis assembles a final answer, the prompt distinguishes **high-confidence skill output** (`confidence >= threshold` AND structural resolver source like `people_db`/`home_assistant` — pass through) from **borderline skill output** (`low_confidence` reason — synthesize but allow disagreement, or fall through to direct_chat). The combine prompt must cite **what** to trust, not just *that* the spec exists.

### 3.5 Prompts: 4,637-char decomposition prompt as the policy layer
- **v1 location:** [lokidoki/core/prompts/decomposition.py](../lokidoki/core/prompts/decomposition.py) is 4,637 characters of subject types, kinds, rules, and worked examples. CLAUDE.md has an entire **Prompt Budget Discipline** section to keep this under 8,000 chars.
- **Why this is fragile:** the size budget exists *because* the small decomposer model degrades as the prompt grows. But every behavior we want — extraction rules, ambiguity handling, complexity classification, sentiment — has been encoded as a paragraph in this prompt. **Adding any new behavior costs latency on every turn forever.**
- **The bar we want:** structural fields in the JSON schema beat prompt rules. If we want a new branching signal, we add a new schema field and a new derive-in-Python function, not a new English paragraph.

### 3.6 Performance: no aggregate latency budget
- **v1 has individual constants:** `decomposer.py:207` 20s timeout; `orchestrator.py:87` `SYNTHESIS_NUM_PREDICT=384`; `orchestrator.py:94` `ACKNOWLEDGMENT_NUM_PREDICT=110`; `orchestrator.py:98` `TRIVIAL_QUERY_CHAR_LIMIT=120`. **No total-pipeline budget, no per-step ceiling enforced in tests.**
- **v2 has the right shape:** [tests/fixtures/v2_regression_prompts.json](../tests/fixtures/v2_regression_prompts.json) supports per-fixture `max_step_ms` and `max_total_ms`. We just need to populate them honestly.
- **The bar we want:** every fixture in the regression corpus declares a `max_total_ms`. Cold-start excluded (warmed pipeline, per [tests/integration/test_v2_regression_prompts.py:52-63](../tests/integration/test_v2_regression_prompts.py#L52-L63)). The test fails on regressions, not just on incorrectness.

---

## 4. Subsystem migration plan

Each subsystem below has the same shape so any session can pick one up and work on it independently:

> **Status** • **Current v1 implementation** • **Why it's bad** • **What v2 has today** • **Research questions** • **Candidate approaches** • **Bake-off methodology** • **Test fixtures** • **Acceptance criteria (Phase Gate)**

Subsystems are listed in roughly the order they should be tackled, but the order is **not strict** — any can be done in parallel as long as the gate criteria are honored.

---

### 4.A Memory write-side (fact extraction)

**Status:** v2 has nothing here. v1 has the "president" bug. **This is the highest-priority subsystem because it's the most user-visible and most-broken.**

**Current v1 implementation**
- Decomposer LLM emits a `long_term_memory` array as part of its JSON response ([decomposer.py:99-188](../lokidoki/core/decomposer.py#L99-L188) `DECOMPOSITION_SCHEMA`).
- [orchestrator.py:739-760](../lokidoki/core/orchestrator.py#L739-L760) loops over each item and calls `persist_long_term_item()` from [orchestrator_memory.py:116](../lokidoki/core/orchestrator_memory.py#L116).
- Validation happens via Pydantic in [decomposer_repair.py:1-46](../lokidoki/core/decomposer_repair.py#L1-L46) with up to `MAX_REPAIRS = 2` retries.
- The "no extraction from questions" rule lives in [decomposition.py:53](../lokidoki/core/prompts/decomposition.py#L53) as a single line of English.

**Why it's bad**
- The whole policy lives in a prompt, not in code. The model is the gatekeeper.
- The repair loop "fixes" malformed items by retrying, which masks the underlying problem (the prompt is too long for the model to follow reliably).
- No structural signal from the parse tree is used. spaCy already tells us the sentence is interrogative; we discard that.
- The "drop wholesale if all asks are question lookups" filter at [decomposer.py:676-683](../lokidoki/core/decomposer.py#L676-L683) is all-or-nothing — one misclassified sub-clause and the safety net fails.

**What v2 has today**
Nothing. The v2 pipeline does not call any memory persistence. This is actually an opportunity: we get to design the memory write-side from scratch.

**Research questions**
1. What signals (besides decomposer output) reliably indicate "the user just stated a fact about themselves or someone they know"?
2. Should memory writes happen on every turn (current v1) or only on turns flagged by an explicit code path?
3. What's the right granularity? `(subject, predicate, object)` triples? Free-text claims with an embedding? Both?
4. How do we handle contradiction with prior memory? (v1 has `lokidoki/core/memory_contradiction.py` — port intent, not code.)
5. How do we represent confidence in a stored memory? (Source: structural signal vs LLM-only.)
6. What's the retention / decay policy? (Today: forever, no decay.)

**Candidate approaches** (build at least 2 to bake off)
1. **Dual-signal gate.** Store only when (a) decomposer emits a `long_term_memory` item AND (b) the chunk's spaCy parse is declarative AND (c) the subject is `self` or a resolved person from `LokiPeopleDBAdapter`. All three required. Default: deny.
2. **Structural extraction without LLM.** Parse the chunk with spaCy, look for `nsubj=PRP$(my)/PRP(I)` + `cop`/`acl` patterns ("I am X", "my Y is Z", "I have a Z"), produce a triple. No LLM in the write path. Faster, more predictable, lower coverage.
3. **Two-stage LLM with separate verifier model.** Decomposer proposes; a second tiny model (or same model with a different prompt) verifies "is this a fact the user explicitly stated?" Reject on "no". Costs an extra model call per turn.
4. **Embedding similarity to a "fact-shaped" exemplar bank.** A bank of 100 hand-curated declarative statements; new candidates must cosine-match above a threshold to be stored.

**Bake-off methodology**
- Build a corpus at `tests/fixtures/v2_memory_extraction_corpus.json` with three buckets: ~50 *should-extract* statements, ~50 *should-not-extract* questions/commands/jokes/hypotheticals, ~20 *ambiguous* (e.g., "I think the president is …" — opinion vs claim).
- Run each candidate approach on the corpus.
- Measure: **precision** (of writes, what fraction were correct), **recall** (of true facts, what fraction got written), **latency added per turn**, **bytes added to context** (for approach 1, this is decomposer prompt growth).
- Target: precision >= 0.98 (false positives are the user-visible disaster), recall >= 0.70, latency < 50ms per turn for approach 1/2, < 250ms for approach 3.

**Test fixtures**
- `tests/fixtures/v2_memory_extraction_corpus.json` — new file; the canonical bake-off corpus.
- Add a regression case to [v2_regression_prompts.json](../tests/fixtures/v2_regression_prompts.json) that asserts "who is the current president" produces zero memory writes.

**Phase Gate (must all be true to mark this section done)**
- [ ] At least two approaches implemented and benched on the corpus.
- [ ] Winner has precision >= 0.98 on the should-not-extract bucket.
- [ ] Regression fixture for the "president" bug exists and passes.
- [ ] No memory writes happen on direct_chat-routed chunks (defense in depth).
- [ ] Bake-off doc published at `docs/benchmarks/v2-memory-write-bakeoff-YYYY-MM-DD.md` with raw numbers.

---

### 4.B Memory read-side (retrieval and use)

**Status:** v2 has nothing. v1 has a sophisticated retrieval pipeline that may or may not be worth porting.

**Current v1 implementation**
- [lokidoki/core/memory_provider.py](../lokidoki/core/memory_provider.py) holds the SQLite connection.
- Retrieval scoring lives in `tests/unit/test_phase4_retrieval_scoring.py` (suggesting there's a real implementation under `lokidoki/core/`).
- Embeddings via `lokidoki/core/embedder.py`.
- Reranker tested in `tests/unit/test_phase7_reranker.py`.

**Why it might be bad**
- We don't actually know if it's bad yet — the user has not reported a retrieval-quality bug. But: if the write-side is broken, the read-side returns garbage faithfully. Fixing 4.A first is correct.
- v1's retrieval was tuned for a specific decomposer + synthesizer pair. v2's pair (or whatever wins the prompts bake-off in 4.C) may want different tradeoffs.

**What v2 has today**
Nothing. `ConversationMemoryAdapter` only reads from request `context["recent_entities"]` — a single dict the caller passes in. There's no SQL fetch.

**Research questions**
1. Does v1's retrieval actually help final response quality, or is it noise? (Need a controlled experiment: v2 with retrieval vs v2 without, on a quality corpus.)
2. What's the right retrieval surface — top-k facts, a per-session episodic timeline, or both?
3. How do we score "useful" retrieval? (User-blind eval, or thumbs-up signal from the dev tool, or a held-out QA corpus.)
4. Is rerank pulling its weight?
5. Can we get away with a flat-text scratch pad per session and skip vectors entirely for most turns?

**Candidate approaches**
1. **Port v1 unchanged.** Cheapest. Carries forward whatever's broken about it.
2. **Port v1's writer, replace retrieval with sqlite-FTS keyword search + recency bias.** No vectors. See if it's good enough.
3. **Sqlite-vec everywhere, no rerank.** Eliminate the rerank model.
4. **Hybrid: FTS for recall, embedding rerank for precision.** Standard hybrid retrieval.

**Bake-off methodology**
- Build `tests/fixtures/v2_memory_recall_corpus.json` — multi-turn dialogues where turn N's correct answer requires recalling turn 1-3's context.
- Run each candidate; measure recall@k, response correctness (LLM-judged), p95 latency.

**Test fixtures**
- New: `tests/fixtures/v2_memory_recall_corpus.json`.

**Phase Gate**
- [ ] 4.A is done first (no point retrieving garbage).
- [ ] At least two approaches benched.
- [ ] Winner is no worse than v1 on a held-out multi-turn corpus.
- [ ] p95 retrieval latency < 100ms.

---

### 4.C Prompts and decomposer

**Status:** v2 has its own decomposer prompts under [v2/orchestrator/fallbacks/prompts.py](../v2/orchestrator/fallbacks/prompts.py) and a separate budget discipline in CLAUDE.md. v1's prompts are larger and load-bearing.

**Current v1 implementation**
- [lokidoki/core/prompts/decomposition.py](../lokidoki/core/prompts/decomposition.py) — 4,637 chars, 118 lines, mostly rules and worked examples.
- [lokidoki/core/decomposer.py:99-188](../lokidoki/core/decomposer.py#L99-L188) — `DECOMPOSITION_SCHEMA`.
- Default model `gemma4:e4b` per [decomposer.py:206](../lokidoki/core/decomposer.py#L206). 20s timeout.
- Repair loop with `MAX_REPAIRS = 2`.

**Why it's bad**
- See section 3.5. Every behavior is encoded as English; budget is exhausted.
- The repair loop is a smell — if the model can't produce valid JSON the first time, the prompt is wrong, not the model.
- v2 has already won part of this battle: [v2/orchestrator/fallbacks/prompts.py](../v2/orchestrator/fallbacks/prompts.py) has four short, single-purpose templates (split, resolve, combine, direct_chat) instead of one mega-prompt.

**What v2 has today**
- 4 small templates, ~80-200 chars each.
- A real prompt-budget test (CLAUDE.md mandates one in `tests/unit/test_decomposer.py`; check v2 has the equivalent).
- Strict slot validation in [render_prompt](../v2/orchestrator/fallbacks/prompts.py#L118).

**Research questions**
1. Can v2 do without a decomposer entirely? The pipeline already does normalize → parse → split → extract → route deterministically. Where does an LLM decomposer earn its place?
2. If a decomposer is needed, what's the smallest model that gets it right? (qwen3:0.6b? gemma3:270m? phi3-mini?)
3. What's the right schema — fewer fields and more derivation-in-Python, or more fields and less code?
4. Constrained decoding (Outlines, llama.cpp grammars) vs prompt-only — does it actually help on the model we pick?

**Candidate approaches**
1. **No LLM decomposer.** spaCy parse + deterministic clause splitter + rule-based ask-shape detection. Already half-built in [v2/orchestrator/pipeline/splitter.py](../v2/orchestrator/pipeline/splitter.py).
2. **Tiny decomposer + structural signals.** Use a 270M-parameter model with a 500-char prompt; combine output with spaCy parse-tree features in Python.
3. **Mid-size decomposer with constrained decoding.** qwen3:1.5b + grammar-enforced JSON output; no repair loop because output is structurally guaranteed.

**Bake-off methodology**
- Use the existing 84-prompt corpus from [docs/benchmarks/v2-llm-bakeoff-2026-04-11.md](benchmarks/v2-llm-bakeoff-2026-04-11.md).
- For each approach: measure decomposer output validity (does it parse?), pipeline correctness (does the right capability fire?), per-turn latency, RAM footprint.
- Target: p95 decompose latency < 300ms warm; pipeline correctness >= v1 baseline.

**Test fixtures**
- Reuse [tests/fixtures/v2_regression_prompts.json](../tests/fixtures/v2_regression_prompts.json).
- Add a `tests/unit/test_v2_decomposer_budget.py` enforcing prompt char ceilings.

**Phase Gate**
- [ ] 2+ approaches benched on the 84-prompt corpus.
- [ ] Winner has p95 decompose latency < 300ms warm.
- [ ] Total prompt budget for the winner stays under **2,000 chars** (v2 should be aggressively smaller than v1's 4,637 + budget ceiling 8,000).
- [ ] Repair loop is either deleted or proven necessary by evidence.

---

### 4.D People resolution

**Status:** half-done. Empty default + test fixture isolation landed 2026-04-11. Runtime swap pending.

**Current v1 implementation**
- [orchestrator_memory.py:71-113](../lokidoki/core/orchestrator_memory.py#L71-L113) `_resolve_person()` scores by recent co-occurrence + relationship match + recency tiebreaker. `DISAMBIG_MARGIN = 1.0` ([orchestrator_memory.py:30](../lokidoki/core/orchestrator_memory.py#L30)).
- Schema in [people_graph_sql.py:20-40](../lokidoki/core/people_graph_sql.py#L20-L40): `people` table with overlays and relationship edges.
- No fuzzy match on names — exact lookup only.

**Why it's not great**
- Exact-match-only fails on common typos and informal names.
- The disambig margin is a magic number with no published bake-off behind it.
- Score weights are hand-tuned constants (`* 0.5`, `+ 3.0`, `* 0.001`) with no test corpus.

**What v2 has today**
- [v2/orchestrator/adapters/loki_people_db.py](../v2/orchestrator/adapters/loki_people_db.py) — read-only adapter against the same SQLite tables, with rapidfuzz fuzzy fallback. **Has tests, isn't wired into the runtime resolver.**
- [v2/orchestrator/adapters/people_db.py](../v2/orchestrator/adapters/people_db.py) — in-memory adapter, now empty by default.
- [v2/orchestrator/resolution/people_resolver.py](../v2/orchestrator/resolution/people_resolver.py) — gates on `PEOPLE_CAPABILITIES` set; collects mentions from spaCy entities + family-relation tokens.

**Research questions**
1. Is the v1 score formula actually correct? Bake it off against rapidfuzz alone and a learned scorer.
2. What's the right default for `DISAMBIG_MARGIN`?
3. Should we resolve people on **every** chunk, or only when the route is in `PEOPLE_CAPABILITIES`? (Current v2 is the latter — defensible.)
4. How do we handle "Steve" when there are 5 Steves in the user's people graph? Today: ambiguous flag → LLM clarification. Is that the right UX?

**Candidate approaches**
1. **Wire `LokiPeopleDBAdapter` as-is, port v1 score formula on top.** Smallest change.
2. **`LokiPeopleDBAdapter` + rapidfuzz only, no recency bias.** Simpler, possibly better for users with a small graph.
3. **`LokiPeopleDBAdapter` + recency-weighted rapidfuzz hybrid.** Best of both.

**Bake-off methodology**
- Corpus: `tests/fixtures/v2_people_resolution_corpus.json` — utterances paired with expected `(person_id, ambiguous?)`. Include common typos, family relations, partial names, last-name-only, full names with multiple matches.
- Measure: top-1 accuracy, top-3 accuracy, ambiguous-correctly-flagged rate, p95 latency.

**Test fixtures**
- New: `tests/fixtures/v2_people_resolution_corpus.json`.
- Existing: tests in [tests/unit/test_v2_resolvers.py](../tests/unit/test_v2_resolvers.py) and [tests/unit/test_v2_loki_adapters.py](../tests/unit/test_v2_loki_adapters.py).

**Phase Gate**
- [ ] `LokiPeopleDBAdapter` instantiated by [v2/orchestrator/resolution/resolver.py:35](../v2/orchestrator/resolution/resolver.py#L35) in the runtime path with the singleton `MemoryProvider` connection and the authenticated viewer's user_id.
- [ ] Plumbing path: `MemoryProvider` + `viewer_user_id` reach `resolve_chunks` via the `context` dict (cleanest hook today).
- [ ] Top-1 accuracy >= 0.90 on the resolution corpus.
- [ ] No regression in [tests/unit/test_v2_resolvers.py](../tests/unit/test_v2_resolvers.py).
- [ ] Empty-default guard test still passes.

---

### 4.E Conversation context and multi-turn memory

**Status:** v2 has the `ConversationMemoryAdapter` but it only reads ephemeral context dicts. Real multi-turn is broken.

**Current v1 implementation**
- `MemoryProvider` fetches session messages and recent extracted facts; the orchestrator passes them into the synthesis prompt.

**Why it's bad**
- Session memory is fetched on every turn whether the turn needs it or not (latency tax).
- No structured "what did the user just ask about?" handoff between turns — the synthesis prompt gets a blob of recent text and is expected to figure it out.

**What v2 has today**
- [v2/orchestrator/adapters/conversation_memory.py](../v2/orchestrator/adapters/conversation_memory.py) — reads `context["recent_entities"]`, that's it.
- [v2/orchestrator/resolution/pronoun_resolver.py](../v2/orchestrator/resolution/pronoun_resolver.py) — uses the conversation memory adapter to resolve "it"/"that" against the most recent entity of the right type.

**Research questions**
1. Should context retrieval be eager (always fetch on every turn) or lazy (only when the resolver flags an unresolved pronoun/reference)?
2. What's the smallest unit of "conversation state" that matters? Last entity per type? Last 3 turns of raw text? A structured topic graph?
3. How do we age out stale context? (User asks about a movie, then 5 turns later the movie context should not still bleed into pronoun resolution.)

**Candidate approaches**
1. **Eager fetch, full session.** Simplest. Maximum latency, maximum recall.
2. **Lazy fetch, only on unresolved-marker.** Cheapest. May miss context the resolver didn't know to ask for.
3. **Structured per-type recency map.** Each turn updates `last_seen[type] = entity`. Resolver consults the map. No embedding, no SQL on the hot path.

**Bake-off methodology**
- Multi-turn corpus same as 4.B.
- Measure pronoun resolution accuracy + total turn latency for each approach.

**Test fixtures**
- Reuse `tests/fixtures/v2_memory_recall_corpus.json` from 4.B.

**Phase Gate**
- [ ] Pronoun resolution accuracy on the multi-turn corpus >= 0.85.
- [ ] No more than +50ms p95 added to turn latency.
- [ ] Stale-context decay verified (turn-distance test).

---

### 4.F Persona injection

**Status:** v2 has nothing. v1 wires `behavior_prompt` and `character_name` from [chat.py:73-91](../lokidoki/api/routes/chat.py#L73-L91).

**Current v1 implementation**
- [chat.py:73-77](../lokidoki/api/routes/chat.py#L73-L77) fetches the active character via `character_ops.get_active_character_for_user`.
- `behavior_prompt` is injected into the orchestrator constructor and reaches the synthesis tier only — never the decomposer (per [docs/CHARACTER_SYSTEM.md](CHARACTER_SYSTEM.md) §2.3).

**Why it's not bad, but not in v2**
- The contract is sound: persona is a synthesis-tier concern, not a routing concern. v2 just hasn't wired the slot.

**What v2 has today**
- Nothing. The combine prompt has no `{character_name}` or `{behavior_prompt}` slot.

**Research questions**
1. Does a persona prompt change response quality on factual questions, or only on conversational tone? (Bake-off on a tone-sensitive corpus vs a fact-sensitive corpus.)
2. What's the right shape for the slot — full free-text (v1 today), or structured (`tone=warm, formality=low, verbosity=brief`)?

**Candidate approaches**
1. **Verbatim port.** Free-text persona slot in the combine + direct_chat templates.
2. **Structured persona descriptors.** A small dataclass; the prompt template fills in 3-5 specific tags.
3. **Two-prompt variant.** A short "persona system message" prepended to all synthesis calls; the combine prompt itself stays neutral.

**Bake-off methodology**
- Build `tests/fixtures/v2_persona_corpus.json` — pairs of `(utterance, expected_tone)`. LLM-judged.
- Measure: tone match rate per persona, factual accuracy held constant.

**Test fixtures**
- `tests/fixtures/v2_persona_corpus.json` (new).
- Wire `character_name` + `behavior_prompt` into `run_pipeline_async` via `context`.

**Phase Gate**
- [ ] Persona slot in combine + direct_chat templates.
- [ ] Persona never reaches the decomposer (test that asserts this).
- [ ] Tone match rate >= 0.80 on the persona corpus.

---

### 4.G Citations and sources

**Status:** v2 has nothing. v1 sanitizes `[src:N]` markers in synthesis output ([orchestrator.py:1497-1511](../lokidoki/core/orchestrator.py#L1497-L1511)).

**Current v1 implementation**
- Skill executions populate a `sources` list; synthesis is told to cite with `[src:N]`; a sanitization pass strips/fixes malformed citations.

**Why it's bad**
- Sanitization is a band-aid for the model emitting wrong citations. The structural fix is to constrain output (citations as a JSON field, not inline tokens).

**What v2 has today**
- `ResponseObject` already has the shape but no skills populate `sources`.
- No citation sanitization in the combine prompt.

**Research questions**
1. Inline `[src:N]` (v1 style) vs structured citations (`response.sources: [{title, url}]`)?
2. Do users actually look at citations, or do they just want the answer? (UX research, not technical.)
3. For non-web skills (e.g., calendar lookup), what *is* a source?

**Candidate approaches**
1. **Inline markers, post-hoc sanitize.** Port v1.
2. **Structured `sources` list, frontend renders.** Cleaner; no model citation discipline needed.
3. **Both** — inline markers for the LLM to anchor reasoning, structured list for the frontend to render.

**Bake-off methodology**
- Citation accuracy on a fact-corpus where the right answer requires citing the source skill. LLM-judged.
- Frontend usability test (manual).

**Test fixtures**
- New: `tests/fixtures/v2_citations_corpus.json`.

**Phase Gate**
- [ ] Skills populate `ResponseObject.sources` reliably.
- [ ] Citation accuracy on the corpus >= 0.95 (citations point to the right source).
- [ ] Frontend renders sources.

---

### 4.H Synthesis (combine prompt + LLM call)

**Status:** v2 has a working LLM combine path but the prompt encourages parroting skill output uncritically (see 3.4).

**Current v1 implementation**
- `lokidoki/core/orchestrator.py` synthesis tier with model selection (`SYNTHESIS_NUM_PREDICT=384`, `ACKNOWLEDGMENT_NUM_PREDICT=110`, `TRIVIAL_QUERY_CHAR_LIMIT=120`).
- Humanization planner.
- Sanitization for citations.

**Why it might be bad**
- Multiple model calls per turn for trivial queries — short-circuits help, but the budget machinery is complex.
- No structured "I don't know" path; the model has to phrase refusals on its own.

**What v2 has today**
- Single LLM call in the combine path.
- Direct-chat path bypasses the spec entirely (good).
- `llm_num_predict = 256` cap, `llm_temperature = 0.2` ([config.py:104](../v2/orchestrator/core/config.py#L104)).

**Research questions**
1. Should the combine prompt include skill confidence so the model can disagree with low-confidence routes?
2. What's the right `num_predict` for each path (short ack vs long synthesis)?
3. Should we have a "verifier" pass that checks response against the spec post-hoc?

**Candidate approaches**
1. **Single combine prompt, current v2.** Status quo.
2. **Confidence-aware combine prompt.** Pass `chunk.confidence` + `chunk.source` to the prompt; rules on when to trust.
3. **Two-pass: synthesize → verify → re-synthesize on disagreement.** Costs 2x latency, may improve quality.

**Bake-off methodology**
- Reuse the 84-prompt corpus.
- Add a "no-hallucination" sub-corpus where the right answer is "I don't know."
- LLM-judged response correctness + hallucination rate.

**Phase Gate**
- [ ] Hallucination rate on the no-hallucination corpus < 0.05.
- [ ] Combine prompt does not tell the model to "mention each successful chunk's result" verbatim.

---

### 4.I Smart-home and device adapters

**Status:** v2 has `_DEFAULT_DEVICES` hardcoded in [home_assistant.py](../v2/orchestrator/adapters/home_assistant.py); `LokiSmartHomeAdapter` reads `data/smarthome_state.json`.

**Lower priority** — the user has not flagged this. Schedule after the conversational subsystems (4.A through 4.H).

**Phase Gate**
- [ ] Hardcoded defaults removed; same empty-default treatment as `PeopleDBAdapter`.
- [ ] At least one real adapter (file-backed or HA-API-backed) wired into the runtime.

---

### 4.J SSE streaming wrapper

**Status:** v2 returns a single `PipelineResult`. Frontend expects progressive SSE events.

**Why it matters**
- Without a streaming wrapper, the cutover at [chat.py:82-104](../lokidoki/api/routes/chat.py#L82-L104) breaks the frontend's UX (no "thinking" indicator).

**Approach**
- Wrap `run_pipeline_async` in an async generator that yields trace events as they're produced.
- Reuse the existing `trace.timed()` callbacks in [v2/orchestrator/observability/tracing.py](../v2/orchestrator/observability/tracing.py).
- Map v2 phase names to v1 SSE event shapes for frontend compatibility.

**Phase Gate**
- [ ] Frontend receives at least normalize/route/synthesis phase events.
- [ ] SSE error path returns a graceful event, matching v1's [chat.py:105-128](../lokidoki/api/routes/chat.py#L105-L128).

---

## 5. Cross-cutting concerns

### 5.1 Bake-off harness
We need a single CLI script that runs a candidate approach against a corpus and emits a JSON report. Template lives at [scripts/bench_v2_llm_models.py](../scripts/bench_v2_llm_models.py) (used for the qwen3 bake-off). Generalize:

```
scripts/bench_v2_subsystem.py --subsystem memory --approach dual_signal --corpus tests/fixtures/v2_memory_extraction_corpus.json --out docs/benchmarks/...
```

Each subsystem section above implies one corpus + one bench script. Build them lazily (only when the subsystem is being worked on) but in a consistent shape.

### 5.2 Regression suite growth
**Hard rule:** every bug fixed during graduation work adds at least one row to [tests/fixtures/v2_regression_prompts.json](../tests/fixtures/v2_regression_prompts.json) **before** the fix lands. The router floor bug (3.3) and the people leak (3.2) already follow this rule.

### 5.3 Performance budgets
Every fixture in the regression corpus must declare `max_total_ms`. Targets:
- Trivial / fast-lane responses: 200ms
- Skill-served responses: 500ms
- LLM-fallback responses: 2000ms (warm), 5000ms (cold-start excluded)

The cold/warm split is already enforced by [tests/integration/test_v2_regression_prompts.py:52-63](../tests/integration/test_v2_regression_prompts.py#L52-L63).

### 5.4 Observability
The dev tool trace ([lokidoki/api/routes/dev.py:208-213](../lokidoki/api/routes/dev.py#L208-L213)) is the most valuable debugging surface in the project. **Do not let it rot during the migration.** Every new step in the pipeline must emit a trace event. Every adapter wired-up must surface its data source on the trace.

### 5.5 Honest dev tool status page
[lokidoki/api/routes/dev.py:56](../lokidoki/api/routes/dev.py#L56) currently claims *"All six v2 phases shipped."* This is not true if you count persona, sentiment, citations, conversation history, and clarification. Update this string at the end of every subsystem so the page reflects reality.

---

## 6. Cutover order (depends-on graph)

```
4.D People (wire LokiPeopleDBAdapter)
   └── unblocks: realistic 4.E Conversation context (since both share the MemoryProvider plumbing)

4.A Memory write-side (president bug fix)
   └── unblocks: 4.B Memory read-side (no point retrieving garbage)

4.C Prompts/decomposer
   └── independent; do in parallel

4.F Persona, 4.G Citations, 4.H Synthesis
   └── all touch the combine prompt; sequence them so they don't merge-conflict

4.I Smart-home
   └── independent; defer until conversational subsystems are done

4.J SSE streaming wrapper
   └── must land BEFORE the chat.py cutover or the frontend UX regresses

CUTOVER (chat.py:82-104)
   └── Final step. Do not flip until everything above this line has a green Phase Gate.

DELETE v1 (lokidoki/core/orchestrator.py and friends)
   └── Last. Open a separate PR. ~1784 LOC delete + test cleanup.
```

Critical path: **4.D → 4.A → 4.B → 4.J → cutover.** Everything else is parallelizable.

---

## 7. Graduation gate (the "v2 IS the app" criteria)

We can delete v1 when **all** of these are true:

1. Every subsystem section above has a green Phase Gate.
2. The frontend chat hits `run_pipeline_async` via [chat.py:82-104](../lokidoki/api/routes/chat.py#L82-L104) and receives streaming SSE events that match or exceed v1's event shape.
3. The regression corpus has at least 150 entries (current count: ~50). Every canonical bad behavior in §3 is reproduced and asserted-against.
4. p95 warm pipeline latency on the regression corpus is at most 1.2x the v1 baseline, or **better** by some honest measurement.
5. The dev tool status page in [dev.py:56](../lokidoki/api/routes/dev.py#L56) describes v2 honestly and no longer references v1 internals.
6. `lokidoki/core/orchestrator.py` is deleted in a separate, reviewable PR. The PR description links to the bake-off docs that justify each subsystem's approach.
7. No skill in [lokidoki/skills/](../lokidoki/skills/) is referenced by any non-test code. The directory is deleted in the same PR.

---

## 8. Open questions parked for later sessions

- **Whisper / openWakeWord / Piper** — none of these touch the LLM pipeline today. They will eventually need to plug into v2's pipeline (so the wake-word can hand off to the orchestrator). Out of scope for this plan; revisit after graduation.
- **Hailo on `pi_hailo` profile** — same. The v2 LLM fallback already calls Ollama; if Ollama is hailo-backed, no change is needed.
- **`loki-doki-plugins` / `loki-doki-personas`** — three-repo split is preserved. Plugins eventually register v2 capabilities through `function_registry.json`. Personas eventually register `behavior_prompt` content. Both are post-graduation work.
- **Memory contradiction handling** — v1 has `lokidoki/core/memory_contradiction.py`. Port the *intent* (don't store contradictory facts) but the implementation should be designed fresh once 4.A lands.
- **Admin-only `/v2/run` becoming the live path** — once cutover happens, the dev tool's `/v2/*` routes either become the production path (rename them) or stay admin-only as a debugging surface. Decision deferred.

---

## 9. Index of key files (cheat sheet for cold-start sessions)

### v2 (the destination)
| File | What it does |
|---|---|
| [v2/orchestrator/core/pipeline.py](../v2/orchestrator/core/pipeline.py) | Top-level `run_pipeline_async` |
| [v2/orchestrator/core/config.py](../v2/orchestrator/core/config.py) | All thresholds, model tags, feature flags |
| [v2/orchestrator/routing/router.py](../v2/orchestrator/routing/router.py) | Cosine similarity router; `ROUTE_FLOOR = 0.55` |
| [v2/orchestrator/resolution/resolver.py](../v2/orchestrator/resolution/resolver.py) | People/device/media/pronoun dispatcher |
| [v2/orchestrator/resolution/people_resolver.py](../v2/orchestrator/resolution/people_resolver.py) | People resolver, gated on `PEOPLE_CAPABILITIES` |
| [v2/orchestrator/adapters/people_db.py](../v2/orchestrator/adapters/people_db.py) | In-memory adapter, **empty by default** |
| [v2/orchestrator/adapters/loki_people_db.py](../v2/orchestrator/adapters/loki_people_db.py) | SQLite-backed adapter, **not wired** |
| [v2/orchestrator/execution/executor.py](../v2/orchestrator/execution/executor.py) | Handler registry, capability dispatch |
| [v2/orchestrator/fallbacks/llm_fallback.py](../v2/orchestrator/fallbacks/llm_fallback.py) | `decide_llm`, `_call_real_llm`, stub fallback |
| [v2/orchestrator/fallbacks/prompts.py](../v2/orchestrator/fallbacks/prompts.py) | All v2 prompt templates |
| [v2/data/function_registry.json](../v2/data/function_registry.json) | The capability catalog |

### v1 (the source / what's being audited or replaced)
| File | What it does |
|---|---|
| [lokidoki/api/routes/chat.py](../lokidoki/api/routes/chat.py) | The chat endpoint — cutover site |
| [lokidoki/core/orchestrator.py](../lokidoki/core/orchestrator.py) | v1 orchestrator (~1784 LOC, deletion target) |
| [lokidoki/core/decomposer.py](../lokidoki/core/decomposer.py) | v1 decomposer + repair loop |
| [lokidoki/core/prompts/decomposition.py](../lokidoki/core/prompts/decomposition.py) | The 4,637-char prompt under the budget cap |
| [lokidoki/core/orchestrator_memory.py](../lokidoki/core/orchestrator_memory.py) | Memory persistence + person resolution scoring |
| [lokidoki/core/memory_provider.py](../lokidoki/core/memory_provider.py) | Singleton SQLite wrapper |
| [lokidoki/core/memory_singleton.py](../lokidoki/core/memory_singleton.py) | Process-wide `MemoryProvider` getter |
| [lokidoki/core/people_graph_sql.py](../lokidoki/core/people_graph_sql.py) | People schema |
| [lokidoki/skills/](../lokidoki/skills/) | v1 skill directory (deletion target) |

### Tests and fixtures
| File | What it does |
|---|---|
| [tests/fixtures/v2_regression_prompts.json](../tests/fixtures/v2_regression_prompts.json) | The growing regression corpus |
| [tests/integration/test_v2_regression_prompts.py](../tests/integration/test_v2_regression_prompts.py) | The runner; supports per-fixture latency budgets |
| [tests/integration/conftest.py](../tests/integration/conftest.py) | Skill stub fakes + people-DB seed injection |
| [tests/fixtures/v2_seed_people.py](../tests/fixtures/v2_seed_people.py) | Star Wars seed roster (test-only) |
| [tests/unit/test_v2_resolvers.py](../tests/unit/test_v2_resolvers.py) | Resolver unit tests |
| [docs/benchmarks/v2-llm-bakeoff-2026-04-11.md](benchmarks/v2-llm-bakeoff-2026-04-11.md) | Template bake-off doc |

---

## 10. Changelog for this document

| Date | Change | By |
|---|---|---|
| 2026-04-11 | Initial draft. Captures router floor fix, people-DB empty-default fix, "president" memory bug as a documented defect, and the full subsystem plan. | Claude (session with Jesse) |
