# Chunk 07 — Skills Runtime Wiring (Skills Phase 2)

**Source:** `docs/v2-skills-design.md` Phase 2 (Core Runtime Wiring).
**Prereqs:** C02 (Skills Foundation — contracts and registry must be truthful first).

---

## Goal

Replace placeholder runtime adapters with real ones. Introduce dynamic skill loading.

---

## What's Already Done (via Memory M3)

- `LokiPeopleDBAdapter` wired into v2 memory store (M3). The skills design calls for this but it's done.
- `ConversationMemoryAdapter` replacement is M4 (C01). Don't duplicate.

---

## What to Build

### 1. Dynamic skill loader
New module or extension to `v2/orchestrator/registry/loader.py`:
- Skills selected from registry/manifest at runtime, not hard-imported by executor.
- Reads both built-in core skills and installed plugin skills from configured roots.
- Executor calls loader instead of direct imports.

### 2. Typed parameter extraction
Extend decomposition/resolution so capabilities receive typed params:
- `location`, `zip`, `movie_title`, `person`, `date`, `origin`, `destination`, etc.
- This replaces skill-local `_extract_location(payload)` heuristics banned in C02.

### 3. HomeAssistant adapter swap
Replace `HomeAssistantAdapter()` defaults with `LokiSmartHomeAdapter` or real HA-backed seam. No more hardcoded demo devices.

### 4. Source propagation
Thread source metadata from adapters into `ResponseObject.sources` (complements C06).

---

## Key Files

| File | Action |
|---|---|
| `v2/orchestrator/registry/loader.py` | Major edit — dynamic loading |
| `v2/orchestrator/execution/executor.py` | Edit — use loader instead of imports |
| `v2/orchestrator/adapters/home_assistant.py` | Edit — swap adapter |
| `v2/orchestrator/pipeline/extractor.py` | Edit — typed param extraction |

---

## Gate Checklist

- [ ] People, device, memory resolution use real adapters
- [ ] External skills surface `sources` metadata end-to-end
- [ ] Runtime executes a skill without compile-time import
- [ ] Skills don't need `_extract_location(payload)` fallbacks
