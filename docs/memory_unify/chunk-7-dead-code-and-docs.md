# Chunk 7 — Delete dead code + doc sweep

## Goal
After chunks 1–6 the system has one DB, one writer path, one reader path, and no `v2` markers. This chunk removes the scaffolding that survived the migration and brings `docs/DESIGN.md §6` in line with reality.

## Files
- `lokidoki/core/memory_sql.py` — remove `upsert_fact`, `create_person`, `add_relationship`, and any other function that is no longer called after chunks 3–4. Keep schema-init and chat/auth/project helpers.
- `lokidoki/orchestrator/memory/writer.py` — remove any stale phase-status language or `tier_not_active_*` branches that are no longer reachable.
- `lokidoki/orchestrator/memory/__init__.py` — the `Mn_PHASE_*` constants. If nothing consumes them anymore, delete them; if the dev-tools surface still reads them, leave them but drop the per-phase title granularity and collapse to a single "memory subsystem" status block.
- `docs/DESIGN.md` §6 (Memory System) — rewrite to describe a single unified subsystem. Remove M-phase language. Keep the tier descriptions; they are still correct.
- Delete any obsolete helper scripts under `scripts/` that were cross-DB migration utilities (check with `git log --diff-filter=A scripts/` for anything named `sync_memory*`, `migrate_*memory*`, etc.).

## Actions

1. Run a callers check for every function you intend to delete:
   ```bash
   rg -n 'from lokidoki\.core\.memory_sql import|memory_sql\.' lokidoki/ tests/
   ```
   Only delete functions with zero non-test callers. If tests still reference a helper, either update the test to use the provider/store surface, or keep the helper and note in the commit why.

2. Remove phase constants carefully: `rg 'M[0-9]_PHASE' lokidoki/ tests/ frontend/`. If the dev-tools status page or a frontend component reads them, collapse to a single `MEMORY_PHASE_STATUS = "shipped"` (or remove entirely and delete the UI fields that render it).

3. Walk through `docs/memory_unify/chunk-{3,4,5,6}-*.md` and fold any `## Deferred from Chunk N` blocks into this chunk's work. Those are the final "loose ends" items — implement them if trivial, drop them with justification if not.

4. Update `docs/DESIGN.md`:
   - Rewrite §6 lead paragraph to say "one SQLite file (`data/lokidoki.db`), one gate-chain writer, one lazy per-tier reader." Remove references to M-phases in §6.
   - Keep the seven-tier descriptions verbatim (§6.1) — they are policy, not implementation.
   - Scrub any remaining mentions of "v2" / "legacy" / "new memory system" in §6.2–6.7.

5. Update `docs/PHASE_CURRENT.md` only if it still references memory M-phases as in-flight.

6. After all deletes, run the full suite as the gate.

## Verify

```bash
rg 'upsert_fact|memory_sql\.create_person|memory_sql\.add_relationship' lokidoki/ && echo "FAIL: dead calls remain" || echo "ok"
rg 'tier_not_active|m[0-9]_phase|M[0-9]_PHASE' lokidoki/ && echo "FAIL: stale phase refs remain" || echo "ok"
uv run python -m pytest -q
```

Then manual smoke:
```bash
rm -f data/lokidoki.db data/lokidoki.db-shm data/lokidoki.db-wal
uv run python run.py
# Log in, chat: "My name is Anakin and I'm allergic to peanuts. My sister is Leia."
# Reload Memory tab: 'name' and 'has_allergy' should appear as self-facts,
# Leia should appear as a person with relation 'sister'.
```

If the manual smoke is not viable in-session, note it in the commit body.

## Commit message

```
chore(memory): delete migration scaffolding and refresh DESIGN.md

Drop unreachable memory_sql helpers, collapse phase-status constants,
and rewrite DESIGN.md §6 to describe the unified memory subsystem.
Closes the migration documented under docs/memory_unify/.

Refs docs/memory_unify/PLAN.md chunk 7.
```

## Deferrals section

*(final chunk — any remaining deferrals go in a new follow-up doc rather than here)*

## Deferred from Chunk 3

- Several adjacent unit tests use legacy non-enum predicates (`likes`, `loves`, `enjoys`, `job`, `location`, `favorite_movie` used as multi-value, etc.) that the gate chain now rejects via `MemoryProvider.upsert_fact`. They were out of Chunk 3's Files scope so the failures land here. Known-affected files:
  - `tests/unit/test_memory_projects.py::test_list_facts_filtered_by_project`
  - `tests/unit/test_memory_search_hybrid.py` (all three failing cases)
  - `tests/integration/test_memory_people_api.py` (four `mp.upsert_fact` call sites)
  - `tests/integration/test_auth_api.py` (three `mp.upsert_fact` call sites)
  Update these to use Tier 4/5 enum predicates (e.g. `prefers`, `lives_in`, `works_as`) or relax assertions that depend on non-enum writes succeeding.
- `MemoryProvider.add_relationship` now writes to the social-tier `relationships` table via the gate-chain writer, but `memory.list_relationships` still reads from `person_relationship_edges`. Either migrate `list_relationships` to read from `relationships`, or dual-write the edge in the provider adapter, so the Memory UI's relationship list reflects new add_relationship calls.
