# Pipeline v2 — Execution Plan

Goal: eliminate routing dead-ends, fix query contamination, add slot-aware scoring, structured constraint extraction, response schemas, and embedding-based memory retrieval. The pipeline should never silently fail — every branch produces a response or escalates.

Design rationale lives in `docs/DESIGN_pipeline_v2.md`. This file is the execution contract.

---

## How to use this document (Claude Code operating contract)

You are a fresh Claude Code session. You have been pointed at this file and given no other instructions.

**Do exactly this:**

1. Read the **Status** table below. Pick the **first** chunk whose status is `pending` — call it Chunk N.
2. Open `chunk-N-*.md` and read it completely. **Do not open any other chunk doc.**
3. Execute every step in its `## Actions` section.
4. Run the command in its `## Verify` section. If it fails, do not proceed — diagnose or record the block and stop. Do not fake success.
5. If verify passes:
   - Stage only the files the chunk touched.
   - Commit using the template in the chunk's `## Commit message` section. Follow `memory/feedback_no_push_without_explicit_ask.md` — **commit only; do not push, open a PR, or merge.**
   - Edit this `PLAN.md`: flip the chunk's row from `pending` to `done` and paste the commit SHA in the `Commit` column.
   - If during execution you discovered work that had to be pushed to a later chunk (e.g. a test failure that's out of scope, a renamed identifier you couldn't touch yet), append a `## Deferred from Chunk N` bullet list to that later chunk's doc with the specifics.
6. **Stop.** Do not begin the next chunk in the same session. Each chunk gets its own fresh context to keep token use minimal.

**If blocked** (verify keeps failing, required file is missing, intent of the chunk is unclear): leave the chunk status as `pending`, write a `## Blocker` section at the bottom of that chunk's doc explaining what's wrong, and stop. Do not guess.

**Scope rule**: only touch files listed in the chunk doc's `## Files` section. If work sprawls beyond that list, stop and defer the sprawl to a later chunk rather than expanding this one.

**Budget rule**: the decomposer prompt must stay under 8,000 chars and the ask schema under 12 required fields. If a chunk adds a decomposer field, it must either replace an existing one or justify the addition with a prompt-size test update.

---

## Status

| # | Chunk | Status | Commit |
|---|-------|--------|--------|
| 1 | [Kill the dead-end — LLM fallback from stub synthesis](chunk-1-llm-fallback.md) | done | f7e22c4 |
| 2 | [resolved_query — conversation-aware decomposer output](chunk-2-resolved-query.md) | done | 9bd9a84 |
| 3 | [Slot compatibility scoring in router](chunk-3-slot-scoring.md) | pending | |
| 4 | [Constraint extraction matchers](chunk-4-constraint-matchers.md) | pending | |
| 5 | [Response schemas in synthesis prompt](chunk-5-response-schemas.md) | pending | |
| 6 | [FTS5 + embedding-based memory retrieval](chunk-6-memory-retrieval.md) | pending | |
| 7 | [Python-derived goal inference + entity canonicalization](chunk-7-goal-and-aliases.md) | pending | |
| 8 | [Routing confidence + adaptive pipeline depth](chunk-8-routing-confidence.md) | pending | |

---

## Global context (read once, applies to every chunk)

- The pipeline lives in `lokidoki/orchestrator/`. Entry: `core/pipeline.py` → `core/pipeline_phases.py` (8 phases).
- **Pre-parse** (`pipeline_phases.py:42`): normalize → signals → fast_lane. Fast lane returns canned responses for trivial patterns; miss = continue.
- **Initial** (`pipeline_phases.py:61`): spaCy parse → split into `RequestChunk`s → extract entities/predicates → memory write (M1).
- **Routing** (`pipeline_phases.py:88`): embed query with MiniLM → cosine similarity vs capability index → `ROUTE_FLOOR=0.55` threshold. Below floor = `direct_chat`.
- **Derivations → Resolution → Execution**: compute need_* flags → resolve references → call skill handlers (parallel per chunk).
- **Synthesis** (`pipeline_phases.py:244`): memory read (M2-M6) → LLM decision → `llm_synthesize_async()` or `_stub_synthesize()` → knowledge gap loop.
- The decomposer (`lokidoki/core/prompts/decomposition.py`) runs on a 2B Qwen with an 8K-char prompt budget and <12 required schema fields.
- MiniLM (`all-MiniLM-L6-v2`) is loaded in `orchestrator/routing/embeddings.py`. spaCy (`en_core_web_sm`) is loaded in `orchestrator/pipeline/parser.py`.
- Memory tiers M0-M6 are assembled in `orchestrator/memory/slots.py` with per-slot char budgets (1470 total).
- Skill capabilities are registered in `orchestrator/registry/`. Each has description + example utterances, pre-embedded at startup.
- The stub synthesizer (`_stub_synthesize` in `fallbacks/llm_fallback.py`) is the current dead-end — it joins chunk outputs or returns a tombstone.

Design doc: `docs/DESIGN_pipeline_v2.md`
