# Chunk 6 — De-`v2` identifiers

## Goal
No `v2` / `V2` / `_v2_` marker in our own code, tests, constants, or docstrings. External names (`pydantic v2`, URL paths like `/api/v2/…`, `sentence-transformers/all-MiniLM-L6-v2`) are external and stay.

## Files
Primary edit targets (grep-confirmed hits as of plan time):
- `tests/unit/test_registry_router.py` — ~14 `test_v2_*` function names.
- `tests/integration/test_dev_api.py` — ~11 `test_v2_*` function names.
- `tests/unit/test_cutover.py` — many `v2` references (unclear without reading; treat as rename if they mark version, keep if they describe a real cutover).
- `tests/unit/test_decomposer_budget.py` — ~14 occurrences.
- `tests/unit/test_skills_admin_rewire.py` — ~10 occurrences.
- `tests/unit/test_dev_memory_endpoints.py` — ~4 occurrences.
- Memory package docstrings: `lokidoki/orchestrator/memory/candidate.py` references "Pydantic v2" — that is external, keep. Any docstring that says "v2 memory" / "v2 writer" / "v2 store" is internal and must be scrubbed.

Do **not** rename:
- `sentence-transformers/all-MiniLM-L6-v2` in `embeddings.py`.
- `/api/v2/` external URL paths in skills.
- Anything in `frontend/package-lock.json`.
- Regression-corpus JSON values that mention `v2` as part of a prompt text.

## Actions

1. `rg '\bv2\b|V2|_v2_' --type py --type md --type json lokidoki/ tests/ docs/` — print the full list. For each hit, decide: external (leave) vs internal marker (rename).

2. For internal markers:
   - Test function names: strip the `_v2_` or `v2_` segment. Example: `def test_v2_dev_endpoint_requires_admin_auth` → `def test_dev_endpoint_requires_admin_auth`. If that creates a duplicate name in the same file, append a short differentiator (not `v2`).
   - Constants: any `V2_MEMORY_*` / `V2_*` that survives → drop the prefix.
   - Docstrings/comments: rewrite to describe the current unified system, not "the v2 version".

3. Ensure you do not rename any test in a way that changes what pytest's selection logic captures (e.g. CI filters on test name patterns). Search `.github/workflows/` and `pyproject.toml` for any `-k` expressions that filter on `v2` — if present, update them in the same chunk.

4. This chunk is **rename-only**. No behavior changes. If during rename you find a bug, stop, note it in the relevant future chunk's `## Deferred from Chunk 6` section, and keep moving.

## Verify

```bash
# Our own marker must be gone from Python and markdown in our dirs:
rg '\bv2\b|V2|_v2_' --type py --type md lokidoki/ tests/ docs/ | \
  grep -vE 'pydantic v2|MiniLM-L6-v2|/api/v2|v2-llm-bakeoff' && echo "FAIL" || echo "ok"
uv run python -m pytest -q
```

Expected: grep emits nothing after filtering the allowlist; full test suite still passes (the rename must not change pass count).

## Commit message

```
refactor: drop v2-version markers from internal names

Rename test functions, constants, and docstrings that carried a `v2`
marker from the split-system era. External names (Pydantic v2, URL
paths, the MiniLM-v2 model id) are untouched.

Refs docs/memory_unify/PLAN.md chunk 6.
```

## Deferrals section

*(empty)*
