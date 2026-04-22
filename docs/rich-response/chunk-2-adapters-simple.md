# Chunk 2 — Retrofit simple / deterministic skills via adapters

## Goal

Add adapters for the four deterministic skills whose payloads are trivial and sourceless: `datetime_local`, `dictionary`, `unit_conversion`, `jokes`. These are the safest cohort to bring online before touching web-sourced skills. No consumer reads adapter output yet (Chunk 5 does the cutover), but every adapter must be fully populated and covered by tests.

## Files

- `lokidoki/orchestrator/adapters/datetime_local.py` — new.
- `lokidoki/orchestrator/adapters/dictionary.py` — new.
- `lokidoki/orchestrator/adapters/unit_conversion.py` — new.
- `lokidoki/orchestrator/adapters/jokes.py` — new.
- `lokidoki/orchestrator/adapters/__init__.py` — register the four new adapters.
- `lokidoki/orchestrator/core/pipeline_phases.py` — extend the adapter-call site to include these four `skill_id`s (remove the calculator-only `if`).
- `tests/unit/test_adapters_simple.py` — new. One test class per adapter.

Read-only: each skill's `skill.py` under `lokidoki/skills/<name>/skill.py`; `lokidoki/orchestrator/adapters/base.py`; `lokidoki/orchestrator/adapters/calculator.py` as reference.

## Actions

1. **`DateTimeAdapter`** (`skill_id = "datetime_local"`):
   - Expect `data` shape: `{"iso": "...", "local": "...", "timezone": "..."}` (verify against `skills/datetime_local/skill.py`).
   - `summary_candidates`: one string, the local-time phrase (e.g. `"Tuesday, April 21, 2026 at 3:42 PM PDT"`).
   - `facts`: `(iso_string, timezone_string)`.
   - No sources, no media, no follow-ups.

2. **`DictionaryAdapter`** (`skill_id = "dictionary"`):
   - Expect `data` shape with word + definitions + part-of-speech.
   - `summary_candidates`: one string per sense, up to three.
   - `facts`: one per sense (`"noun: ..."`, `"verb: ..."`).
   - `sources`: one `Source(title="Dictionary", url=<skill's source_url or None>, kind="skill")`.
   - `follow_up_candidates`: `("See synonyms", "See examples")` only if the skill's payload includes them.

3. **`UnitConversionAdapter`** (`skill_id = "unit_conversion"`):
   - Expect `data` shape: `{"input_value": ..., "input_unit": ..., "output_value": ..., "output_unit": ...}`.
   - `summary_candidates`: one string (`"5 miles = 8.047 kilometers"`).
   - No sources, no facts, no media.

4. **`JokesAdapter`** (`skill_id = "jokes"`):
   - Expect `data` with `setup` + `punchline` OR a single `joke` string.
   - `summary_candidates`: the joke text, joined if two-part.
   - `sources`: `Source(title=<skill provider name>, url=<source_url or None>, kind="skill")` if the skill carries attribution.
   - Everything else empty.

5. **Register** all four in `adapters/__init__.py` using the `register()` helper Chunk 1 added.

6. **Extend the pipeline adapter-call site**: the Chunk 1 code had `if skill_id == "calculator"` (or similar guard). Remove the guard — always call `adapt(skill_id, result)` for successful executions and rely on the registry returning an empty `AdapterOutput(raw=...)` for unregistered skills. This is the shape we want from Chunk 5 forward; starting it now avoids a second edit pass.

7. **Tests** — for each adapter, one test per happy path and one per graceful failure (empty data, missing expected field). Use static fixture dicts; do not invoke the real skill network paths.

8. **Grep check**: `rg -n "adapter_output" lokidoki/orchestrator/` should show only the pipeline-phase mutation and the adapter package. Nothing should be reading `adapter_output` downstream yet.

## Verify

```
pytest tests/unit/test_adapters_simple.py tests/unit/test_adapter_framework.py -v && pytest tests/unit/test_phase_execute.py -v
```

All tests pass. The pipeline still produces the same legacy output (no consumer reads adapter output yet).

## Commit message

```
feat(adapters): retrofit datetime, dictionary, unit_conversion, jokes

Four deterministic skills now emit AdapterOutput alongside their
existing MechanismResult. The pipeline attaches adapter_output on
every successful execution (not just calculator); downstream
consumers will begin reading it in chunk 5.

Refs docs/rich-response/PLAN.md chunk 2.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
