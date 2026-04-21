# Rich Response — Execution Plan

Goal: turn LokiDoki's "mostly text plus attachments" chat into a **structured, block-oriented, progressively-rendered** experience while preserving skills-first, small-local-model, fully-offline operation on Pi 5 hardware. When every chunk below is `done`, the app ships: a unified skill adapter layer, a `ResponseEnvelope` + `Block` contract, additive SSE composition events, progressive rendering, a dedicated source surface with offline trust signals, planner-driven response modes, voice/visual parity, adaptive document handling, a security-first artifact surface, persona/memory-scoped workspaces, kiosk-grade UI polish, and local chat search.

Read [`docs/lokidoki-rich-response-design.md`](../lokidoki-rich-response-design.md) once per session. That is the design; this directory is the execution.

---

## How to use this document (Claude Code operating contract)

You are a fresh Claude Code session. You have been pointed at this file and given no other instructions.

**Do exactly this:**

1. Read the **Status** table below. Pick the **first** chunk whose status is `pending` — call it Chunk N.
2. Open `chunk-N-*.md` and read it completely. **Do not open any other chunk doc.**
3. Execute every step in its `## Actions` section.
4. Run the command in its `## Verify` section. If it fails, do not proceed — diagnose or record the block and stop. Do not fake success.
5. If verify passes:
   - Stage only the files the chunk touched.
   - Commit using the template in the chunk's `## Commit message` section. Follow `memory/feedback_no_push_without_explicit_ask.md` — **commit only; do not push, open a PR, or merge.**
   - Edit this `PLAN.md`: flip the chunk's row from `pending` to `done` and paste the commit SHA in the `Commit` column.
   - If during execution you discovered work that had to be pushed to a later chunk, append a `## Deferred from Chunk N` bullet list to that later chunk's doc with the specifics.
6. **Stop.** Do not begin the next chunk in the same session. Each chunk gets its own fresh context to keep token use minimal.

**If blocked** (verify keeps failing, required file is missing, intent of the chunk is unclear): leave the chunk status as `pending`, write a `## Blocker` section at the bottom of that chunk's doc explaining what's wrong, and stop. Do not guess.

**Scope rule**: only touch files listed in the chunk doc's `## Files` section. If work sprawls beyond that list, stop and defer the sprawl to a later chunk rather than expanding this one.

---

## Status

| # | Chunk | Status | Commit |
|---|---|---|---|
| 1 | [Adapter framework + shared source model + calculator pilot](chunk-1-adapter-framework.md) | done | f0db1ad (bundled) |
| 2 | [Retrofit simple skills via adapters](chunk-2-adapters-simple.md) | done | f0db1ad (bundled) |
| 3 | [Retrofit sourced skills via adapters](chunk-3-adapters-sourced.md) | done | f0db1ad (bundled) |
| 4 | [Retrofit media/media-heavy skills via adapters](chunk-4-adapters-media.md) | done | 6f7bde5 |
| 5 | [Adapter cutover — remove legacy shape handling](chunk-5-adapter-cutover.md) | done | 8a92e73 |
| 6 | [`ResponseEnvelope` + `Block` dataclasses (backend types)](chunk-6-envelope-types.md) | done | e9d22e3 |
| 7 | [Wire envelope through synthesis + persist snapshot](chunk-7-envelope-wire.md) | done | 29f2658 |
| 8 | [Frontend block registry + summary/sources/media renderers](chunk-8-block-registry-frontend.md) | pending | |
| 9 | [Emit `response_*` / `block_*` SSE events](chunk-9-response-events.md) | pending | |
| 10 | [Frontend consumes new events + progressive rendering + history replay](chunk-10-progressive-rendering.md) | pending | |
| 11 | [SourceSurface + structured citations + offline trust chip](chunk-11-source-surface.md) | pending | |
| 12 | [Response mode derivation (planner backend)](chunk-12-planner-mode-backend.md) | pending | |
| 13 | [Mode toggle UI + `/deep` slash command](chunk-13-mode-selection-frontend.md) | pending | |
| 14 | [`key_facts` / `steps` / `comparison` block renderers + enrichment budgets](chunk-14-blocks-text.md) | pending | |
| 15 | [`follow_ups` / `clarification` / `status` block renderers](chunk-15-blocks-meta.md) | pending | |
| 16 | [Voice parity — one-call synthesis + barge-in](chunk-16-voice-parity.md) | pending | |
| 17 | [Adaptive document handling (small inline / large RAG)](chunk-17-doc-strategy.md) | pending | |
| 18 | [Deep-work path with wall-clock cap + checkpoints](chunk-18-deep-mode.md) | pending | |
| 19 | [Artifact security foundation (sandboxed iframe + CSP)](chunk-19-artifact-security.md) | pending | |
| 20 | [ArtifactSurface UI + version navigation + export RPC](chunk-20-artifact-ui.md) | pending | |
| 21 | [Workspace lens (persona + memory scope)](chunk-21-workspace-lens.md) | pending | |
| 22 | [Kiosk / Pi display layout polish](chunk-22-kiosk-polish.md) | pending | |
| 23 | [Chat search — SQLite FTS find-in-chat + search-all-chats](chunk-23-chat-search.md) | pending | |

