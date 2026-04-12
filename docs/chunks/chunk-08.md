# Chunk 08 — Memory M5: Procedural (Tier 7a/7b)

**Source:** `docs/MEMORY_DESIGN.md` §8 M5, §2 Tier 7.
**Prereqs:** M2 (done).

---

## Goal

The tier that makes the assistant feel adaptive. Track behavioral patterns, derive style preferences, split into prompt-safe (7a) and prompt-forbidden (7b).

---

## What to Build

1. **`behavior_events` table** — apply M0 migration. Append-only log: `id`, `owner_user_id`, `at`, `event_type`, `payload` (JSON).
2. **`user_profile` table** — apply M0 migration. `owner_user_id` PK, `style` JSON (7a), `telemetry` JSON (7b), `updated_at`.
3. **Orchestrator hook** — write a `behavior_events` row at end of every turn (input modality, response length, dialog dismissed, retry rate).
4. **Nightly aggregation job** (deterministic, no LLM):
   - Walk events since last run
   - Update `user_profile.style` per closed enum: `tone`, `verbosity`, `formality`, `name_form`, `preferred_modality`, `units`, `routine_time_buckets`
   - Update `user_profile.telemetry` per UX signals
   - Drop folded events older than 30 days
5. **`need_routine` decomposer field.**
6. **`{user_style}` slot** (200-char budget) in combine prompt, always present.
7. **7b leak test** — assert `telemetry` JSON never appears in any prompt render.
8. **Opt-out toggle** for telemetry collection.

---

## Key Files

| File | Action |
|---|---|
| `v2/orchestrator/memory/store.py` | Add behavior_events + user_profile methods |
| `v2/orchestrator/memory/schema.py` | Verify M0 migrations cover these tables |
| `v2/orchestrator/memory/slots.py` | Add `assemble_user_style_slot` |
| `v2/orchestrator/core/pipeline.py` | Add behavior_events hook at turn end |
| `v2/orchestrator/fallbacks/prompts.py` | Add `{user_style}` slot |
| `tests/unit/test_v2_memory_m5.py` | New file |

---

## Gate Checklist

- [ ] Profile descriptors stable across synthetic simulation
- [ ] Synthesis prompt observably changes tone for 3+ distinct profiles
- [ ] Aggregation < 5s for 1000 events
- [ ] 7b leak test: telemetry never appears in any prompt
- [ ] Opt-out test: toggling off prevents behavior_events writes
