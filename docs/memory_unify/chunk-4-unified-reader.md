# Chunk 4 — Unified reader (Memory UI sees v2 writes)

## Goal
The Memory UI (`/api/v1/memory/*`) displays whatever the gate-chain writer just wrote. The read path goes through `MemoryProvider` so the FastAPI route surface stays stable, but the provider's list/search methods now delegate to `MemoryStore` against the shared DB.

## Files
- `lokidoki/core/memory_provider.py` — reader methods only.
- `lokidoki/api/routes/memory.py` — just the `_decorate_fact` helper for the `category` default.
- End-to-end verification is manual for this chunk (chat → Memory UI).

## Actions

1. Read:
   - `lokidoki/core/memory_provider.py` — current `list_facts`, `list_people`, `list_relationships`, `list_fact_conflicts`, `search_facts`, `list_facts_about_person`, `list_unresolved_ambiguity_groups`.
   - `lokidoki/orchestrator/memory/store_facts.py` — `get_active_facts`.
   - `lokidoki/orchestrator/memory/store_social.py` — list_people / relationships equivalents.
   - `lokidoki/orchestrator/memory/reader.py` / `reader_search.py` — hybrid BM25/RRF search entry point.

2. Rewrite each reader body to call through `self._store` (set in Chunk 3). Use `asyncio.to_thread(...)` to keep the async signatures.
   - `list_facts(user_id, limit, project_id=None)` → `self._store.get_active_facts(owner_user_id=user_id, limit=limit)`. `project_id` filter: if not None, post-filter in Python unless the store gains native support — note a deferral if so.
   - `search_facts(user_id, query, top_k)` → call into the memory reader's hybrid search (the existing M2+M2.5 path).
   - `list_people` → `self._store.list_people(user_id)`.
   - `list_relationships` → `self._store.list_relationships(user_id)`.
   - `list_fact_conflicts` → `self._store.list_fact_conflicts(user_id)` (add the method if it doesn't exist — grouped by `(subject, predicate)`).
   - Mutation methods (`confirm_fact`, `reject_fact`, `patch_fact`, `delete_fact`, `merge_people`, `update_person_name`, `delete_person`, `add_relationship`, `set_primary_relationship`, `delete_relationship`, `create_person`, `resolve_ambiguity_group`): if a `MemoryStore` equivalent exists, delegate. If not, for this chunk leave them pointed at `memory_sql` (they write to the same DB now, so they'll still work) and add an entry to `chunk-7-dead-code-and-docs.md` under `## Deferred from Chunk 4` listing which ones still need store equivalents.

3. In `lokidoki/api/routes/memory.py::_decorate_fact`, handle missing `category` (v2 rows may not set it):
   - `out.get("category") or "general"` — already there; verify it survives the refactor.

4. Do **not** change the frontend or any other route.

## Verify

```bash
uv run python -m pytest tests/unit/test_memory_provider.py tests/unit/test_memory_people.py tests/integration/test_memory_people_api.py -q
```

Then manual smoke:
```bash
rm -f data/lokidoki.db data/lokidoki.db-shm data/lokidoki.db-wal
uv run python run.py &   # or the project's usual launch command
# In the browser: log in, chat "My name is Luke and I live in Brooklyn."
# Reload the Memory tab. Both facts should appear with a category badge
# and effective-confidence bar.
```

If the manual smoke isn't viable in this session, skip it and rely on the pytest gate plus a note in the commit body. Do not skip the pytest gate.

## Commit message

```
refactor(memory): route /api/v1/memory/* reads through the unified store

MemoryProvider list/search methods now delegate to MemoryStore against
the shared data/lokidoki.db. The Memory UI surface is unchanged; it now
sees whatever the gate-chain writer persists. Mutation methods that
don't yet have MemoryStore equivalents are deferred to chunk 7.

Refs docs/memory_unify/PLAN.md chunk 4.
```

## Deferrals section

*(empty)*