---

## Global context (read once, applies to every chunk)

### Hard rules (from CLAUDE.md — non-negotiable)

- **Offline-first runtime.** No block, artifact, source card, font, icon, map tile, or follow-up URL may reach a CDN, remote font service, remote tile server, remote analytics endpoint, or upstream model API at runtime. Every asset resolves to a file bootstrap already placed on disk.
- **No out-of-band installs.** No `pip install` / `uv add` / `npm install` / `brew install` from the agent shell. Python deps go in `pyproject.toml`; frontend deps in `frontend/package.json`; runtime binaries in `lokidoki/bootstrap/versions.py` + `lokidoki/bootstrap/steps.py` + `scripts/build_offline_bundle.py`.
- **No vendored third-party binaries, model weights, or bundled trees.** Repo is source + pins + install recipes.
- **No regex/keyword classification of user intent.** Planner branches on decomposer fields. New branching signals require extending `DecompositionResult` / the decomposer prompt + schema, re-measured against the 8,000-char `DECOMPOSITION_PROMPT` ceiling and 12-field schema ceiling. See [`lokidoki/core/prompts/decomposition.py`](../../lokidoki/core/prompts/decomposition.py).
- **Onyx Material + shadcn/ui only.** Every new component built from shadcn/ui primitives. No raw HTML elements, no bespoke design system.
- **No browser dialogs.** Never use `window.confirm` / `window.alert` / `window.prompt`. Use `frontend/src/components/ui/ConfirmDialog.tsx` or a `Dialog`-based component.
- **Push rules.** Commit only. Do not push / open a PR / merge unless the user explicitly says "push" (see [`memory/feedback_no_push_without_explicit_ask.md`](../../memory/feedback_no_push_without_explicit_ask.md) and [`memory/feedback_use_publish_all_script_to_push.md`](../../memory/feedback_use_publish_all_script_to_push.md)).

### Code landmarks (verified against current tree)

| Subsystem | Path | Key symbols |
|---|---|---|
| Orchestrator types | `lokidoki/orchestrator/core/types.py` | `ResponseObject` (L117), `RequestSpec` (L138), `PipelineResult` (L223) |
| Skill base | `lokidoki/core/skill_executor.py` | `BaseSkill` (L37), `MechanismResult` (L18), `SkillResult` (L27) |
| Streaming | `lokidoki/orchestrator/core/streaming.py` | `SSEEvent` (L22), `stream_pipeline_sse()` (L57), `_STEP_TO_PHASE` (L36) |
| Pipeline | `lokidoki/orchestrator/core/pipeline.py` | `run_pipeline_async()` (L41) |
| Pipeline phases | `lokidoki/orchestrator/core/pipeline_phases.py` | `run_pre_parse_phase`, `run_initial_phase`, `run_routing_phase`, `run_derivations_phase`, `run_resolve_phase`, `run_execute_phase`, `run_media_augmentation_phase` (L301), `run_synthesis_phase` (L329) |
| Media augmentor | `lokidoki/orchestrator/media/augmentor.py` | `augment_with_media()` |
| Decomposer prompt | `lokidoki/core/prompts/decomposition.py` | `DECOMPOSITION_PROMPT` (L16) |
| Decomposer client | `lokidoki/orchestrator/decomposer/client.py` | assembles routing decomposition JSON → `RouteDecomposition` |
| Decomposer types | `lokidoki/orchestrator/decomposer/types.py` | `RouteDecomposition` (L57) |
| FastAPI app | `lokidoki/main.py` | `app = FastAPI(...)` (L26) |
| Chat endpoint | `lokidoki/api/routes/chat.py` | streaming endpoint (L63), `StreamingResponse(...)` (L183) |
| Platform catalog | `lokidoki/core/platform.py` | `PLATFORM_MODELS`, `detect_profile()` |
| Memory / history | `lokidoki/orchestrator/memory/store_schema.py`, `lokidoki/core/memory_schema.py` | `sessions`, `messages` tables |
| Frontend chat page | `frontend/src/pages/ChatPage.tsx` | `PipelineState` interface (L64), `onEvent` handler |
| Frontend API types | `frontend/src/lib/api-types.ts` | `PipelineEvent` (L10), `SynthesisData` (L107), `SourceInfo` (L83), `MediaCard` (L88) |
| Frontend chat dir | `frontend/src/components/chat/` | `MessageItem.tsx`, `SourcesPanel.tsx`, `MediaBar.tsx`, `ThinkingIndicator.tsx`, `PipelineInfoPopover.tsx`, `ChatWelcomeView.tsx`, `ChatWindow.tsx`, `SourceChip.tsx`, `YouTubePlayer.tsx`, `YouTubeChannelCard.tsx` |
| Tests | `tests/unit/` | `test_streaming.py`, `test_synthesis.py`, `test_decomposer.py`, `test_phase*.py` |

