# Chunk 02 — Skills Foundation: Contracts + Registry Cleanup

**Source:** `docs/v2-skills-design.md` Phase 1 (Foundation And Contract Cleanup).
**Maps to:** Skills Design Phase 1.
**Prereqs:** None. Independent of memory work.

---

## Goal

Make the registry, handler wiring, and capability contracts truthful before adding new providers. Stop the drift between what the registry claims and what the runtime does.

---

## Work Items

### Must-do (this chunk)

1. **Standardize skill result contract.** Every handler returns: `output_text`, `success`, `error_kind` (enum: `invalid_params`, `no_data`, `offline`, `provider_down`, `rate_limited`, `timeout`, `internal_error`), `mechanism_used`, `data`, `sources`. Audit all existing handlers in `v2/orchestrator/skills/` and `v2/orchestrator/execution/executor.py`.

2. **Normalize registry descriptions.** Walk `v2/data/function_registry.json` — update every entry whose description says "live web search" when the runtime uses a curated local KB (travel, streaming, sports, people). Add a `maturity` field (values: `production`, `local_only`, `stub`, `limited`, `missing`) to every entry.

3. **First-class aliasing.** Replace duplicated full registry rows for aliases (`greet`/`greeting_response`, `summarize`/`summarize_text`, etc.) with canonical entry + `aliases: []` field. Update router/executor to resolve aliases.

4. **`max_chunk_budget_ms` on capabilities.** Add the field to the registry schema. Wire enforcement in the executor so fallback chains respect the budget.

5. **Audit shadow/orphan modules:**
   - `v2/orchestrator/skills/search_web.py` — promote to `search_web` capability or collapse into `sports_search.py`
   - `v2/orchestrator/skills/sports_search.py` — dead `get_score`/`get_standings`/`get_schedule` handlers (executor routes to `sports_api` instead). Delete dead handlers.
   - `v2/orchestrator/skills/sports_api.py` — dead `get_player_stats` placeholder. Delete.

6. **Remove central hard imports of optional skills.** Grep `v2/orchestrator/` for direct imports of specific skill modules. Replace with registry-based lookup.

7. **Restore v1 config passthrough.** Replace hardcoded fallbacks:
   - `v2/orchestrator/skills/weather.py`: `_DEFAULT_LOCATION = "your area"` -> merged per-skill config
   - `v2/orchestrator/skills/showtimes.py`: hardcoded fixture ZIP -> merged config from skill's `default_zip`

8. **Ban skill-local user-text heuristics.** Find skills that reparse `payload["chunk_text"]` with helpers like `_extract_location(...)`. Move that logic to decomposer/resolver params.

9. **Drift CI test.** New test: `tests/unit/test_skill_registry_drift.py` — fail if capability-registry handler references don't match executor wiring. This catches registry entries pointing to nonexistent handlers.

### Defer (post-cutover)

- Full plugin discovery seam (`~/.lokidoki/plugins/`)
- Separate domain capabilities from provider implementations into standalone packages (that's Skills Phase 3)

---

## Key Files to Read/Edit

| File | Action |
|---|---|
| `v2/data/function_registry.json` | Read + major edit (add maturity, aliases, max_chunk_budget_ms) |
| `v2/orchestrator/execution/executor.py` | Read + edit (alias resolution, budget enforcement, result contract) |
| `v2/orchestrator/skills/*.py` | Audit all ~20 files for result contract, hard imports, text reparsing |
| `v2/orchestrator/routing/router.py` | Edit if alias resolution changes routing |
| `tests/unit/test_skill_registry_drift.py` | New file |

---

## Gate Checklist

- [ ] Every `function_registry.json` entry has truthful description + `maturity` field
- [ ] Every skill result includes `output_text`, `success`, `error_kind`, `mechanism_used`, `data`, `sources`
- [ ] No central runtime module hard-imports a specific optional provider skill
- [ ] Skills with config needs read merged config, not hardcoded defaults
- [ ] No skill reparses `chunk_text` for missing user fields
- [ ] Capability aliases are explicit in schema, not duplicated rows
- [ ] `max_chunk_budget_ms` enforced in executor
- [ ] Drift CI test passes
