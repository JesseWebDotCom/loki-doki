# LokiDoki v2 Migration — Progress Log

Append-only. Each chunk appends what shipped, what regressed (if anything), and what the next session needs to know.

---

## Pre-Migration State (2026-04-12)

**Memory:** M0-M3.5 complete. 124 memory-specific tests green. M4 paused mid-implementation — store.py, summarizer.py, promotion.py extended but no phase-gate tests yet.

**Graduation plan:** 4.A (memory write), 4.B (memory read), 4.D (people resolution) all complete via memory phases. 4.C, 4.E, 4.F, 4.G, 4.H, 4.I, 4.J all not started.

**Skills:** All 8 phases not started. Registry has drift (descriptions don't match runtime behavior).

**Tests:** 1468 total tests collected.

**Implementation plan created:** `docs/IMPLEMENTATION_PLAN.md` with 12 chunks. Per-chunk briefings at `docs/chunks/chunk-NN.md`. Critical path to cutover: C01 (M4) + C03 (persona/synthesis) + C04 (SSE) -> C10 (cutover).

---

## C01 — Memory M4: Session State + Episodic + Promotion + Consolidation (2026-04-12)

**Status:** Complete. All M4 gates green. 35 new tests, 158 total (zero regressions).

**What shipped:**

1. **consolidation.py** — replaced M0 stub with real triggered consolidation. In-session frequency counter backed by `session_state` JSON. 24h rolling window resets on day boundaries. Fires `process_candidate` through the writer gate chain at threshold 3.

2. **reader.py** — added `read_recent_context(store, session_id)` for Tier 2 last-seen map retrieval. Added `read_episodes(store, owner_user_id, query, ...)` for Tier 3 episodic recall using BM25 over `episodes_fts` + temporal recency boost via RRF fusion.

3. **slots.py** — added `render_recent_context`, `assemble_recent_context_slot` (300-char budget), `render_relevant_episodes`, `assemble_relevant_episodes_slot` (400-char budget). Updated `assemble_slots` to handle `need_session_context` and `need_episode` flags.

4. **pipeline.py** — added `_ensure_session` (creates session row when memory enabled), `_run_session_state_update` (records last-seen entities after resolution), `_maybe_queue_session_close` (queues summarization on closing turn). Extended `_run_memory_read_path` with Tier 2 + Tier 3 slots.

5. **prompts.py** — added `{recent_context}` and `{relevant_episodes}` slots to both `COMBINE_PROMPT` and `DIRECT_CHAT_PROMPT` with "use silently" rules.

6. **llm_fallback.py** — `build_combine_prompt` now threads `recent_context` and `relevant_episodes` from `spec.context["memory_slots"]`.

7. **__init__.py** — added `M4_PHASE_*` constants, advanced `ACTIVE_PHASE_*` to M4.

8. **test_v2_memory_m4.py** — 35 tests covering: session state round-trips, episode write+FTS search, topic scope derivation, triggered consolidation (below/at threshold), cross-session promotion (3-session test + below-threshold test), summarization queue, slot rendering + budgets, latency gate (p95 < 50ms), pipeline integration (session creation, session close, need_session_context, need_episode, no-slots-when-disabled), phase constants.

**Gate checklist:**
- [x] Triggered consolidation: 3 in-session repeats create Tier 4 fact
- [x] Cross-session promotion: fact in 3 sessions reaches Tier 4
- [x] Session state lookup p95 < 50ms
- [x] Topic-scope derivation: single winner, tie→None, explicit override
- [x] Session-close summarization runs out-of-band (queue model)
- [x] Slot budgets enforced (300/400 chars)
- [x] Pipeline integration: all flags gate correctly

**Follow-up items completed (same session):**
- `store.decay_session_state(session_id, current_turn_index)` — drops last-seen entries older than 5 turns
- `store.update_last_seen_with_turn` — records turn index for decay
- `_bridge_session_state_to_recent_entities` — populates `context["recent_entities"]` from v2 session state so the existing pronoun resolver works without changes
- `_auto_raise_need_session_context` — sets flag when any resolution has unresolved referents
- Dev-tools: `V2RunRequest` gains `need_session_context` + `need_episode` fields, wired into context. M4 phase status flipped to "complete" in `_v2_memory_status`.
- 7 additional tests: stale-context decay (3), session-state bridge (2), auto-raise (2). Total M4 tests: 42.

**Remaining C01 item deferred to C05 (Prompts/Decomposer):**
- `need_session_context` and `need_episode` as decomposer schema fields — requires the decomposer audit in C05.

**Final test count:** 211 (124 prior + 42 M4 + 12 pipeline + 22 prompts + 11 dev endpoints). Zero regressions.

**Next chunk:** C02 (Skills Foundation), C03 (Persona+Synthesis), or C04 (SSE Streaming) — all independent.

<!-- Append new entries below this line -->