### Existing decomposer output fields (informational)

The decomposer emits, via `lokidoki/orchestrator/decomposer/client.py`:

- routing asks: `intent`, `distilled_query`, `response_shape` (`verbatim` | `synthesized`), `requires_current_data`, `knowledge_source`, `capability_need`, `resolved_query`, `referent_anchor`, `referent_type`
- memory extraction: `subject_type`, `kind`, `predicate`, `value`, `subject_name`, `category`, `memory_priority`, `person_bucket`, `relationship_kind`, `negates_previous`

Later chunks consume these. Adding a new field to this list affects the 8,000-char `DECOMPOSITION_PROMPT` ceiling — measure before committing.

### Test conventions

- Backend: `pytest tests/unit/<file>`. The `Verify` block in every chunk must be runnable as-is from repo root.
- Frontend: `npm --prefix frontend run test` (vitest) and `npm --prefix frontend run build` (tsc + vite). Chunks that touch frontend must include a build check.
- Do **not** `uv add` / `npm install` from the agent shell. If a chunk needs a new dependency, add it to `pyproject.toml` / `frontend/package.json` and let bootstrap install it — the verify step calls the already-installed version or skips gracefully.

### Per-profile budget reminder

When a chunk adds measurable work to the request path (new skill, new synthesis field, new SSE event count), note its cost in the chunk's `## Deferrals` and against §14.6 of the design doc targets (`pi_cpu` is the binding profile).

---

## NOTE section (append-only cross-chunk discoveries)

<!--
Append entries like:

- 2026-04-22: Chunk 3 discovered that `news` skill returns tuples instead of dicts — added pre-adapter normalization; see chunk-3 Deferrals.
- 2026-04-25: Chunk 7 found synthesis prompt needs a `blocks_requested` field to stop the LLM from writing bullets the planner didn't allocate. Deferred to a Chunk 7.5 patch; recorded in chunk-7's Deferrals.

Do not rewrite prior entries. Do not delete blockers. Do not reorder.
-->

- 2026-04-21: Chunks 1–3 ran in a single codex session and landed as one combined commit (f0db1ad) instead of three. Going forward, one chunk per fresh session per commit. Resolver implementations don't carry `skill_id`, so chunks 1–3 introduced a `_HANDLER_TO_SKILL_ID` fallback map in `pipeline_phases.py`; fold this into chunk 5 (cutover). Recorded in chunk-3-adapters-sourced.md Deferrals.
- 2026-04-21: Chunk 5 folded in the `_HANDLER_TO_SKILL_ID` deferral. `skill_id` now lives on the registry implementations for calculator / datetime_local / dictionary / unit_conversion / jokes / knowledge / search / news, so `ImplementationSelection.skill_id` drives adapter dispatch directly and the fallback map is retired. `_phase_synthesis` / `_phase_media_augmentation` test files were created from scratch (they didn't exist yet — chunk 5's doc assumed they did, mirroring chunks 1–3's phantom-file pattern).
