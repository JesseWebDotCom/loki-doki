# Pipeline Latency Analysis — 2026-04-10

## The Problem

Even "hi" takes **25s end-to-end**:

| Query | Decompose | Route | Synthesize | Total |
|-------|-----------|-------|------------|-------|
| "hi" | 18.2s | <1ms | 6.76s | **25.0s** |
| "what is nintendo" | 20.0s | <1ms | 11.8s | **31.8s** |

Both queries use the **same model** (`gemma4:e4b`) for both decomposition and synthesis. No model switching occurs — `effective_complexity` is "fast" for both, and `ModelPolicy.select("fast")` returns `gemma4:e4b` for both phases. This was confirmed via trace data (`decomp model: gemma4:e4b`) and code inspection (orchestrator line 1276–1280: inputs under 120 chars force "fast").

18 seconds to classify "hi" as a greeting is not a performance issue — it's a fundamental architecture problem. The decomposer is doing heavy LLM inference for work that deterministic code can handle in milliseconds.

---

## Root Causes (Four compounding issues)

### Root Cause 1: 618 people names in the decomposer prompt

The orchestrator builds a `known_subjects` registry every turn (lines 553–597) and injects **every person in the user's `people` table** into the decomposer prompt. The current database has **618 people entries** — contributing **12,985 chars** (~3,246 tokens) to the prompt.

**Actual decomposer prompt from traces:**
- "hi" → 21,861 chars (~5,466 tokens)
- "what is nintendo" → 21,482 chars (~5,371 tokens)

Breakdown:
| Component | Chars | Tokens (est) | % of prompt |
|-----------|-------|-------------|-------------|
| Base decomposition prompt | 7,066 | ~1,766 | 32% |
| 618 people in KNOWN_SUBJECTS | ~12,985 | ~3,246 | **57%** |
| 36 available intents | 982 | ~245 | 4% |
| Recent context + user input | ~640 | ~160 | 3% |
| Schema (sent separately) | 2,425 | ~606 | — |

Proof: a first-turn trace (before people loaded) shows decomp prompt at 1,633 chars → **97ms** decomposition. With people loaded: 21,482 chars → **20,002ms**. Same model, same query structure.

### Root Cause 2: The micro fast-lane doesn't catch "hi"

The system already has an embedding-based fast lane (`micro_fast_lane.py`) designed to bypass decomposition for greetings. But it uses a **0.90 similarity threshold**, and the embedder scores "hi" against the "hi" template at only **0.875**. The embedder literally cannot match "hi" to itself above the threshold.

This means every greeting falls through to the full 18s decomposition pipeline. The fast lane caught only **1 out of 30 recent traces** (3%).

Note: unit tests pass because they use a fake embedder that returns perfect scores, not the real embedder. This is a real test gap.

### Root Cause 3: Constrained schema decoding

The decomposer calls Ollama with `format_schema=DECOMPOSITION_SCHEMA` — a JSON Schema with 5 top-level required fields, 11 required fields per ask object (multiple enums), and a nested `long_term_memory` array. Ollama's grammar-constrained decoder validates every output token against this schema, adding per-token overhead.

### Root Cause 4: num_ctx configuration issues

The decomposer requests `num_ctx=8192`. The model's architectural context is 131,072, but Ollama loads it with a default KV cache allocation of 4,096. Passing `num_ctx=8192` forces a runtime KV cache expansion. Additionally, `enforce_prompt_budget` for synthesis inherits the decomposer's `_num_ctx` (8192) as its budget ceiling, allowing synthesis prompts up to 80% × 8192 = 6,553 tokens — larger than the model's default loaded context.

---

## Proof

### Benchmark data (this machine, gemma4:e4b, median of 3 runs after warmup)

**Decomposer (schema vs JSON at different prompt sizes):**

| Config | Median (warmed) | First-run (cold grammar) |
|--------|----------------|--------------------------|
| Full prompt (618 ppl, ~5300 tok) + schema | **3.7s** | 12.4s |
| Full prompt (618 ppl, ~5300 tok) + json | **1.2s** | 1.2s |
| Small prompt (10 ppl, ~2100 tok) + schema | **3.0s** | 6.3s |
| Small prompt (10 ppl, ~2100 tok) + json | **2.3s** | 2.3s |

Schema penalty: **3.1x at full prompt size, 1.3x at small prompt size.** Grammar compilation on first run causes massive spikes (3–4x slower). JSON mode has zero cold-start variance.

