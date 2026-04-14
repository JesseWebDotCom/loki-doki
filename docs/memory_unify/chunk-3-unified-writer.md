# Chunk 3 — Unified writer (gate chain is the only way in)

## Goal
`MemoryProvider.upsert_fact`, `MemoryProvider.create_person`, and `MemoryProvider.add_relationship` become thin adapters that call through the `MemoryStore` gate-chain writer. After this chunk, no production code writes facts/people/relationships except via the gate chain.

## Files
- `lokidoki/core/memory_provider.py` (replace three method bodies only)
- `lokidoki/core/memory_sql.py` — keep `upsert_fact` / `create_person` / `add_relationship` functions in place; they're the SQL-layer helpers and the `MemoryStore` mixins already call the same kinds of SQL. Do not delete them in this chunk.
- Tests in `tests/unit/test_memory_provider.py`, `tests/unit/test_memory_m1.py`, `tests/unit/test_memory_m3.py`, `tests/unit/test_memory_people.py`.

## Actions

1. Read these to understand the shapes in/out:
   - `lokidoki/core/memory_provider.py` — current `upsert_fact` (≈line 557), `create_person`, `add_relationship`.
   - `lokidoki/orchestrator/memory/writer.py::process_candidate` — the gate-chain entry point; takes a `MemoryCandidate`-shaped dict.
   - `lokidoki/orchestrator/memory/candidate.py::MemoryCandidate` — exact field names the writer expects.
   - `lokidoki/orchestrator/memory/store_social.py` — methods the writer dispatches to for Tier 5.

2. Rewrite `MemoryProvider.upsert_fact` body:
   - Build a `MemoryCandidate` from the call args (`owner_user_id`, `subject`, `predicate`, `value`, `source_text`, `confidence`).
   - Call `process_candidate(candidate, store=self._store)` where `self._store` is a shared `MemoryStore` bound to the same DB (add `self._store = get_default_store()` in `MemoryProvider.__init__` if it's not already there).
   - Translate the returned `WriterDecision` back into the legacy `(fact_id, confidence, meta)` tuple the callers expect. If `decision.accepted=False`, return `(0, 0.0, {"accepted": False, "reason": decision.reason})` so callers see a soft failure rather than an exception.

3. Same pattern for `create_person` → `MemoryStore.create_person` / `upsert_provisional_person`, and `add_relationship` → `MemoryStore.add_relationship`. Preserve the existing async signatures by wrapping the sync store calls in `asyncio.to_thread(...)`.

4. Keep `_decorate_fact` in `routes/memory.py` happy: if `process_candidate` returns a row that lacks `category`, default to `"general"` inside the reader (handled in Chunk 4; for now, ensure the writer doesn't omit columns that break the FTS5 trigger).

5. Do not touch `memory_sql.py` function bodies in this chunk — just make sure they aren't called anymore from the provider layer. Leave the file otherwise untouched; dead-code deletion is Chunk 7.

## Verify

```bash
uv run python -m pytest tests/unit/test_memory_provider.py tests/unit/test_memory_m1.py tests/unit/test_memory_m3.py tests/unit/test_memory_people.py tests/unit/test_memory_contradiction.py -q
```

Expected: all green. If a provider test asserts on legacy `category` values the gate chain doesn't emit, either (a) teach the provider adapter to pass a category through to the candidate's metadata, or (b) relax the assertion if it's test-only scaffolding — noting which you chose in the commit message.

## Commit message

```
refactor(memory): route provider writes through the gate-chain writer

MemoryProvider.upsert_fact / create_person / add_relationship now
adapt their args into MemoryCandidate shape and call through
writer.process_candidate. All production writes now pass the gate chain
and land in the unified store. Legacy memory_sql.upsert_fact stays in
place for now; removal is Chunk 7.

Refs docs/memory_unify/PLAN.md chunk 3.
```

## Deferrals section

*(empty)*
