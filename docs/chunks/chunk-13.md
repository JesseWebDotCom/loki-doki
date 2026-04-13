# Chunk 13 — V1 Deletion + V2 Promotion (no more "v2" anywhere)

**Source:** Gap identified during C10 review — no existing chunk covers this.
**Prereqs:** C10 (cutover complete), C11 (v1 skill ports finished).

---

## Goal

Delete all dead v1 code. Move `v2/orchestrator/` into `lokidoki/orchestrator/`. Erase every "v2" marker from file names, folder names, imports, test names, data files, and frontend components. After this chunk, the codebase has one orchestrator at `lokidoki/orchestrator/` and zero references to "v1" or "v2" as version labels.

---

## Why This Matters

The `v2/` top-level directory was a development scaffold — a clean room to build the replacement pipeline without touching v1. Now that v1 is retired (C10) and skills are ported (C11), the scaffold must be torn down. Leaving it creates:
- Confusion about which code is canonical
- Import paths that don't match the package name (`v2.orchestrator` vs `lokidoki`)
- Test names that suggest the feature is experimental when it's the only implementation
- Data files with version suffixes that will outlive their context

---

## Inventory (as of C10)

### V1 code to delete (~262 KB)

| File | Size | Notes |
|---|---|---|
| `lokidoki/core/orchestrator.py` | 81 KB | Main v1 pipeline |
| `lokidoki/core/orchestrator_skills.py` | 35 KB | v1 skill dispatch |
| `lokidoki/core/orchestrator_referent_resolution.py` | 37 KB | v1 referent resolver |
| `lokidoki/core/orchestrator_memory.py` | 15 KB | v1 memory integration |
| `lokidoki/core/orchestrator_referents.py` | 4.4 KB | v1 referent types |
| `lokidoki/core/decomposer.py` | 25 KB | v1 LLM decomposer |
| `lokidoki/core/decomposer_repair.py` | 43 KB | v1 Pydantic repair loop |
| `lokidoki/core/memory_phase2.py` | 12 KB | v1 memory phase 2 |
| `lokidoki/core/skill_executor.py` | 7.8 KB | v1 skill executor |
| `lokidoki/core/skill_factory.py` | 3.0 KB | v1 skill factory |
| `lokidoki/skills/` (20 modules) | — | Entire v1 skills directory |

**Pre-delete check:** grep the full codebase (excluding tests) for imports from each file. If any production path still references a v1 module, that import must be rewired or the module kept until it's replaced.

**DO NOT DELETE these v1 modules — they are reused by C15 (skills admin pages):**
- `lokidoki/core/skill_config.py` — generic config storage, works with v2 capability names
- `lokidoki/core/skill_cache.py` — result cache, potentially reusable
- SQLite tables: `skill_config_global`, `skill_config_user`, `skill_enabled_global`, `skill_enabled_user`, `skill_result_cache`

C15 rewires the `/api/v1/skills` endpoints to read from the promoted v2 registry while keeping this config layer. Deleting it would break the admin/settings skills pages with no replacement.

### V2 folder to promote (104 .py files)

```
v2/orchestrator/          →  lokidoki/orchestrator/
  adapters/               →  lokidoki/orchestrator/adapters/
  core/                   →  lokidoki/orchestrator/core/
  execution/              →  lokidoki/orchestrator/execution/
  fallbacks/              →  lokidoki/orchestrator/fallbacks/
  linguistics/            →  lokidoki/orchestrator/linguistics/
  memory/                 →  lokidoki/orchestrator/memory/
  observability/          →  lokidoki/orchestrator/observability/
  pipeline/               →  lokidoki/orchestrator/pipeline/
  registry/               →  lokidoki/orchestrator/registry/
  resolution/             →  lokidoki/orchestrator/resolution/
  routing/                →  lokidoki/orchestrator/routing/
  signals/                →  lokidoki/orchestrator/signals/
  skills/                 →  lokidoki/orchestrator/skills/
```

Delete `v2/data/` (dev artifacts only) and `v2/__init__.py`.

### Import rewrite (all files)

Every `from v2.orchestrator.X` becomes `from lokidoki.orchestrator.X`.

| Location | File count | Pattern |
|---|---|---|
| `v2/orchestrator/` internal | ~104 | `from v2.orchestrator.` → `from lokidoki.orchestrator.` |
| `lokidoki/` production | 4 | `chat.py`, `dev.py`, `dev_memory.py`, `v2_memory_singleton.py` |
| `tests/` | 43 | All `test_v2_*.py` files |
| `tests/fixtures/` | 2 | `v2_memory_*.json` |

### File renames

| Old | New |
|---|---|
| `lokidoki/core/v2_memory_singleton.py` | `lokidoki/core/memory_store_singleton.py` |
| `lokidoki/api/dev_memory.py` | `lokidoki/api/dev_memory.py` (keep name, rewrite internal `v2_dev_memory` references) |
| `tests/unit/test_v2_cutover.py` | `tests/unit/test_cutover.py` |
| `tests/unit/test_v2_citations.py` | `tests/unit/test_citations.py` |
| `tests/unit/test_v2_*.py` (43 files) | `tests/unit/test_*.py` (drop `v2_` prefix) |
| `tests/fixtures/v2_memory_extraction_corpus.json` | `tests/fixtures/memory_extraction_corpus.json` |
| `tests/fixtures/v2_memory_recall_corpus.json` | `tests/fixtures/memory_recall_corpus.json` |
| `tests/fixtures/v2_regression_prompts.json` | `tests/fixtures/regression_prompts.json` |
| `tests/fixtures/v2_people_resolution_corpus.json` | `tests/fixtures/people_resolution_corpus.json` |
| `tests/fixtures/v2_persona_corpus.json` | `tests/fixtures/persona_corpus.json` |