**Full `decompose()` call (5 consecutive runs, warmed):**

| Run | Time |
|-----|------|
| 1 | 3.8s |
| 2 | 3.6s |
| 3 | 3.5s |
| 4 | 3.6s |
| 5 | 3.6s |

**Synthesis:**

| Prompt size | num_ctx | Time |
|-------------|---------|------|
| ~150 tokens | default 4096 | **0.9–2.3s** |
| ~650 tokens | default 4096 | **2.3s** |
| ~650 tokens | explicit 8192 | **5.6s** |

**spaCy NER + dependency parsing:**

| Input | Time |
|-------|------|
| "hi" | **1.5ms** |
| "what is nintendo" | **1.5ms** |
| "my brother Tom loves playing Halo" | **1.9ms** |
| "my coworker Jacques loves Superman..." | **2.9ms** |

### Trace data (actual pipeline, `chat_traces` table)

| Trace | Input | Decomp chars | Decomp ms | Synth chars | Synth ms |
|-------|-------|-------------|-----------|-------------|----------|
| 13:21:50 | "hi" | 21,861 | **18,366** | 3,699 | 6,758 |
| 13:14:56 | "what is nintendo" | 21,482 | **20,002** | 3,665 | 11,750 |
| 06:37:15 | (unknown) | 21,372 | **14,531** | — | 491 |
| 06:12:49 | (first turn, no people) | 1,633 | **97** | 4,362 | 6,366 |

### Production vs isolated benchmark gap

Isolated warm benchmarks show 3.5–3.8s. Production traces show 18–20s. This is a **~5x gap** not fully explained by the subject list alone. Likely factors: model warmth, KV cache state from prior calls, system load. **Specific latency projections must be validated by re-measuring the production pipeline after each fix, not assumed from isolated benchmarks.**

### People table proof

```
People in database:                       618 entries
People string in KNOWN_SUBJECTS:          12,985 chars
Prompt WITH 618 people:                   21,326 chars (~5,331 tokens)
Prompt WITH 0 people:                      7,561 chars (~1,890 tokens)
People as % of prompt:                     57%
```

### Model switching: CONFIRMED NOT HAPPENING

Both decomposition and synthesis use `gemma4:e4b` for all observed traces:
- Decomposer: constructed with `model=_model_policy.fast_model` → `gemma4:e4b`
- Synthesis: `get_model("fast")` → `gemma4:e4b` (because `effective_complexity` is forced to "fast" for inputs under 120 chars)
- Model switch to `gemma4` (12B thinking model) only triggers for inputs ≥120 chars AND decomposer returns `overall_reasoning_complexity="thinking"`

### Context window: correction from peer review

`ollama show gemma4:e4b` reports context length of **131,072**. The 4,096 from `ollama ps` is Ollama's default runtime KV cache allocation, not a hard model limit. The prompt is not being silently truncated — the cost is attention over a large prompt, not data loss. The original claim that "the model can't see 31% of the prompt" was incorrect.

---

## Recommendation: spaCy Pre-Resolution + Phased Fixes

### The core idea: don't send all 618 people to the LLM — resolve them first

The current architecture dumps every person in the DB into the decomposer prompt so the LLM can figure out which ones are relevant. This is backwards. **The text itself tells us who's relevant.** We should extract people and relationships from the input *before* calling the LLM, then send only the matches.

spaCy (`en_core_web_sm`, already installed) does NER + dependency parsing in **1.5–3ms**. Combined with DB lookups against the people and relationship tables:

```
"I should call my mom"
  → spaCy: relationship mention "my mom"
  → DB lookup: mother relations → [Jesus M Torres, Sarah Pericas]
  → Send to LLM: KNOWN_SUBJECTS:people=[Jesus M Torres (mother),Sarah Pericas (mother)]
  → Prompt shrinks from ~21K chars to ~8K chars

"maybe I'll go to the movies with my brother"
  → spaCy: relationship mention "my brother"
  → DB lookup: brother relations → [Luke (brother), Van (brother)]
  → Send to LLM: KNOWN_SUBJECTS:people=[Luke (brother),Van (brother)]

"Luke hates those"
  → spaCy NER: "Luke" = PERSON
  → DB lookup: exact match → Luke
  → Send to LLM: KNOWN_SUBJECTS:people=[Luke (brother)]

"hi"
  → spaCy: no entities, no relationships
  → Send to LLM: KNOWN_SUBJECTS:people=[]
  → Prompt shrinks from ~21K to ~8K chars

"what is nintendo"
  → spaCy: no person entities
  → Send to LLM: KNOWN_SUBJECTS:people=[]
```

