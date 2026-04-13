# Chunk 15 — Skills Admin & Settings Pages: V2 Registry Rewire

**Source:** Gap identified during C10 review — admin/settings skills pages are entirely wired to v1.
**Prereqs:** C13 (v2 promoted to `lokidoki/orchestrator/`).

---

## Problem

Both `/settings/skills` and `/admin/admin-skills` are powered by the v1 `SkillRegistry` which reads manifests from `lokidoki/skills/`. C13 preserved `lokidoki/skills/` (the orchestrator adapters still import from it), so the pages currently show an empty list (manifests scan finds nothing new) but don't crash.

The promoted system uses `function_registry.json` (now at `lokidoki/orchestrator/data/`) with a different data model: capabilities + implementations instead of skill_id + intents + config_schema. The `DevSkillsExplorer` in dev tools shows capabilities but has no config, no toggles, and no test panel.

**C13 note:** `skill_factory.py` was deleted; the `test_skill` endpoint in `skills.py` returns 501 pending this rewire. `skill_executor.py` was kept (shared types). `skill_config.py` and `skill_cache.py` were kept as specified.

---

## Goal

Rewire both pages to read from the promoted v2 registry while preserving:
- The existing tile grid UI, search, category grouping
- Two-tier config (admin global / user personal) with secret masking
- Admin and user toggles
- Admin-only test panel
- The same component tree: `SkillsSection → SkillTile → SkillDetailDialog → SkillFieldRow`

---

## What's Reusable (keep as-is)

| Module | Why it survives C13 |
|---|---|
| `lokidoki/core/skill_config.py` | Generic key-value config storage against `skill_config_global` / `skill_config_user` tables. Uses `skill_id` as key — works for any identifier, including v2 capability names. |
| `skill_config_global` / `skill_config_user` SQLite tables | Already in `data/lokidoki.db` schema. No v1-specific columns. |
| `skill_enabled_global` / `skill_enabled_user` tables | Same — generic toggle storage. |
| Frontend components | `SkillsSection.tsx`, `SkillTile.tsx`, `SkillDetailDialog.tsx`, `SkillFieldRow.tsx` — UI-only, data comes from props. |

**C13 must NOT delete `skill_config.py` or the SQLite tables.** Add a note to chunk-13.md.

## What Must Be Replaced

| Old (v1) | New (v2) | Notes |
|---|---|---|
| `SkillRegistry(skills_dir="lokidoki/skills/")` in `skills.py` | Read capabilities from `function_registry.json` via promoted registry runtime | Registry data source swap |
| `_manifest_or_404(skill_id)` | `_capability_or_404(capability_id)` | Lookup by capability name |
| `_public_manifest(manifest)` | `_public_capability(entry)` | Map v2 fields to frontend-expected shape |
| `get_skill_instance()` + `SkillExecutor.execute_skill()` | `execute_chunk_async()` from promoted executor | Test panel uses v2 execution path |
| v1 manifest `config_schema` field | New `config_schema` in registry entries | See below |

---

## Config Schema for V2 Capabilities

v1 skills declared `config_schema` in their `manifest.json`:
```json
{
  "config_schema": {
    "global": [
      {"key": "api_key", "type": "secret", "label": "API Key", "required": true}
    ],
    "user": [
      {"key": "default_zip", "type": "string", "label": "Default ZIP Code"}
    ]
  }
}
```

v2's `function_registry.json` has no config_schema. Add it:

**Option A (recommended): Separate config manifest file.**
Create `v2/data/capability_config.json` (post-promotion: `lokidoki/orchestrator/data/capability_config.json`):
```json
{
  "get_weather": {
    "global": [
      {"key": "api_key", "type": "secret", "label": "OpenWeatherMap API Key", "required": true}
    ],
    "user": [
      {"key": "default_location", "type": "string", "label": "Default Location"}
    ]
  },
  "get_stock_price": {
    "global": [],
    "user": [
      {"key": "default_ticker", "type": "string", "label": "Default Ticker Symbol"}
    ]
  }
}
```

This keeps the function_registry focused on routing (capability + examples + implementations) and config separate. Capabilities with no config entry get an empty schema — they appear in the UI but have no configurable fields.

---

## Backend Changes

### `lokidoki/api/routes/skills.py` — Full rewrite

Replace the v1 registry with the promoted v2 runtime:

```python
# Old:
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor
from lokidoki.core.skill_factory import get_skill_instance
_registry = SkillRegistry(skills_dir="lokidoki/skills")
_registry.scan()

# New (post-C13 promotion):
from lokidoki.orchestrator.registry.runtime import get_runtime
from lokidoki.orchestrator.execution.executor import execute_chunk_async
```