### Data file renames

| Old | New |
|---|---|
| `data/v2_memory.sqlite` | `data/memory.sqlite` |
| `data/v2_dev_memory.sqlite` | `data/dev_memory.sqlite` |

Update `DEFAULT_DB_PATH` in `store.py`, `DEV_DB_PATH` in `dev_memory.py`, and all references.

### Frontend renames

| Old | New |
|---|---|
| `V2MemoryPanel.tsx` | `MemoryPanel.tsx` |
| `V2PrototypeRunner.tsx` | `PrototypeRunner.tsx` (or merge into main chat) |
| `V2PrototypeStatusPanel.tsx` | `PrototypeStatusPanel.tsx` (or `PipelineStatusPanel.tsx`) |
| `V2SkillsExplorer.tsx` | `SkillsExplorer.tsx` |

Update all frontend imports and API endpoint paths that contain `/v2/`.

### API route renames

Dev-tool endpoints currently live under `/api/v1/dev/v2/...`:
- `/api/v1/dev/v2/run` → `/api/v1/dev/pipeline/run`
- `/api/v1/dev/v2/chat` → `/api/v1/dev/pipeline/chat`
- `/api/v1/dev/v2/status` → `/api/v1/dev/pipeline/status`
- `/api/v1/dev/v2/skills` → `/api/v1/dev/skills`
- `/api/v1/dev/v2/skills/run` → `/api/v1/dev/skills/run`
- `/api/v1/dev/v2/memory/*` → `/api/v1/dev/memory/*`

Frontend `api.ts` and components must be updated to match.

### Code-internal "v2" string references

Grep for `"v2"`, `'v2'`, `v2_`, `_v2`, `V2` in all .py, .ts, .tsx, .json files and update:
- Variable names: `v2_store` → `store`, `get_v2_memory_store` → `get_memory_store`
- Class names: `V2RunRequest` → `PipelineRunRequest`, `V2SkillRunRequest` → `SkillRunRequest`
- Comments/docstrings: "v2 pipeline" → "pipeline", "v2 prototype" → remove
- Log messages: `[v2]` prefixes → remove
- Phase constants: `M5_PHASE_*` etc. are fine (they're memory phase IDs, not version markers)

---

## Execution Order

This chunk is large. Split into 3 sub-sessions:

### Sub-session A: V1 deletion
1. Verify no production import reaches any v1 orchestration module
2. Delete the 10 v1 orchestration files listed above
3. Delete `lokidoki/skills/` directory (20 modules)
4. Delete v1-only tests (tests that import exclusively from deleted modules)
5. Run tests — expect v1-specific tests to vanish, all remaining tests green

### Sub-session B: V2 promotion (move + rewrite imports)
1. `git mv v2/orchestrator lokidoki/orchestrator`
2. Delete `v2/` remnants (`v2/__init__.py`, `v2/data/`)
3. Find-and-replace all `from v2.orchestrator` → `from lokidoki.orchestrator`
4. Rename `v2_memory_singleton.py` → `memory_store_singleton.py`, update all importers
5. Rename `DEFAULT_DB_PATH` from `v2_memory.sqlite` → `memory.sqlite`
6. Rename `DEV_DB_PATH` from `v2_dev_memory.sqlite` → `dev_memory.sqlite`
7. Run tests — all green

### Sub-session C: Cosmetic cleanup (renames, frontend, API routes)
1. Rename all 43 `test_v2_*.py` files (drop `v2_` prefix)
2. Rename fixture files (drop `v2_` prefix)
3. Rename frontend components (drop `V2` prefix)
4. Rename dev API routes (drop `/v2/` segment)
5. Update frontend `api.ts` to match new routes
6. Scrub remaining `v2`/`V2`/`_v2` references in code, comments, docstrings
7. Run full test suite + frontend build — all green
8. Update `IMPLEMENTATION_PLAN.md`, append to `PROGRESS.md`

---

## Gate Checklist

- [ ] Zero files under `v2/` directory (directory deleted)
- [ ] Zero files under `lokidoki/skills/` (v1 skills deleted)
- [ ] Zero v1 orchestration files in `lokidoki/core/` (10 files deleted)
- [ ] `grep -r "from v2\." lokidoki/ tests/ frontend/` returns zero hits
- [ ] `grep -r "v2_memory" lokidoki/ tests/` returns zero hits (excluding git history)
- [ ] `find . -name '*v2*' -not -path './.git/*'` returns zero hits
- [ ] `grep -rn "V2" lokidoki/ --include='*.py' | grep -v '__pycache__'` returns zero hits (class names, variable names)
- [ ] All tests pass
- [ ] Frontend builds and dev-tool pages load
- [ ] `data/memory.sqlite` is the production store path (no `v2_` prefix)
