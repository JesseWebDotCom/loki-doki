# Chunk 09 — Memory M6: Affective (Tier 6, Character Overlay)

**Source:** `docs/MEMORY_DESIGN.md` §8 M6, §2 Tier 6.
**Prereqs:** C03 (persona — needs `character_id` in the request context).

---

## Goal

Track sentiment trajectory per user+character pair. The relationship-temperature dimension.

---

## What to Build

1. **`affect_window` table** — apply M0 migration. Composite PK `(owner_user_id, character_id, day)`. Columns: `sentiment_avg`, `notable_concerns` (JSON).
2. **`sentiment` column on `messages`** — apply M0 migration. Decomposer already emits this in `short_term_memory`; just persist it.
3. **Per-turn write** of sentiment to `messages` + rolling aggregation into `affect_window`.
4. **14-day rolling-window** aggregation.
5. **Character-scoped read** at session start, filtered by active `character_id`.
6. **`{recent_mood}` slot** (120-char budget) in combine prompt, always present, per-character.
7. **"Forget my mood" UI** — wipes `affect_window` rows for user (or user+character).
8. **Per-user opt-out toggle** for sentiment persistence.
9. **Episodic compression** follow-up: episodes > 6 months with `recall_count=0` rolled up into period summaries.

---

## Key Files

| File | Action |
|---|---|
| `v2/orchestrator/memory/store.py` | Add affect_window methods |
| `v2/orchestrator/memory/slots.py` | Add `assemble_recent_mood_slot` |
| `v2/orchestrator/core/pipeline.py` | Add sentiment persistence hook |
| `v2/orchestrator/fallbacks/prompts.py` | Add `{recent_mood}` slot |
| `tests/unit/test_v2_memory_m6.py` | New file |

---

## Gate Checklist

- [ ] Sentiment persists across 7 simulated days for a single character
- [ ] Character isolation: sentiment under `character_id=loki` never returned for `character_id=doki`
- [ ] Opt-out toggle disables slot and prevents writes
- [ ] "Forget my mood" wipes affected rows
- [ ] Episodic compression: 7-month-old never-recalled episode compressed; original dropped