**Benchmarked prototype results (this machine):**

| Input | People resolved | Time | Chars saved |
|-------|----------------|------|-------------|
| "hi" | 0 | 1.5ms | 12,985 |
| "what is nintendo" | 0 | 1.6ms | 12,985 |
| "with my brother" | 2 (Luke, Van) | 3.5ms | ~12,950 |
| "tell Carina I said hi" | 1 (Carina) | 2.2ms | ~12,960 |
| "my sister-in-law was terrified" | 1 (Padme) | 2.7ms | ~12,960 |

### Why this replaces the brute-force KNOWN_SUBJECTS approach

| | Current (all 618) | Pre-resolution (0–3 matches) |
|--|---------|---------------|
| **People in prompt** | 618 | 0–3 |
| **Chars consumed** | 12,985 | 0–50 |
| **Resolution method** | LLM scans all names in a ~5,400 token prompt | spaCy NER + DB lookup |
| **Resolution time** | Part of 18–20s LLM call | 2–3ms |
| **Accuracy** | LLM attending over a massive prompt with 57% noise | Deterministic: spaCy entity extraction + exact/fuzzy DB match |
| **Unmatched names** | LLM might hallucinate a match | Reported as "unknown" — LLM can still attempt resolution with the reduced context |

**This is not a new routing system or a replacement for the LLM decomposer.** The LLM still does all semantic classification, intent routing, and memory extraction. spaCy is only doing entity extraction and DB matching — the same kind of pre-processing the orchestrator already does for memory retrieval, embedding search, and referent resolution. The difference is that it runs *before* prompt construction instead of after.

### Alias architecture: person aliases and relationship aliases are separate concerns

Pre-resolution will only work well in real usage if it can match how users *actually* refer to people. That requires an alias system, but **not all aliases belong in the same bucket**.

There are two distinct classes:

1. **Person aliases** — alternate names for a specific person.
   - Example: `Anakin` → `Art`, `Luke`
   - Example: `Anthony Johnson` → `AJ`, `Ant`
   - These belong on the `people` row and should be editable on that person's detail page.

2. **Relationship aliases** — words the user uses for a relationship type, not a legal name.
   - Example: canonical `mother` → `mom`, `mommy`, `mama`, `ma`
   - Example: canonical `father` → `dad`, `daddy`, `pops`
   - Example: canonical `brother` → `bro`
   - These should map to a canonical relationship label and be resolved against the relationship graph, not stored as if they were the person's name.

This distinction matters because `"Luke"` is a name-like reference to one specific person, while `"mom"` means "whoever is related to me as mother." If we flatten both into person aliases, the system blurs identity with role and matching logic becomes harder to reason about.

**Recommended matching order for pre-resolution:**

1. Exact canonical-name match against `people.name`
2. Exact person-alias match against `people.aliases`
3. Relationship alias match to canonical relation (`mom` → `mother`)
4. Fetch candidate people with that canonical relation
5. Bounded fuzzy match against `people.name` + `people.aliases`
6. Pass the reduced candidate set to the decomposer in `KNOWN_SUBJECTS`

This should be tightened into a **bounded identity policy**:

- `exact canonical name` → highest confidence
- `exact person alias` → high confidence
- `relationship alias` → relation-level candidate set, not a final person binding by itself
- `fuzzy canonical-name/alias match` → fallback only
- `unresolved` → if none of the above are strong enough

In short:

```text
exact > alias > fuzzy > unresolved
```

### Fuzzy matching policy: yes, but only as a fallback inside the known graph

Fuzzy matching is useful for misspellings and noisy recall, but it should **never** be the primary identity mechanism.

Use fuzzy matching only when:

- there is no exact canonical-name match
- there is no exact alias match
- the score clears a strict threshold
- the comparison set is bounded to the user's known people / known aliases

Do **not** fuzzy-match against "all possible names." Only fuzzy against:

- that user's people graph
- aliases already attached to those people
- optionally, relationship-derived candidate subsets when the input already indicates a relation

Example:

```
Known people:
  Anakin Torres    aliases=[Art, Luke]
  Robert Smith     aliases=[Rob, Bobby]

Input: "Arty"
  → exact canonical: no
  → exact alias: no
  → fuzzy canonical/alias pool: "Luke" matches strongly
  → resolve to Anakin Torres with lower confidence than an exact alias hit
```

Recommended resolver output shape:

```json
{
  "matched_person_id": "p_123",
  "matched_name": "Anakin Torres",
  "method": "fuzzy_person_match",
  "confidence": 0.88
}
```

This matters for latency *and* correctness. Bounded fuzzy matching lets us recover common misspellings like `Arty` → `Luke` without reintroducing the broad noisy search space that caused the original prompt explosion.

Note: the repo already does this pattern in referent resolution. `fuzzy_match_name()` builds its candidate set from both `people.name` and `people.aliases`, then uses RapidFuzz over that bounded per-user pool. The latency plan should reuse and extend that behavior for pre-resolution rather than invent a different matching policy.

Examples:

```
"Anakin told me that"
  → direct person/name-alias match
  → KNOWN_SUBJECTS:people=[Anakin (brother)]

"Luke told me that"
  → direct person alias match
  → KNOWN_SUBJECTS:people=[Anakin (brother)]

"my mom said that"
  → relationship alias match: mom → mother
  → relationship lookup: [Jesus M Torres, Sarah Pericas] if both are tagged mother
  → KNOWN_SUBJECTS:people=[Jesus M Torres (mother),Sarah Pericas (mother)]
```

**Product/UI implication:**

- The People detail page should expose **Names & Aliases** for person-specific aliases.
- Relationship aliases should live in a **relationship vocabulary** surface, likely admin/settings, because they are semantic language mappings rather than properties of one individual person.

This alias work is part of the latency plan because it directly improves pre-resolution quality. Without aliases, the prompt gets smaller but candidate recall gets worse; with aliases, we get both a smaller prompt and better candidate selection.

### Phased implementation plan

#### Phase 1: Pre-resolution + easy fixes (highest confidence, do first, then re-measure)

1. **spaCy pre-resolution of KNOWN_SUBJECTS** — run NER + dependency parse on `user_input`, match entities and relationship mentions against people/relationship DB, inject only resolved matches into the decomposer prompt. Max ~10 names. This removes 57% of the prompt.

2. **Formalize alias-aware matching**
   - Use existing `people.aliases` for person-specific nicknames / alternate spellings
   - Add relationship-alias mapping for kinship/role words (`mom`, `mommy` → `mother`)
   - Make pre-resolution search both sources before deciding the candidate set
   - Use fuzzy matching only as a bounded fallback inside the known person/alias pool
   - Return match method + confidence (`exact_name`, `exact_alias`, `relationship_alias`, `fuzzy_alias`, `unresolved`) so downstream logic can decide whether to auto-bind or leave ambiguous
   - Add GUI support to view/edit person aliases on the People detail page
   - Add GUI/admin support to view/edit relationship alias vocabulary

3. **Fix micro fast-lane** — add exact-string match for curated greeting/gratitude lists as a pre-check before embeddings. Add regression tests against the real embedder (not the fake one).

4. **Decouple synthesis `num_ctx`** from decomposer — give `enforce_prompt_budget` its own explicit context ceiling instead of inheriting from `self._decomposer._num_ctx`.

5. **Add regression test** for KNOWN_SUBJECTS at realistic scale (618 people, not 10).
   - Include alias-heavy cases (`Anakin` / `Art` / `Luke`)
   - Include relationship-language cases (`mom`, `mommy`, `bro`)
   - Verify that prompt size stays bounded while candidate recall remains correct

Then **re-measure the actual production pipeline.** The ~5x gap between isolated benchmarks and production traces means projections are uncertain until validated.

#### Phase 2: Only if Phase 1 isn't enough

5. **Switch to loose JSON** (`format="json"`) + validation in the decomposer. Schema penalty is 1.3–3.1x depending on prompt size, with grammar compilation spikes of 3–4x on first run. The existing repair infrastructure can handle occasional malformed output.

6. **Expand spaCy pre-processing** — pass parsed output as structured hints to the LLM (detected question type, extracted entities, relationship mentions), reducing what the LLM needs to infer from raw text.

#### Phase 3: Only if Phase 2 isn't enough

7. **Code-based fast classification** for obvious patterns (greetings, "what is X", weather, time) — scoped as an expansion of the existing micro_fast_lane, not a parallel routing system. The LLM decomposer remains the primary classifier for anything non-trivial.

