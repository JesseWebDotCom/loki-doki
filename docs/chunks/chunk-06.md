# Chunk 06 — Citations End-to-End

**Source:** `docs/v2-graduation-plan.md` §4.G.
**Prereqs:** C03 (persona + synthesis — the combine prompt is being rewritten there).

---

## Goal

Make skills populate `ResponseObject.sources` and the frontend render them. v1 used inline `[src:N]` markers with post-hoc sanitization; v2 should use structured sources.

---

## Current State

- `ResponseObject` already has the `sources` shape but no skills populate it.
- No citation logic in the combine prompt.
- v1 had sanitization at `orchestrator.py:1497-1511` — band-aid for model emitting wrong citations.

---

## What to Build

1. **Structured `sources` list.** Skills populate `ResponseObject.sources: [{title, url, skill_name}]`. No inline `[src:N]` markers needed.
2. **Skill-side propagation.** Audit provider-backed skills (weather, news, recipes, dictionary, etc.) and have them return source metadata in their result.
3. **Frontend rendering.** Add a sources section below the response in the chat UI — small, collapsible, shows where the info came from.
4. **Non-web sources.** For skills like calendar or calculator, `sources` stays empty — that's fine.

---

## Key Files

| File | Action |
|---|---|
| `v2/orchestrator/core/types.py` | Check `ResponseObject.sources` shape |
| `v2/orchestrator/skills/*.py` | Add source metadata to provider-backed skills |
| `v2/orchestrator/execution/request_spec.py` | Thread sources through |
| `frontend/src/components/chat/` | Add sources rendering |

---

## Gate Checklist

- [ ] Provider-backed skills populate `ResponseObject.sources`
- [ ] Frontend renders sources
- [ ] Citation accuracy >= 0.95 on a fact corpus (sources point to right skill)
