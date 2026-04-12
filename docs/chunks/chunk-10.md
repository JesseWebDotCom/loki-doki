# Chunk 10 — V1 Cutover: chat.py Swap + V1 Deletion

**Source:** `docs/v2-graduation-plan.md` §6 (Cutover order) + §7 (Graduation gate).
**Prereqs:** C01 (M4), C03 (persona+synthesis), C04 (SSE streaming). These three are the critical path.

---

## Goal

Replace v1 orchestrator in `lokidoki/api/routes/chat.py:82-104` with `run_pipeline_async`. Delete v1 code.

---

## Pre-Cutover Verification

Before touching chat.py, verify ALL graduation gates:

1. Every subsystem section has a green Phase Gate (C01-C09 status in IMPLEMENTATION_PLAN.md).
2. Frontend chat hits `run_pipeline_async` via the SSE wrapper (C04) and receives streaming events.
3. Regression corpus has 150+ entries.
4. p95 warm pipeline latency <= 1.2x v1 baseline.
5. Dev tool status page is honest.

---

## Cutover Steps

### 1. Swap chat.py
At `lokidoki/api/routes/chat.py:82-104`:
- Replace v1 `Orchestrator` construction with `run_pipeline_async` call
- Wire persona from `character_ops.get_active_character_for_user` into v2 context
- Wire `owner_user_id` from the authenticated JWT into v2 context
- Use the SSE streaming wrapper from C04

### 2. Wire MemoryProvider
- v2 uses its own `data/v2_memory.sqlite` (M1 clean-cutover decision)
- Ensure the v2 store is initialized at app startup

### 3. Update dev tool status
- `lokidoki/api/routes/dev.py:56` — update to reflect v2 honestly

### 4. Delete v1 (separate PR)
- `lokidoki/core/orchestrator.py` (~1784 LOC)
- `lokidoki/core/decomposer.py`
- `lokidoki/core/prompts/decomposition.py`
- `lokidoki/core/orchestrator_memory.py`
- `lokidoki/core/memory_phase2.py`
- `lokidoki/core/decomposer_repair.py`
- `lokidoki/skills/` directory (if no non-test code references it)
- PR description links to bake-off docs that justify each subsystem's approach

---

## Key Files

| File | Action |
|---|---|
| `lokidoki/api/routes/chat.py` | Edit: swap v1 -> v2 |
| `lokidoki/api/routes/dev.py` | Edit: update status |
| `app/main.py` | Edit: ensure v2 store init at startup |
| `lokidoki/core/orchestrator.py` | Delete (separate PR) |
| `lokidoki/core/decomposer.py` | Delete (separate PR) |
| `lokidoki/skills/` | Delete (separate PR) |

---

## Gate Checklist (Graduation Gate)

- [ ] All subsystem Phase Gates green
- [ ] Frontend chat works with v2 SSE events
- [ ] Regression corpus >= 150 entries
- [ ] p95 warm latency <= 1.2x v1 baseline
- [ ] Dev tool status page honest
- [ ] v1 deletion PR is separate and reviewable
