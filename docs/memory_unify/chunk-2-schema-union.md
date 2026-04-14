# Chunk 2 — Union schemas

## Goal
Make both schema-init paths (`MEMORY_CORE_SCHEMA` in the memory package and `SCHEMA_SQL` in `core/memory_sql.py`) coexist on the same `data/lokidoki.db` file without column conflicts. Where both declare the same table, the table definition must be the column-union of both.

## Files
- `lokidoki/orchestrator/memory/store_schema.py` (main edits)
- `lokidoki/core/memory_sql.py` (schema section near the top — add any missing columns to match)
- Tests: run the memory + provider unit tests as the gate.

## Actions

1. Read both schema sources fully:
   - `lokidoki/orchestrator/memory/store_schema.py`
   - `lokidoki/core/memory_sql.py` — just the `CREATE TABLE` statements.

2. Identify the four tables both systems touch: `facts`, `people`, `relationships`, `sessions`. For each, produce a single `CREATE TABLE IF NOT EXISTS` that contains the **union** of columns from both sources. Put the unified definition in `store_schema.py`. Remove the narrower definition from the other schema path (the narrower one is whichever declares fewer columns). Both init routines continue to run at boot, but each table is now declared once.

3. Column reconciliation notes (verify against the real files before editing):
   - `facts`: legacy columns include `category`, `subject_type`, `subject_ref_id`, `source_message_id`, `project_id`, `ambiguity_group_id`, `kind`, `last_observed_at`. v2 has the lean set. Keep the legacy superset; v2 writes leave new columns NULL or defaulted.
   - `people`: legacy has `aliases`, `bucket`, `living_status`, `birth_date`, `death_date`, `preferred_photo_id`. v2 has `handle`, `provisional`. Union.
   - `sessions`: legacy has `title`, `project_id`. v2 has `session_state`. Union.
   - `relationships`: likely differs on `direction` / `relation_label` wording. Union; keep both column names if both are written to.

4. Keep all legacy-only tables (`users`, `app_secrets`, `characters`, `voices`, `wakewords`, `chat_traces`, `messages`, `projects`, `skill_*`, `chat_traces`, `experiment_assignments`, etc.) exactly where they are in `core/memory_sql.py`. Do not move them.

5. Keep all v2-only tables (`episodes`, `episodes_fts`, `behavior_events`, `affect_window`, `user_profile`, and FTS/vec sidecars) exactly where they are in `store_schema.py`.

6. If any `ALTER TABLE ADD COLUMN` is needed to keep prior DBs compatible — skip it. Per plan the DB is empty (Chunk 1 nuked it), so `CREATE TABLE IF NOT EXISTS` is sufficient.

## Verify

```bash
rm -f data/lokidoki.db data/lokidoki.db-shm data/lokidoki.db-wal
uv run python -m pytest tests/unit/test_memory_m0.py tests/unit/test_memory_m1.py tests/unit/test_memory_m2.py tests/unit/test_memory_m3.py tests/unit/test_memory_provider.py -q
```

Expected: all tests pass. If a test fails because it expected a v2-only schema on a dedicated file, fix the test to use the shared path — but only if the fix is a one-line change. Larger fixes get deferred to a later chunk (note in that chunk's doc).

## Commit message

```
refactor(memory): union fact/people/relationships/sessions schemas

Both schema-init paths now coexist on data/lokidoki.db. Each shared
table is declared once in store_schema.py as the column-union of the
legacy and v2 shapes, so v2 writers see legacy columns and legacy
readers see v2 writes.

Refs docs/memory_unify/PLAN.md chunk 2.
```

## Deferrals section

### Deferred from Chunk 1

Chunk 1's combined-boot verify could not complete because the legacy
(`MemoryProvider`) and v2 (`MemoryStore`) init paths both try to create
`facts`, `people`, and `sessions` on the same `data/lokidoki.db` with
conflicting column shapes:

- When `MemoryStore` initializes first, it creates a lean v2 `facts`
  table without `subject_ref_id`. A subsequent `MemoryProvider.initialize`
  then fails inside `open_and_migrate` → `conn.executescript(CORE_SCHEMA)`
  with `sqlite3.OperationalError: no such column: subject_ref_id`.
- When `MemoryProvider` initializes first, it creates the legacy `people`
  table without `handle`. A subsequent `MemoryStore()` construction then
  fails inside `_bootstrap` → `executescript(MEMORY_CORE_SCHEMA)` with
  `sqlite3.OperationalError: no such column: handle`.

Both singletons were confirmed to resolve to `data/lokidoki.db`
independently, so Chunk 1's repointing is correct. Resolving the
table-shape collisions for `facts`, `people`, `sessions` (and any other
overlapping tables) is this chunk's schema-union job.