Endpoint mapping:

| Endpoint | Change |
|---|---|
| `GET /api/v1/skills` | Iterate `runtime.capabilities` instead of `_registry.skills` |
| `GET /api/v1/skills/{id}` | Lookup by capability name in runtime |
| `PUT /api/v1/skills/{id}/config/global` | Keep — `skill_config.py` works as-is with capability name as skill_id |
| `PUT /api/v1/skills/{id}/config/user` | Keep — same |
| `PUT /api/v1/skills/{id}/toggle/global` | Keep — same |
| `PUT /api/v1/skills/{id}/toggle/user` | Keep — same |
| `POST /api/v1/skills/{id}/test` | Rewire to `execute_chunk_async()` with the capability's selected handler |
| `DELETE` endpoints | Keep — same |

The `_build_skill_view()` function adapts v2 registry entries to the existing frontend `SkillSummary` shape:

```python
def _build_capability_view(capability: str, entry: dict, config_schemas: dict, ...):
    schema = config_schemas.get(capability, {"global": [], "user": []})
    return {
        "skill_id": capability,           # frontend uses skill_id
        "name": _humanize(capability),    # "get_weather" → "Weather"
        "description": entry.get("description", ""),
        "intents": [capability],          # v2 has one capability per entry
        "examples": entry.get("examples", []),
        "config_schema": schema,
        "global": mask_secrets(global_vals, schema, "global"),
        "user": mask_secrets(user_vals, schema, "user"),
        "enabled": state["enabled"],
        "config_ok": state["config_ok"],
        "missing_required": state["missing_required"],
        "disabled_reason": state["disabled_reason"],
        "toggle": {"global": g_tog, "user": u_tog},
    }
```

### Test endpoint rewire

The admin test panel currently does:
```python
instance = get_skill_instance(skill_id)
result = await _executor.execute_skill(instance, mechs, params)
```

Replace with v2 execution:
```python
runtime = get_runtime()
impl = runtime.select_handler(0, capability)
chunk = RequestChunk(text=body.prompt, index=0)
route = RouteMatch(chunk_index=0, capability=capability, confidence=1.0, matched_text=capability)
resolution = ResolutionResult(chunk_index=0, resolved_target=body.prompt, source="admin_test", confidence=1.0, params={})
execution = await execute_chunk_async(chunk, route, impl, resolution)
```

This mirrors what `dev.py`'s `/v2/skills/run` already does.

---

## Frontend Changes

**Zero component changes needed.** The `SkillSummary` interface stays the same — the backend just populates it from the v2 registry instead of v1 manifests. The frontend renders whatever the API returns.

The only frontend change: after C13's API route rename (if `/api/v1/dev/v2/skills` becomes `/api/v1/dev/skills`), update the `V2SkillsExplorer` import in dev tools. But that's C13's scope, not C15's.

---

## Migration: Existing Config Data

Users who already configured v1 skills (e.g., set an API key for `weather_openmeteo`) have rows in `skill_config_global` and `skill_config_user` keyed by v1 `skill_id` (e.g., `weather_openmeteo`).

v2 capabilities use different names (e.g., `get_weather`). Two options:

**Option A (recommended): Migration script.** Map v1 skill_id → v2 capability name for capabilities that share config keys. Run once during C15.

**Option B: Fresh start.** Delete old config rows. Users re-enter their API keys. Acceptable for a personal device but annoying.

Provide the migration script but make it optional — users with no prior config are unaffected.

---

## Execution Order

1. Create `capability_config.json` with config schemas for all capabilities that need config
2. Rewrite `skills.py` to read from promoted v2 registry + config manifest
3. Rewire test endpoint to use v2 execution
4. Write migration script for existing v1 config rows
5. Run existing frontend — verify tiles, search, detail dialog, toggles, config, test all work
6. Write tests for the rewired endpoints
7. Update PROGRESS.md, IMPLEMENTATION_PLAN.md

---

## Gate Checklist

- [ ] `/settings/skills` loads and displays all 87 capabilities as tiles
- [ ] Tile search, category grouping, and status dots work
- [ ] Detail dialog shows description, examples, config fields
- [ ] Admin can set global config values (secret masking works)
- [ ] User can set personal config values
- [ ] Admin toggle and user toggle work independently
- [ ] Admin test panel sends prompt through v2 `execute_chunk_async` and shows result
- [ ] `skill_config.py` tables are preserved across C13 deletion
- [ ] Existing config data migrated (or migration script provided)
- [ ] Zero frontend component changes (same SkillsSection, SkillTile, SkillDetailDialog, SkillFieldRow)
