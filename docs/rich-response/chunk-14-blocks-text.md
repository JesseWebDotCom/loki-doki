# Chunk 14 — `key_facts` / `steps` / `comparison` block renderers + enrichment budgets

## Goal

Expand the block registry with the three text-heavy renderers the planner has been pre-allocating since Chunk 12. Populate them from adapter output (facts) + synthesis prose (steps / comparison narrative). Apply the design doc's per-mode enrichment budgets so direct mode stays minimal while rich/deep get full structure.

## Files

- `frontend/src/components/chat/blocks/KeyFactsBlock.tsx` — new.
- `frontend/src/components/chat/blocks/StepsBlock.tsx` — new.
- `frontend/src/components/chat/blocks/ComparisonBlock.tsx` — new.
- `frontend/src/components/chat/blocks/index.ts` — register the three new renderers.
- `lokidoki/orchestrator/response/planner.py` — populate `key_facts.items` from `adapter_output.facts` (deterministic, no LLM), pre-allocate `steps` / `comparison` when mode/decomposer indicates how-to or comparison; mark them `loading` so synthesis fills prose.
- `lokidoki/orchestrator/response/synthesis_blocks.py` — new. Helper that extracts `steps` list and `comparison` structure from synthesis output via a minimal constrained JSON shape. Falls back to adapter-only content if constrained decoding isn't available on the current profile.
- `lokidoki/orchestrator/core/pipeline_phases.py` — call the synthesis_blocks helper for rich/deep turns.
- `tests/unit/test_synthesis_blocks.py` — new.
- `frontend/src/components/chat/__tests__/text-blocks.test.tsx` — new.

Read-only: design doc §15, §18.4; Chunks 6, 8, 12.

## Actions

1. **`KeyFactsBlock`** — vertical bullet list (shadcn `ul` style), up to 8 items. Each item is a short string. Skeleton shows 4 bullet placeholders while `loading`.

2. **`StepsBlock`** — ordered list. Each item is `{ n: number, text: string, substeps?: string[] }`. Renders as a numbered checklist. Keep visual weight low — no heavy card borders per step.

3. **`ComparisonBlock`** — two-column layout on ≥720px, stacked on narrower. `block.comparison` shape: `{ left: { title, items }, right: { title, items }, dimensions: string[] }`. Each dimension becomes a row comparing left vs right.

4. **Planner updates** (`planner.py`):
   - `key_facts` is always allocated from `adapter_output.facts` in `rich` / `deep` modes (facts are deterministic — no LLM needed). `state=ready` immediately if facts exist; `omitted` otherwise.
   - `steps` pre-allocated in `rich` for how-to/troubleshooting intents (use decomposer's `intent` / `capability_need` signal — no regex on user text) and in all `deep` turns.
   - `comparison` pre-allocated when decomposer indicates a comparison intent. If the decomposer can't currently signal this, leave a Deferral note — do NOT regex-scan user input.

5. **Synthesis blocks helper** (`synthesis_blocks.py`):
   - Prefer constrained JSON decoding (llama.cpp grammar / MLX constraint) to extract `steps: list[str]` and `comparison: dict` from the same synthesis call that writes `summary`. This is the "one-call synthesis" principle from §20.3.
   - If the current engine doesn't support constrained decoding or it's too slow on `pi_cpu`, fall back to:
     - `steps`: extract from adapter output when a how-to skill (e.g. recipes) already returned step text; otherwise omit the block (don't fabricate).
     - `comparison`: populate `left`/`right` labels from the two subjects in the decomposer output; leave `dimensions` empty if none available. The LLM can still write comparative prose into the `summary` block.
   - Log a profile-tagged metric so Open Question 1 (decoding speed on Pi) can be answered from real measurements.

6. **Enrichment budget enforcement** (planner):
   - `direct`: summary only. `key_facts` / `steps` / `comparison` must not appear.
   - `standard`: at most one of `key_facts` / `steps` / `comparison` — the most relevant.
   - `rich`: any / all as signaled.
   - `deep`: all three when the data supports them.
   - Encode this as a small table in `planner.py`, not scattered conditionals.

7. **Tests**:
   - Planner: mode budget table rejects blocks that exceed the allowance.
   - `test_synthesis_blocks`: constrained-decoding shape validates; fallback path produces a valid (possibly omitted) block; no block fabricated without adapter support.
   - Frontend: each block renders in `loading`, `partial`, `ready`, `omitted`, `failed` states.

## Verify

```
pytest tests/unit/test_synthesis_blocks.py tests/unit/test_response_envelope.py tests/unit/test_phase_synthesis.py -v && npm --prefix frontend run test -- text-blocks && npm --prefix frontend run build
```

All tests pass. Manual: send "compare Wikipedia vs Wikimedia" → `comparison` block appears; send "how do I fix a dripping faucet" → `steps` block appears.

## Commit message

```
feat(chat): key_facts / steps / comparison block renderers

Expand the block registry with three text-heavy renderers, backed
by deterministic adapter facts (key_facts) and constrained-JSON
synthesis output (steps, comparison) with graceful fallback when
constrained decoding is unavailable.

Planner enforces per-mode enrichment budgets: direct = summary
only; standard = one structured block max; rich/deep = all as the
data supports.

Refs docs/rich-response/PLAN.md chunk 14.
```

## Deferrals

- **True constrained decoding** — this chunk ships a lightweight
  JSON-island extractor (`<blocks:steps>{...}</blocks:steps>` +
  `<blocks:comparison>{...}</blocks:comparison>`) parsed with a regex
  over *LLM output* (permitted per CLAUDE.md for machine-generated
  text). Actual llama.cpp grammar / MLX constraint wiring is deferred
  to chunks 16 (voice parity — one-call synthesis with spoken shape)
  and 18 (deep mode). The metric is already tagged
  `source=constrained|adapter|none` + `profile=<profile>` so Open
  Question 1 can be answered from real measurements once the engines
  start emitting islands.
- **Synthesis prompt** — the current combiner prompt does NOT yet
  instruct the LLM to emit `<blocks:steps>` / `<blocks:comparison>`
  islands for `rich` / `deep` turns, so today every comparison / how-to
  turn falls back to the adapter path (recipes for steps, subject
  scaffold for comparison). Teaching the synthesis prompt to emit the
  islands belongs in chunk 16 (voice parity also tightens the
  prompt) — add a short instruction block gated on
  `spec.response_mode in {rich, deep}`.
- **Dedicated `comparison_subjects` decomposer field** — the planner
  currently derives left/right subject titles from the first two
  distinct adapter-source titles on the turn. A structured decomposer
  field (e.g. `subjects: [<name>, <name>]` when
  `response_shape=="comparison"`) would produce cleaner scaffolds and
  let the UI label things like "Wikipedia vs Wikimedia" instead of
  "Wikipedia article vs Wikimedia Foundation page". This requires a
  schema change against the 12-field ceiling in
  `docs/rich-response/chunk-12-planner-mode-backend.md`; recommend
  rolling it into the same chunk that adds the synthesis-prompt
  instruction above.
- **Decomposer cannot yet signal "how-to" vs "procedural" precisely**
  — the planner uses `capability_need="howto"` (LLM-emitted) and
  derived `response_shape="troubleshooting"` (deterministic from
  constraints + route capability lemmas). Both are real structured
  signals. A first-class `intent="howto"` field on the decomposer
  would be cleaner than piggybacking on `capability_need`, but the
  existing signals are enough for chunk 14's planner logic without
  regex over user text. Consider consolidating during chunk 18.
