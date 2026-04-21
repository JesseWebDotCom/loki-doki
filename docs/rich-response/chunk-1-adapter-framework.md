# Chunk 1 — Adapter framework + shared source model + calculator pilot

## Goal

Lay the foundation that every later chunk leans on. Introduce a **skill adapter layer** that converts raw `MechanismResult.data` into normalized response primitives (`summary_candidates`, `facts`, `sources`, `media`, `actions`, `artifact_candidates`, `follow_up_candidates`) plus a canonical `Source` model. Wire exactly one pilot adapter (`calculator`) through the orchestrator alongside the current raw path so we prove the shape end-to-end without retrofitting all 16 skills at once.

No block/envelope work, no frontend changes, no new SSE events. Pure backend scaffolding.

## Files

- `lokidoki/orchestrator/adapters/__init__.py` — new package marker + re-exports.
- `lokidoki/orchestrator/adapters/base.py` — new. `SkillAdapter` protocol + `AdapterOutput` dataclass + `Source` shared dataclass.
- `lokidoki/orchestrator/adapters/registry.py` — new. `ADAPTERS: dict[str, SkillAdapter]`, `resolve_adapter(skill_id)`, `adapt(skill_id, mechanism_result) -> AdapterOutput`.
- `lokidoki/orchestrator/adapters/calculator.py` — new. `CalculatorAdapter`.
- `lokidoki/orchestrator/core/pipeline_phases.py` — edit `run_execute_phase` (or the nearest post-execute aggregation point) to call `adapt(...)` for each successful execution when an adapter is registered, stash the `AdapterOutput` on the execution record. Legacy consumers keep reading `MechanismResult.data` unchanged.
- `tests/unit/test_adapter_framework.py` — new. Shape + contract tests for `AdapterOutput`, `Source`, registry resolution, and the calculator pilot.

Read-only: `lokidoki/skills/calculator/skill.py`, `lokidoki/core/skill_executor.py`, `lokidoki/orchestrator/core/types.py`.

## Actions

1. **Define the shared source model** in `adapters/base.py`:

   ```python
   @dataclass(frozen=True)
   class Source:
       title: str
       url: str | None = None            # None allowed for non-URL sources (local docs, calc attribution)
       kind: str = "web"                 # web | doc | memory | skill | local
       snippet: str | None = None
       page: int | None = None
       published_at: str | None = None   # ISO-8601 string, optional
       author: str | None = None
       relevance: float | None = None    # 0.0–1.0
   ```

2. **Define `AdapterOutput`** — the normalized primitives every adapter returns:

   ```python
   @dataclass(frozen=True)
   class AdapterOutput:
       summary_candidates: tuple[str, ...] = ()     # short phrasings the synthesizer may pick from
       facts: tuple[str, ...] = ()                  # atomic facts suitable for a key_facts block
       sources: tuple[Source, ...] = ()
       media: tuple[dict, ...] = ()                 # passthrough of already-typed media cards
       actions: tuple[dict, ...] = ()               # future cta_links payload (keep the shape open)
       artifact_candidates: tuple[dict, ...] = ()   # future artifact payload
       follow_up_candidates: tuple[str, ...] = ()
       raw: dict | None = None                      # escape hatch: original MechanismResult.data
   ```

3. **Define the `SkillAdapter` protocol**:

   ```python
   class SkillAdapter(Protocol):
       skill_id: str
       def adapt(self, result: MechanismResult) -> AdapterOutput: ...
   ```

4. **Registry** in `adapters/registry.py`:
   - Module-level `ADAPTERS: dict[str, SkillAdapter] = {}`.
   - `register(adapter: SkillAdapter)` helper (no decorator magic — explicit import + register is fine).
   - `resolve_adapter(skill_id)` returns the adapter or `None`.
   - `adapt(skill_id, result)` returns `AdapterOutput` — if no adapter is registered, returns an empty `AdapterOutput(raw=result.data)` so the pipeline is non-breaking.

5. **Pilot: `CalculatorAdapter`** in `adapters/calculator.py`:
   - `skill_id = "calculator"`.
   - On success, produce one `summary_candidate` (e.g. `"42"` or `"1 + 2 = 3"`) from `result.data`, no sources, no facts, no media.
   - On failure, empty `AdapterOutput` — the pipeline handles failure elsewhere.
   - Register it at import time in `adapters/__init__.py` so `from lokidoki.orchestrator.adapters import *` populates the registry.

6. **Wire into the pipeline** in `pipeline_phases.py`:
   - Find the post-execute aggregation site (immediately after `run_execute_phase` populates executions; before `run_media_augmentation_phase`).
   - For each execution where `skill_id == "calculator"` and `MechanismResult.success`, call `adapt(skill_id, mechanism_result)` and attach it to the execution record under a new attribute `adapter_output: AdapterOutput | None`. For every other skill, leave `adapter_output=None`.
   - Do **not** consume `adapter_output` yet — nothing downstream reads it in this chunk.

7. **Tests** in `tests/unit/test_adapter_framework.py`:
   - `Source` dataclass rejects missing required fields.
   - `AdapterOutput` defaults to empty tuples and `raw=None`.
   - `resolve_adapter("unknown")` returns `None`; `adapt("unknown", result)` returns an empty `AdapterOutput` with `raw` set.
   - `CalculatorAdapter.adapt(MechanismResult(success=True, data={"result": 3, "expression": "1+2"}))` returns a non-empty `summary_candidates`.
   - Pipeline integration test: run one calculator turn end-to-end (using the existing test fixtures in `tests/unit/test_phase*.py` for the shape) and assert the calculator execution record carries a populated `adapter_output`.

8. **Type-check sweep**: `AdapterOutput` and `Source` are immutable (`frozen=True`); the pipeline mutation is a single attribute assignment on the execution record. If the current execution record is a frozen dataclass, add the field to its definition (minimal change) rather than monkey-patching.

## Verify

```
pytest tests/unit/test_adapter_framework.py -v && pytest tests/unit/test_phase_execute.py tests/unit/test_streaming.py -v
```

All tests pass. The streaming test confirms we did not break the existing event stream.

## Commit message

```
feat(adapters): introduce skill adapter framework + calculator pilot

Skills currently emit heterogeneous MechanismResult.data shapes, which
forces each downstream consumer (synthesis, UI, future block planner)
to understand every skill's payload. Introduce a normalized
AdapterOutput (summary_candidates, facts, sources, media, actions,
artifact_candidates, follow_up_candidates) plus a canonical Source
model, and wire a calculator pilot through the pipeline alongside the
existing raw path — no consumer reads the adapter output yet.

This is the foundation every later rich-response chunk depends on;
shipping the block contract before adapters would guarantee per-skill
UI sprawl.

Refs docs/rich-response/PLAN.md chunk 1.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