---

## Impact Analysis

### 1. Decomposition

| Metric | Before | After Phase 1 (projected) | Reasoning |
|--------|--------|---------------------------|-----------|
| **Prompt size** | ~21K chars (~5,400 tokens) | ~8K chars (~2,000 tokens) | Pre-resolution removes ~13K chars of people names |
| **Latency (greeting)** | 18–20s | **<1s** (fast-lane fix catches it) | Exact-string match bypasses decomposer entirely |
| **Latency (other turns)** | 18–20s | **Must re-measure** | Isolated benchmarks suggest 3.5–3.8s warmed with current full prompt, and even less with a 61% smaller prompt. But production has a ~5x gap over isolated benchmarks — re-measurement required. |
| **Routing accuracy** | High | Same or better | The LLM still does all classification. It gets a smaller, cleaner prompt with only relevant people pre-resolved by spaCy. |
| **Memory extraction** | Via LLM | Same | `long_term_memory` extraction is unchanged. |

### 2. Synthesis

| Metric | Before | After Phase 1 (projected) | Reasoning |
|--------|--------|---------------------------|-----------|
| **Latency** | 6.8–11.8s | **Must re-measure** | Decoupling num_ctx eliminates potential KV cache thrashing between decomposition and synthesis. Correct prompt budget prevents silent truncation on memory-heavy turns. |
| **Response quality** | Good | Same or better | Budget fix ensures model actually sees all injected memory context. |
| **Human feel** | Good | Same | All warmth comes from synthesis prompt: memory injection, humanization planner, sentiment arc, character persona. None of this changes. Decomposition only routes — it doesn't generate user-facing text. |
| **Memory recall** | Good | Same | The synthesis prompt's WHAT_YOU_REMEMBER_ABOUT_THE_USER, REFERENT_BLOCK, and HUMANIZATION_PLAN are populated independently of the decomposition method. |

### 3. Memory System

| Metric | Before | After Phase 1 (projected) | Reasoning |
|--------|--------|---------------------------|-----------|
| **Fact extraction** | Via LLM | Same | LLM still extracts long_term_memory items. Repair loop still validates. |
| **Relationship detection** | LLM scans 618-name haystack | Same quality, better input | spaCy pre-resolves people, so the LLM gets confirmed matches instead of 618 names. |
| **Entity tracking** | Via LLM | Same | LLM still does the extraction. spaCy output optionally passed as hints. |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| spaCy misses a person entity | Low-Medium | Person not in KNOWN_SUBJECTS; LLM may default to "self" | Pass unresolved NER PERSON entities as "unmatched" hints. LLM can still attempt resolution. |
| Relationship alias mapping incomplete | Medium | "my stepmom" not matched if alias table lacks "stepmom" | Build alias table from actual usage patterns in traces. Expand over time. |
| Pre-resolution adds latency | Negligible | 2–3ms per turn | spaCy is 1.5–3ms. DB lookup is sub-ms with indexed names. |
| Phase 1 doesn't close the production gap | Medium | Decomposition still >5s | Proceed to Phase 2 (loose JSON, expanded pre-processing). The phased approach ensures we measure before escalating. |
| Loose JSON (Phase 2) produces malformed output | Low | Fallback ask used | Existing `_fallback_result` + `_build_ask` defaults + `decomposer_repair.py` handle this. |

---

## Summary

The primary bottleneck is **618 people names injected into every decomposer prompt** (12,985 chars, 57% of prompt). The fix: **pre-resolve entities with spaCy before building the prompt**, sending only the 0–3 relevant matches to the LLM instead of the full DB.

This is not a new routing system. It's pre-processing — the same pattern the orchestrator already uses for memory retrieval and referent resolution, applied one step earlier. The LLM still does all semantic classification.

Additional Phase 1 fixes: repair the broken micro fast-lane (greetings bypass), decouple synthesis budget from decomposer num_ctx, add scale-realistic regression tests.

Projected results after Phase 1:
- **Greetings: 25s → <1s** (fast-lane bypass)
- **Other turns: 18–20s → must re-measure** (prompt shrinks by 61%; isolated benchmarks suggest major improvement, but production gap requires validation)
- **Memory extraction: unchanged** (LLM still handles it)
- **Human feel: unchanged** (all warmth comes from synthesis)
- **Accuracy: same or better** (LLM gets a cleaner prompt with only relevant people)
