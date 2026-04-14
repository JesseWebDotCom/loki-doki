# Chunk 1 — Nuke DBs + repoint default path

## Goal
Collapse to a single DB file at `data/lokidoki.db`. No migration; the old DBs are discarded.

## Files
- `lokidoki/orchestrator/memory/store.py` (change one constant)
- `data/` (file deletions only — no git tracking)

## Actions

1. Delete the following files if present. These are all untracked DB artifacts:
   ```
   data/memory.sqlite
   data/memory.sqlite-shm
   data/memory.sqlite-wal
   data/memory.db
   data/lokidoki.db
   data/lokidoki.db-shm
   data/lokidoki.db-wal
   data/lokidoki.db.prePR1.bak
   data/lokidoki.sqlite
   data/dev_memory.sqlite
   data/_tmp_probe_people.db
   data/_tmp_probe_people2.db
   ```
   Use `rm -f` per file (never `rm -rf`). Do not delete `data/audio/`, `data/media/`, `data/models/`, `data/settings.json`, `data/smarthome_state.json`, `data/pronunciation_builtin.json`, `data/knowledge_gaps.jsonl`.

2. Open `lokidoki/orchestrator/memory/store.py`. Change the module constant:
   - **Before**: `DEFAULT_DB_PATH = Path("data/memory.sqlite")`
   - **After**:  `DEFAULT_DB_PATH = Path("data/lokidoki.db")`
   Nothing else changes in that file.

3. Confirm the legacy provider already points at the same file. Read `lokidoki/core/memory_provider.py` around `__init__` and `lokidoki/core/memory_singleton.py` — both should already reference `data/lokidoki.db`. No edit needed; if they don't match, stop and write a `## Blocker`.

## Verify

```bash
uv run python -c "from lokidoki.core.memory_singleton import get_memory_provider; from lokidoki.core.memory_store_singleton import get_memory_store; import asyncio; p = get_memory_provider(); asyncio.run(p.initialize()); s = get_memory_store(); print('provider:', p._db_path if hasattr(p, '_db_path') else 'ok'); print('store:', s._db_uri)" \
  && sqlite3 data/lokidoki.db ".tables" | tr -s ' ' '\n' | sort -u | grep -E '^(users|messages|characters|episodes|behavior_events|affect_window|user_profile|facts|people|sessions)$' | sort
```

Expected: both singletons point at `data/lokidoki.db`; the table listing includes at minimum `users`, `messages`, `characters` (legacy) AND `episodes`, `behavior_events`, `affect_window`, `user_profile` (v2). If the intersection is missing, that's expected schema-union work for Chunk 2 — add a **Deferred from Chunk 1** entry to `chunk-2-schema-union.md` and note which v2 tables didn't create.

## Commit message

```
chore(memory): collapse memory.sqlite into lokidoki.db as single store

Retire the separate v2 memory SQLite file. MemoryStore now defaults to
data/lokidoki.db so the v2 write path and the legacy read path land on
the same file. No migration — old DBs were discarded per plan.

Refs docs/memory_unify/PLAN.md chunk 1.
```

## Deferrals section (append as you discover)

*(empty — add `## Deferred to Chunk N` blocks here if issues arise that belong in a later chunk)*
