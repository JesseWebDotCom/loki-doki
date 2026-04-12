# Chunk 01 — Memory M4: Session State + Episodic + Promotion + Consolidation

**Source:** `docs/MEMORY_DESIGN.md` §8 M4 (lines 814-872), §2 Tiers 2-3, §3 Layer 3, §4 read path, §5 reflect job.
**Maps to:** Graduation Plan §4.E (conversation context + multi-turn memory).
**Prereqs:** M0-M3.5 all complete. 124 memory tests passing.

---

## Starting State (paused 2026-04-12)

Already shipped (additive, no regressions — 124/124 prior tests green):

### store.py extensions
- `V2_MEMORY_CORE_SCHEMA` extended with `sessions`, `episodes`, `episodes_fts` tables + triggers + indexes
- New methods: `create_session`, `close_session`, `get_session_state`, `set_session_state`, `update_last_seen`, `bump_consolidation_counter`, `get_consolidation_counter`, `write_episode`, `get_episodes`, `count_episodes_with_claim`
- Smoke-tested via REPL; **not yet covered by phase-gate tests**

### summarizer.py (new module)
- Deterministic template-fill session-close summarizer
- `SessionObservation` dataclass, `derive_topic_scope`, `summarize_session`
- Out-of-band queue: `queue_session_close` / `run_pending_summaries` / `pending_job_count` / `reset_queue`
- Calls `run_cross_session_promotion` after writing episode

### promotion.py extensions
- `run_cross_session_promotion(store, owner_user_id, observations)` — walks session observations, calls `count_episodes_with_claim`, runs writer gate chain on claims with 3+ sessions
- `PROMOTION_THRESHOLD = 3`

---

## TODO (12 items — this is the chunk's work)

### 1. Triggered consolidation (consolidation.py)
Replace `maybe_trigger_consolidation` M0 stub with real implementation:
- Call `store.bump_consolidation_counter`
- Return `triggered=True` at threshold 3
- When triggered, re-run candidate through writer to upgrade Tier 4 row confidence
- 24h rolling window: compare `last_at` against `_now()`, reset on day boundaries

### 2. Slot assemblers (slots.py)
- `assemble_recent_context_slot` (Tier 2, 300-char budget)
- `assemble_relevant_episodes_slot` (Tier 3, 400-char budget)
- `render_*` helpers mirroring M2/M3 shape

### 3. Episode reader (reader.py)
- `read_recent_context(store, session_id)` — returns last_seen map + unresolved questions
- `read_episodes(store, owner_user_id, query, *, top_k=2, topic_scope=None)` — BM25 over `episodes_fts.summary` + temporal recency boost; topic_scope optional filter
- Ship BM25-only; vectors deferred to M4.5

### 4. Pipeline integration (pipeline.py)
- `_run_session_state_update_path` after `memory_write`: update `last_seen` per resolved entity
- `_run_pronoun_consult`: scan resolutions for unresolved referents; set `need_session_context=True`
- `_run_memory_read_path` extended: assemble `recent_context` + `relevant_episodes` slots
- `_run_session_close_hook` after `combine` when `session_closing=True`: build `SessionObservation` list, call `queue_session_close`; tests run `run_pending_summaries()` synchronously
- `session_id` created on first turn with `owner_user_id`, persists in `safe_context["session_id"]`

### 5. Prompt templates (prompts.py)
- `COMBINE_PROMPT` + `DIRECT_CHAT_PROMPT`: add `{recent_context}` and `{relevant_episodes}` slots + "use silently, never quote" rule
- `build_combine_prompt` in `llm_fallback.py` reads from `spec.context["memory_slots"]`

### 6. Decomposer flags
- Wire `need_session_context` and `need_episode` boolean fields

### 7. Phase constants (__init__.py)
- Add `M4_PHASE_*`, advance `ACTIVE_PHASE_*` to M4

### 8. Dev-tools status (dev.py)
- Flip M4 from `not_started` to `complete`
- Add `need_session_context` + `need_episode` toggles to `V2RunRequest`
- Update `_v2_memory_status()` with M4 deliverable list

### 9. Recall corpus extension (v2_memory_recall_corpus.json)
Add at least:
- 4 multi-turn pronoun-resolution cases
- 3 cross-session promotion cases
- 3 triggered-consolidation cases
- 3 topic-scope retrieval cases
- 2 stale-context-decay cases

### 10. Phase-gate tests (test_v2_memory_m4.py)
Cover: session_state round-trips, last-seen update, episode write + FTS search, topic_scope derivation, cross-session promotion (3-session), triggered consolidation (3 in-session), pronoun resolver auto-raises `need_session_context`, slot budgets (300/400), pipeline integration, session-close summarization out-of-band, latency gate.

### 11. Latency gate
`test_m4_session_state_lookup_under_50ms_p95`: seed N sessions, assert p95 < 50ms.

### 12. Stale-context decay
Implement `decay_session_state(session_id, current_turn_index)` that drops entries older than K turns.

---

## Key Files to Read/Edit

| File | Action |
|---|---|
| `v2/orchestrator/memory/store.py` | Read (already extended). Edit if consolidation needs new store methods. |
| `v2/orchestrator/memory/consolidation.py` | Replace M0 stub with real implementation. |
| `v2/orchestrator/memory/slots.py` | Add Tier 2 + Tier 3 assemblers. |
| `v2/orchestrator/memory/reader.py` | Add `read_recent_context` + `read_episodes`. |
| `v2/orchestrator/memory/summarizer.py` | Read (already implemented). May need minor adjustments. |
| `v2/orchestrator/memory/promotion.py` | Read (already extended). May need minor adjustments. |
| `v2/orchestrator/core/pipeline.py` | Extend with session state, pronoun consult, session close hook. |
| `v2/orchestrator/fallbacks/prompts.py` | Add 2 new slots. |
| `v2/orchestrator/fallbacks/llm_fallback.py` | Thread new slots. |
| `lokidoki/api/routes/dev.py` | Update V2RunRequest, _v2_memory_status. |
| `tests/fixtures/v2_memory_recall_corpus.json` | Extend with M4 cases. |
| `tests/unit/test_v2_memory_m4.py` | New file: all phase-gate tests. |

---

## Splitting Guidance

If this chunk is too large for one session:
- **Session A:** Items 1-3 (consolidation, slots, reader) + item 10 tests for those
- **Session B:** Items 4-8 (pipeline, prompts, dev tools) + items 9, 11, 12

---

## Gate Checklist

- [ ] M2 done first (already green)
- [ ] Pronoun resolution accuracy >= 0.85 on multi-turn corpus
- [ ] No more than +50ms p95 added by session-state lookup
- [ ] Stale-context decay verified (turn-distance test)
- [ ] Cross-session promotion: fact in 3 sessions reaches Tier 4 via promotion
- [ ] Triggered consolidation: 3 in-session repeats reach Tier 4 before session close
- [ ] Topic-scope retrieval: `japan_trip` episode preferred for Japan queries
- [ ] Session-close summarization runs out-of-band (latency test)
