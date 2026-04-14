# Chunk 5 — Collapse `memory_provider` and `memory_store` into one pipeline handle

## Goal
Pipeline code should pass exactly one memory handle. Today `chat.py` threads both `memory_provider` and `memory_store` into the context dict, and downstream hooks pick whichever they need. Post-chunk: context holds only `memory_provider`; anything that needs the raw sync store reads it from `memory_provider.store`.

## Files
- `lokidoki/api/routes/chat.py` — drop the `memory_store` key from context.
- `lokidoki/core/memory_provider.py` — expose a `store` property (already added in chunk 3).
- `lokidoki/orchestrator/core/pipeline_memory.py` — read `memory_provider` instead of `memory_store`.
- `lokidoki/orchestrator/core/pipeline_hooks.py` — same change; every `safe_context.get("memory_store")` becomes `safe_context.get("memory_provider").store` (guard for `None`).
- `lokidoki/orchestrator/execution/executor.py` — the `memory_provider or memory_store` fallback becomes just `memory_provider`.
- Any other call-site that reads `memory_store` from the context.

## Actions

1. Grep for every context key access: `rg 'memory_store' lokidoki/ --type py`. Triage into:
   - Read-from-context sites (replace with `memory_provider.store` after None-guard).
   - Tests that seed the context (update to seed `memory_provider`).
   - `chat.py` / `dev.py` write-to-context sites (remove the `memory_store` key).

2. Keep `memory_store` as a valid fallback *inside the provider only* — the module-level singleton `get_default_store()` still exists and still returns the shared store. This chunk just stops passing it around separately.

3. Do not touch `memory_singleton.py` or `memory_store_singleton.py`. The process-wide singletons stay; this chunk is about argument threading, not lifecycle.

4. Update any test helpers/fixtures that construct a pipeline context by hand to set `memory_provider` only. If a test still needs direct store access for assertions, it can call `provider.store` the same way production code now does.

## Verify

```bash
rg 'safe_context\.get\("memory_store"\)|safe_context\["memory_store"\]|context\["memory_store"\]' lokidoki/ && echo "FAIL: stale memory_store reads remain" || echo "ok: no stale memory_store reads"
uv run python -m pytest -q
```

Expected: the grep returns nothing (no stale reads), and the full test suite passes. If a single test still needs the old context shape, update it rather than reintroducing the key.

## Commit message

```
refactor(memory): pipeline context carries memory_provider only

Downstream hooks and handlers read the raw store via
memory_provider.store instead of a separate memory_store context key.
Collapses the two-handle pattern that was a holdover from the split-DB
era.

Refs docs/memory_unify/PLAN.md chunk 5.
```

## Deferrals section

*(empty)*
