# LokiDoki Rich Response Design

## Status
Revised draft (direction + contract, not an execution plan)

## Revision Notes (vs. prior Codex draft)

Changes made during LokiDoki-specific review:

- **Source-of-truth fix** — the original referenced `docs/spec.md` indirectly; the canonical doc is `docs/DESIGN.md`. Added explicit dependency block.
- **Factual correction** — the original claimed LokiDoki has "no explicit detail policy." The decomposer already emits `response_shape`, `reasoning_complexity`, `capability_need`, `requires_current_data`; DESIGN.md documents response-shape-aware prompting. Gap is "signals don't flow into UI," not "signals don't exist." §2.2 corrected.
- **CLAUDE.md hard-rule enforcement** — added §6.2 covering offline-first runtime (no CDN, no remote fonts/tiles/APIs), no-out-of-band installs, no-vendored-binaries, no-regex-intent, shadcn/ui + Onyx Material, no `window.confirm`, prompt-budget ceiling, Pi memory envelope.
- **Deterministic block assembly** (§18.4) — made explicit the bet that makes this design work on a 4B model: planner + adapters assemble structure; LLM writes only prose in scoped block types.
- **Artifact security** (§17.4.1) — added non-negotiable sandboxed iframe + strict CSP + no-remote-resources + bundled-vis-libs rules. LLM-authored HTML in the main origin is a release-blocker.
- **Deep mode contract** (§10.4) — explicit user opt-in, wall-clock cap, checkpointed writes, single-concurrent, dedicated task. Prevents accidental minute-long Pi inferences.
- **Workspace recast** (§17.5) — LokiDoki is single-user local; workspace = persona + memory lens, not multi-tenant folder tree. Removes AnythingLLM's cloud-scale concept.
- **Planner input contract** (§16.0) — planner consumes existing decomposer fields; new signals require `DecompositionResult` schema extension within the 8,000-char ceiling, not keyword scans.
- **Transport hardening** (§11.4, §12) — delta/append events only, block count soft cap, `response_snapshot` for cheap history replay, event additivity so existing frontend consumers stay compatible.
- **Per-profile timing budgets** (§14.6) — concrete numbers for `mac` / `pi_hailo` / `pi_cpu` so regressions are visible.
- **Offline degradation** (§23.5) — explicit behavior for every failure mode in offline operation; offline indicator as a trust signal.
- **Rollout reorder** (§25) — adapter layer is Stage 1 (prerequisite), source-first trust moves to Stage 4 (high value / low risk), artifacts move to Stage 10 with security gates, voice parity elevated to Stage 7 so voice never lags visual.
- **Reference URL fixes** — [R15] AnythingLLM → canonical `Mintplex-Labs/anything-llm`; [R16] Perplexica → canonical `ItzCrazyKns/Perplexica`. Prior URLs pointed to forks.
- **Section numbering** — fixed duplicate-numbered sections (8/9/9, 18.x inside §19, etc.) that had drifted across revisions.
- **Execution disposition** — marked this as vision/contract; actual build-out requires `docs/rich-response/PLAN.md` + chunk docs per CLAUDE.md chunked-plan rule.
- **Open questions** (§27) — surfaced unresolved items (constrained decoding on `pi_cpu`, decomposer field growth, artifact dep bundle size, history migration, mode-toggle UX, per-profile enrichment budgets) rather than pretending they're settled.

## Source Of Truth
This document depends on:

- [`docs/DESIGN.md`](DESIGN.md) — canonical architecture (there is no `docs/spec.md`).
- [`CLAUDE.md`](../CLAUDE.md) — hard rules: offline-first runtime, no-CDN, no-regex-intent, chunked-plan pattern, decomposer prompt-budget ceiling, Onyx Material UI, shadcn/ui only.
- [`lokidoki/core/platform.py::PLATFORM_MODELS`](../lokidoki/core/platform.py) — profile-driven model catalog.
- [`lokidoki/core/prompts/decomposition.py`](../lokidoki/core/prompts/decomposition.py) — the decomposer already emits `intent`, `response_shape`, `capability_need`, `requires_current_data`, `knowledge_source`, `reasoning_complexity`. The planner in this redesign MUST consume those signals; new branching signals require a schema field on the decomposer (and a prompt-budget re-check), not a regex.

If anything here contradicts DESIGN.md or CLAUDE.md, those win.

## Execution Disposition
This is a **vision + contract document**, not an execution plan. Per CLAUDE.md's chunked-plan rule, actual build-out MUST be authored as `docs/rich-response/PLAN.md` + per-chunk docs before any code ships. The rollout outline in §24 is the raw material for that PLAN, not a replacement for it.

## Purpose
This document updates LokiDoki's response design so the product keeps its core advantage:

- skills first
- small local models
- fast and accurate answers on Raspberry Pi class hardware
- fully offline at runtime — bootstrap is the only network boundary

while feeling substantially richer, more polished, and more confidence-inspiring in the chat experience.

The goal is not to make LokiDoki imitate ChatGPT by pushing more work into the model. The goal is to make LokiDoki feel rich because the application layer is rich.

---

# 1. Product Reality

LokiDoki is intentionally not "LLM first."

That is correct and should not change.

The app is strongest when it:

- answers quickly from deterministic skills
- stays accurate by pulling fresh data when needed
- runs well on light hardware
- uses the LLM mostly to stitch, phrase, and smooth the result

The current weakness is not the underlying architecture. The weakness is that the response payload and chat rendering are still mostly "final text plus optional extras," which makes the experience feel thinner than modern chat products even when LokiDoki is right.

The design direction is therefore:

> Keep the skills-first architecture. Upgrade the response contract, orchestration, and rendering model so results arrive as progressive, structured, rich blocks instead of one mostly-text answer.

---

# 2. Current App Review

This section reflects the current codebase, not a hypothetical future app.

## 2.1 What LokiDoki already does well

The current app already has important foundations:

- SSE pipeline streaming exists today through `lokidoki/orchestrator/core/streaming.py`.
- The chat page already consumes phased events and builds live pipeline state in `frontend/src/pages/ChatPage.tsx`.
- The UI already renders streamed interim text, source chips, a sources side panel, and media cards in:
  - `frontend/src/components/chat/MessageItem.tsx`
  - `frontend/src/components/chat/SourcesPanel.tsx`
  - `frontend/src/components/chat/MediaBar.tsx`
  - `frontend/src/components/chat/ThinkingIndicator.tsx`
  - `frontend/src/components/chat/PipelineInfoPopover.tsx`
- The pipeline already supports skill execution before synthesis in `lokidoki/orchestrator/core/pipeline.py`.
- Media augmentation already exists as a separate structural phase before synthesis through `lokidoki/orchestrator/media/augmentor.py`.
- The synthesis payload already supports `sources`, `media`, and `spoken_text`, which is a strong base for visual/audio divergence.

This means LokiDoki is not starting from zero. It already has the beginnings of a rich response system.

## 2.2 Current gaps

The current experience still feels minimal for five reasons:

1. Richness is attached late.
   Sources and media mainly land with `synthesis.done`, so the response still feels like "wait for the final answer."

2. The response object is text-centric.
   `ResponseObject` ([`lokidoki/orchestrator/core/types.py`](../lokidoki/orchestrator/core/types.py)) carries only `output_text`; the richer payload lives in `RequestSpec` + loose SSE events keyed by phase string. There is no shared "renderable block" abstraction.

3. Progress is informative but not productized.
   The pipeline popover is useful for observability, but it is not the same as user-facing staged response composition. Users see phase churn, not a growing answer.

4. A detail signal exists but is not leveraged end-to-end.
   The decomposer already emits `response_shape` (`verbatim` | `synthesized`), `reasoning_complexity` (`fast` | `thinking`), `capability_need`, and `requires_current_data`. DESIGN.md references "response-shape-aware prompting" for comparison/recommendation/troubleshooting/utility shapes. But these signals do not yet flow into a UI-level response mode, block allocation, or enrichment budget — they stop at prompt selection.

5. The UI lacks a stable rich-answer frame.
   There is no consistent shell for summary, key facts, sources, media, related follow-ups, and "still working" sections.

6. Skill output is not normalized.
   Each skill returns its own `MechanismResult.data` dict shape. Without a shared adapter layer the proposed block contract will be re-implemented per skill, which is exactly the sprawl we want to avoid.

## 2.3 Root design problem

LokiDoki currently has a strong execution pipeline but a weak response assembly contract.

That is why the app can be fast and correct yet still feel plain.

---

# 3. Onyx Review And Specific Takeaways

Onyx is useful here because it is explicitly positioned as an application layer for LLMs, not just a prompt wrapper. That matches the direction LokiDoki should lean into. [R1]

## 3.1 What Onyx appears to do well

Based on the current repository and docs:

- Onyx frames the product as a feature-rich application layer above models, connectors, search, tools, and artifacts rather than expecting the model alone to create richness.
- Onyx separates experiences by intent.
  The docs describe both a Chat UI and a Search UI, and say queries classified as document search can automatically go to the Search UI instead of forcing every question through the same chat surface. [R2]
- Onyx makes mode and tool scope explicit in the chat UI itself.
  Their Chat UI docs describe an interface with an Auto/Chat mode selector, an Actions selector with four built-in actions (`Internal Search`, `Web Search`, `Code Execution`, `Image Generation`), and a Deep Research hourglass toggle for much heavier multi-cycle work. [R11]
- Onyx treats citations as first-class UI.
  Their Chat UI docs say the right sidebar contains sources and citations from Internal Search and Web Search, and that documents in that sidebar can be selected into the next chat turn. The changelog also shows citation-specific chat fixes, which implies sources are a primary part of the answer frame rather than a loose appendix. [R3][R11]
- Onyx invests in chat internals, not just styling.
  Their January 31, 2026 and December 30, 2025 docs describe a rebuilt chat experience, custom conversation/context architecture, parallel tool calling, and agents-as-tools. [R3]
- Onyx gives deeper work its own mode.
  Deep Research is called out separately in chat, may take minutes, and may cost more than 10x a normal inference; Craft/artifacts run in their own dedicated flow rather than trying to make every normal answer do everything. [R1][R3][R4][R11]
- Onyx uses artifacts as a separate product surface.
  Craft creates apps, documents, and presentations in isolated sandboxes with preview/iterate/export loops. This is not just "longer chat output." [R4]

## 3.2 What LokiDoki should copy

LokiDoki should adopt these product patterns:

- separate "answering" from "searching"
- separate "normal chat richness" from "deep work"
- make citations/sources part of the core answer shell
- use planner/orchestrator improvements to drive UI richness
- treat richer outputs as dedicated structured modes, not just longer markdown

## 3.3 What LokiDoki should not copy directly

LokiDoki should not copy the heavyweight parts of Onyx literally:

- not the connector-heavy enterprise architecture
- not a cloud-first or web-first assumption
- not rich responses that depend on large context windows and large hosted models
- not artifact generation as the default answer path

Onyx can spend more budget on infrastructure and model context. LokiDoki must hit a similar product feeling with much stricter latency and hardware limits.

## 3.4 Translation For LokiDoki

The practical translation is:

- Onyx Search UI -> LokiDoki should have a response mode that can pivot into a search-style result layout when the user wants retrieval more than synthesis.
- Onyx citation sidebar -> LokiDoki should treat sources as a persistent answer region, not just inline chips.
- Onyx deep research mode -> LokiDoki should reserve `deep` mode for explicit high-effort asks instead of making all turns heavier.
- Onyx artifacts/Craft -> LokiDoki should eventually support dedicated artifact/report outputs as a separate mode, not as part of standard chat turns.
- Onyx actions selector -> LokiDoki should make major optional capabilities legible to the user instead of hiding all richness behind one generic send flow.
- Onyx chat internals work -> LokiDoki should improve response planning and response assembly before trying to "sound more like ChatGPT."

---

# 4. Open WebUI Review And Specific Takeaways

Open WebUI is useful for a different reason than Onyx. It exposes more of the UI and event model around citations, artifacts, code execution, and workspace-like conversation organization. [R5][R6][R7][R8][R9][R10]

## 4.1 What Open WebUI appears to do well

Based on the current docs and reviewed source snippets:

- Open WebUI treats artifacts as a dedicated right-side surface, not just inline rich markdown.
  Its docs say artifacts appear in a dedicated window to the right side of the main chat, and the source snippet shows version navigation plus copy/close controls. [R5][R8]
- Open WebUI is explicit about what qualifies as an artifact.
  It supports single-page HTML, SVG, complete webpages with HTML/CSS/JS, and interactive JS visualizations such as ThreeJS or D3, while explicitly excluding markdown documents, plain text, code snippets, and React components. [R5]
- Open WebUI makes citations a structured payload, not a formatting afterthought.
  Its tool docs define a `citation` event with `document`, `metadata`, and `source` fields, and the citation modal source snippet shows support for source name, page number, parameters, relevance, and content. [R6][R8]
- Open WebUI documents an important streaming/tooling tradeoff.
  In default function-calling mode, message and delta event emitters work fully; in native mode, many message-update event types are overwritten by authoritative completion snapshots, while citations, files, and follow-ups remain compatible. [R6]
- Open WebUI turns chat organization into reusable workspaces.
  Folders can carry system prompts and attached knowledge that automatically apply to every new chat inside the folder. [R9]
- Open WebUI separates persistent long-form work from normal chat.
  Notes are a dedicated workspace for curated long-form content that exists independently of any single conversation. [R10]

## 4.2 What LokiDoki should copy

LokiDoki should adopt these product patterns:

- artifact-like outputs must live in a distinct visual surface
- artifact eligibility must stay narrow and explicit
- citations should use a real structured payload
- streaming design must account for tool-calling mode constraints
- project/chat organization can double as reusable context/workspace configuration
- long-form working documents should eventually live outside the normal chat flow

## 4.3 What LokiDoki should not copy directly

LokiDoki should not blindly copy Open WebUI behavior:

- not every large response should become an artifact
- not every code block should become a side canvas
- not every workspace concept should become a full content-management system
- not every event type should be added if it complicates Pi-friendly local execution

The key lesson is disciplined surface separation, not feature sprawl.

## 4.4 Translation For LokiDoki

The practical translation is:

- Open WebUI artifacts -> LokiDoki should reserve artifact/report surfaces for renderable, independently useful outputs, not ordinary prose or code snippets. [R5]
- Open WebUI citations -> LokiDoki should move to structured source/citation events and richer source metadata display. [R6][R8]
- Open WebUI mode-compatibility lesson -> LokiDoki should make source/block updates more durable than token-only deltas so rich rendering survives provider/tool-calling differences. [R6]
- Open WebUI folders/projects -> LokiDoki can evolve project chats into reusable response context/workspaces without forcing every turn to rebuild state from scratch. [R9]
- Open WebUI notes -> LokiDoki should eventually separate "chat answer" from "persistent working document" when users are writing, researching, or curating content over time. [R10]

---

# 5. Additional Product Comparisons

The following products are also useful references, but the evidence quality is different from Onyx and Open WebUI.

## 5.1 LM Studio

LM Studio is useful primarily through official docs and release notes rather than source-level UI review, because the app is not open source. [R12][R13][R14]

Specific takeaways:

- LM Studio uses adaptive document handling.
  Its `Chat with Documents` docs say short files may be inserted in full when they fit the model context, while long files trigger retrieval-based chunking/RAG instead. [R13]
- LM Studio treats offline/local document chat as a core capability.
  The docs emphasize local document attachment and offline operation, which is highly relevant for LokiDoki's local-first positioning. [R12][R13]
- LM Studio has elevated conversation search into a first-class feature.
  Their September 24, 2025 release added both `Find in Chat` and search across all conversations. [R14]

Translation for LokiDoki:

- when attached context is small enough, prefer full-inline context over unnecessary retrieval [R13]
- when attached context is large, switch cleanly into retrieval mode instead of pretending one strategy fits all [R13]
- chat-history search should eventually become a product feature, not just an internal memory mechanism [R14]

## 5.2 AnythingLLM

AnythingLLM is useful as a workspace-first comparison point. [R15]

Specific takeaways:

- the product centers context isolation around workspaces
- workspaces can share documents while keeping conversational context separate
- in-chat citations are treated as a core feature

Translation for LokiDoki:

- project- or workspace-level context boundaries should be explicit and user-legible [R15]
- reusable chat context should be attached to a named workspace/project rather than silently inferred every turn [R15]

## 5.3 Perplexica

Perplexica is useful as a search-first reference rather than a general chat reference. [R16]

Specific takeaways:

- the product positions itself as an AI-powered search engine, not just an LLM chat
- current/fresh web grounding is the center of the value proposition
- search behavior is primary and synthesis sits on top of it

Translation for LokiDoki:

- retrieval-heavy turns should feel evidence-first, not prose-first [R16]
- search-style UI should not be treated as a fallback; for some asks it is the correct primary mode [R16]

## 5.4 Evidence quality note

For Onyx and Open WebUI, this document includes some implementation-relevant details verified from source snippets and official docs. [R2][R6][R8][R11]

For LM Studio, AnythingLLM, and Perplexica, the guidance here is based on official docs, release notes, or repository-level product descriptions rather than equivalent deep source tracing. [R12][R13][R14][R15][R16]

That still makes them useful product references, but they should be treated as directional examples, not exact implementation blueprints.

---

# 6. Non-Negotiable Design Constraints

Any rich-response redesign must preserve these constraints:

## 6.1 Core architecture invariants

- Skills-first remains the default architecture.
- Small local models remain the primary synthesis path.
- The first useful answer must appear as early as possible.
- Richness must come mostly from app assembly and rendering, not bigger prompts.
- The system must degrade gracefully on Pi hardware.
- Rich content must never require a second large-model pass just to look polished.
- Voice output and visual output may differ, but both must come from the same response plan.
- Artifact/report surfaces must be planner-driven or explicitly requested, not the default rendering outcome for ordinary turns.
- Document handling should be adaptive: full-context when cheap, retrieval when necessary. [R13]

## 6.2 LokiDoki-specific enforcement (CLAUDE.md hard rules)

These are non-negotiable and override anything else in this document:

- **Offline-first at runtime.** No block, artifact, source card, media card, font, icon, map tile, or follow-up link may reach a CDN, remote font service, remote tile server, remote analytics endpoint, or upstream model API at runtime. Every asset resolves to a file bootstrap already placed on disk. If a feature needs upstream data, it is a bootstrap step, not a runtime fetch.
- **No new dependencies added outside bootstrap.** New runtime libraries (e.g. a block renderer, a diagram library, a syntax highlighter) must go through `pyproject.toml` / `frontend/package.json` / `lokidoki/bootstrap/versions.py` — never `pip install` / `npm install` from the agent shell.
- **No vendored third-party artifacts.** If artifact mode ever supports visualization libs (D3, ThreeJS, Mermaid), they are installed via `frontend/package.json` and bundled by Vite. Never checked in as blobs, never loaded from a CDN at runtime.
- **No regex/keyword classification of user intent.** The planner (§15) branches on decomposer fields. New branching signals require extending `DecompositionResult` and the decomposer prompt/schema, re-measured against the 8,000-char ceiling and 12-field ceiling. No keyword scans of `user_input`.
- **Onyx Material + shadcn/ui only.** Every new block renderer, source surface, artifact surface, and follow-up chip is built from shadcn/ui primitives on the Onyx Material design system.
- **No browser dialogs.** Clarification blocks, artifact-close confirmations, source-selection prompts, etc. use `ConfirmDialog` / `Dialog` — never `window.confirm` / `alert` / `prompt`.
- **Prompt budget discipline.** Any new decomposer field for block planning must keep `DECOMPOSITION_PROMPT` under 8,000 chars and total required schema fields under 12. Derive in Python when the value is computable from existing fields.
- **Pi memory budget.** Frontend-held per-turn state must fit in the 400 MB OS+Python+frontend envelope DESIGN.md reserves. Block streams use delta/append events, never full-envelope replacement, and history replay must cap in-memory turns.

## 6.3 Skills-first remains the primary richness lever

The planner + adapter layer is where this design earns its keep. The LLM's job is to write prose inside pre-allocated blocks — not to invent layout, decide eligibility, or fabricate sources. Violating this collapses us back to "LLM first" and breaks the speed/cost advantage on Pi.

---

# 7. Design Goal

LokiDoki should feel like this:

1. The app reacts immediately.
2. A useful answer starts quickly.
3. The answer visibly improves while the user is already reading.
4. Sources, media, and structured sections appear naturally.
5. The result feels deliberate and rich without sacrificing the speed advantage of the architecture.

In short:

> fast first impression, structured middle, polished final state

---

# 8. Core Design Principle

Rich responses are an application-layer capability.

The LLM should usually do only three things:

- phrase an answer cleanly
- compress or synthesize multiple skill results
- adapt tone, voice, and spoken summary

The application layer should do the rest:

- decide the response layout
- stream progress
- allocate sections
- attach sources
- attach media
- attach cards
- show loading states
- decide when enrichment is worth doing

The model must not be asked to "be the UI."

---

# 9. New Response Philosophy

Every turn should produce two outputs in parallel:

## 9.1 Fast answer track

This is the earliest safe answer the system can show.

Examples:

- direct fact answer
- one-sentence summary
- first calculation result
- best current match
- first grounded recommendation

## 9.2 Enrichment track

This upgrades the response after the first answer appears.

Examples:

- source chips
- source cards
- image/media cards
- key facts list
- comparison table
- related links
- follow-up suggestions

LokiDoki should stop treating "richness" as something that happens only after the answer is done. Richness is part of the answer lifecycle.

---

# 10. Response Modes

LokiDoki should explicitly choose one response mode per ask.

The response mode is a **planner output**, derived from existing decomposer signals (`response_shape`, `reasoning_complexity`, `capability_need`, `requires_current_data`) plus explicit user controls (a mode toggle, `/deep` slash, etc.). It is not a new regex over `user_input`. If the derivation is non-trivial, extend the decomposer's schema (respecting the 8,000-char prompt budget).

## 10.1 Direct

Use when speed matters more than presentation depth.

Typical asks:

- time
- calculator
- definitions
- simple fact lookup
- quick yes/no grounded answers

Render target:

- summary block
- optional single source
- no secondary enrichment unless it arrives almost free

## 10.2 Standard

Default mode for most turns.

Typical asks:

- general knowledge
- light current-info questions
- simple recommendations
- basic comparisons

Render target:

- summary block
- key facts block or bullets
- source row
- optional one media/card block

## 10.3 Rich

Use when the user clearly benefits from a structured answer.

Typical asks:

- "explain"
- "compare"
- "show me"
- "what should I know about"
- "walk me through"
- "latest on"

Render target:

- summary block
- structured content block
- source block
- media/cards block when relevant
- related follow-up block

## 10.4 Deep

Use only when the user **explicitly opts in** (mode toggle, `/deep` slash command, or a clear verbal trigger on voice). The decomposer may suggest deep, but must never auto-escalate a normal ask into deep mode — on a 4B local model, deep turns can run for minutes, and accidental escalation is a product failure.

Deep mode contract:

- hard wall-clock timeout (e.g. 90 s on Pi, 45 s on mac dev); on timeout the partial result is materialized as-is.
- checkpointed block writes — every evidence gather pass writes a block update so the user sees progress.
- single concurrent deep turn per session; subsequent asks queue or get a direct fallback.
- must run in a dedicated async task distinct from the standard turn path.

Typical asks:

- full breakdown
- pros/cons
- multi-source synthesis
- nuanced recommendation
- fact-heavy explanation

Render target:

- summary
- sectioned synthesis
- multi-source evidence
- comparison/action block
- optional artifact later, but not required for first answer

The response mode controls enrichment budgets, not whether the first answer is delayed.

Additionally, LokiDoki should distinguish between:

- answer mode
- search mode
- deep-work mode
- artifact mode

Onyx and Open WebUI both reinforce that one UI shape should not be forced onto every task. [R2][R5][R9][R10]

---

# 11. Rich Response Contract

LokiDoki needs a response contract centered on renderable blocks.

## 11.1 Design rule

The canonical response object should no longer be "text plus optional extras."

It should be:

- one response envelope
- many independently renderable blocks
- each block can be `loading`, `ready`, `partial`, `omitted`, or `failed`

## 11.2 ResponseEnvelope

Conceptual shape:

```json
{
  "request_id": "req_123",
  "mode": "standard",
  "status": "streaming",
  "hero": {
    "title": "Tesla Model Y",
    "subtitle": "Electric compact crossover SUV"
  },
  "blocks": [
    {
      "id": "summary",
      "type": "summary",
      "state": "partial",
      "content": "The Tesla Model Y is..."
    },
    {
      "id": "facts",
      "type": "key_facts",
      "state": "loading",
      "items": []
    },
    {
      "id": "sources",
      "type": "sources",
      "state": "ready",
      "items": [
        {"label": "Wikipedia", "url": "..."}
      ]
    },
    {
      "id": "media",
      "type": "media",
      "state": "loading",
      "items": []
    }
  ],
  "spoken_text": "Short spoken version here."
}
```

## 11.3 Block types

Initial block families should be:

- `summary`
- `key_facts`
- `steps`
- `comparison`
- `sources`
- `media`
- `cta_links`
- `clarification`
- `follow_ups`
- `status`

This is enough to make answers feel rich without inventing a giant schema.

Two additional optional top-level surfaces should exist outside the normal block stack:

- `artifact_surface`
- `source_surface`

This mirrors the key lesson from both comparison products:

- Onyx keeps a real right-side sources/citations surface in chat. [R11]
- Open WebUI keeps artifacts in a dedicated right-side window, separate from ordinary chat text. [R5]

## 11.4 Transport rules (Pi-friendly)

- Block updates are **delta / append / state-transition events**, never full-envelope replays. The client reconciles to canonical state, the wire does not re-ship the whole turn.
- Per-turn block count has a soft cap (e.g. 8 blocks) — sprawl indicates a planner bug, not a feature.
- Text blocks stream by token delta; media/source/follow-up blocks arrive as atomic adds.
- A `response.snapshot` event is emitted exactly once at turn end with the canonical state for storage + history replay, so later loads do not re-stream.
- History replay hydrates from the snapshot, not from the stream — replay cost is bounded even with long chats.

---

# 12. Event Model

The current SSE model should evolve, not be replaced. Evolution is **strictly additive** — existing `augmentation` / `decomposition` / `routing` / `synthesis` / `micro_fast_lane` phase events stay wire-compatible with current frontend consumers throughout the rollout.

Today LokiDoki already emits phase/status/data events. That should remain the transport base. The change is to add response-composition events alongside pipeline-phase events.

Open WebUI's tooling docs provide a concrete warning here: some event types remain robust across function-calling modes, while message-replacement and delta events can be overwritten in native/agentic flows. LokiDoki should design around that from the beginning. [R6]

## 12.1 Keep current events

Retain:

- session events
- augmentation/decomposition/routing/synthesis phase events
- silent confirmation events
- clarification events
- token/interim synthesis updates

## 12.2 Add response events

Add a second family of events for the chat renderer:

- `response_init` — turn shell + planned block list + chosen mode
- `block_init` — block declared, state `loading`
- `block_patch` — token delta or partial content append (idempotent on `(block_id, seq)`)
- `block_ready` — block marked `ready`
- `block_failed` — block marked `failed` with `reason` (offline, skill error, timeout)
- `source_add` — append structured source to `source_surface`
- `media_add` — append structured media card
- `response_snapshot` — canonical reconciled state, emitted exactly once at turn end
- `response_done` — terminal signal
- `artifact_open` — opens `artifact_surface` (separate from block stack)
- `artifact_patch` — delta into current artifact version
- `artifact_version_add` — immutable version bump

## 12.3 Why this matters

This separates two concerns cleanly:

- pipeline observability
- user-visible response assembly

The current pipeline popover can continue to explain what happened. The response events can control what the user sees growing in the chat body.

## 12.4 Event durability rules

To avoid brittle UX:

- citations/sources should arrive as structured append events
- block state should be idempotent and replay-safe
- artifact updates should version rather than mutate invisibly
- the final response should reconcile all prior events into one canonical stored state

This is the safest approach when streaming, tools, and model/provider behavior are not perfectly uniform. [R6]

---

# 13. Block Lifecycle

Every block should follow a small lifecycle:

1. declared
2. loading
3. partial or ready
4. optional refinement
5. final

Example:

1. `summary` block is created immediately.
2. first sentence streams into it.
3. `sources` block appears once the first citation is grounded.
4. `media` block appears only if the query deserves it.
5. `follow_ups` block is added at the end if confidence is high.

This gives LokiDoki a stable frame early, which makes the answer feel fast even when some content is still on the way.

---

# 14. Timing Budgets

These are product targets, not guarantees. Numbers are per-profile — mac dev is lenient; `pi_cpu` and `pi_hailo` are the ones the design must survive.

## 14.1 0-250 ms

Goal:

- create assistant shell
- show request accepted
- show first human-readable activity label

## 14.2 250-1200 ms

Goal:

- begin summary block
- or show deterministic result
- or show best current match

This is the most important budget in the whole system.

## 14.3 1.2-3.0 s

Goal:

- attach first sources
- finish summary
- attach one high-value enrichment block

## 14.4 3-6 s

Goal:

- add richer structure if the ask warrants it
- complete comparison/facts/media blocks
- finalize spoken summary and follow-ups

## 14.5 Beyond 6 s

By this point the user should already be reading.

Any further work must feel like enhancement, not dead time.

## 14.6 Profile-specific targets

The numbers above are "standard mode on Pi 5." Tighten/loosen per profile:

- `mac` — first-token <500 ms, summary ready <2 s, full turn <5 s.
- `pi_hailo` — first-token <900 ms, summary ready <3 s, full turn <8 s.
- `pi_cpu` — first-token <1.5 s, summary ready <5 s, full turn <12 s; direct mode must stay under 2 s end-to-end.
- Deep mode: wall-clock capped (see §10.4), not bound by the table above.

These are instrumentation goals for §23 metrics, not contracts. They exist so regressions are visible.

---

# 15. When To Enrich

Richness should be intentional, not automatic.

## 15.1 Always enrich lightly

Safe default enrichments:

- source chips
- key fact bullets
- concise follow-up suggestions

These are low-cost and improve quality almost everywhere.

## 15.2 Conditionally enrich

Use media/cards only when they help:

- YouTube when user asks for videos, tutorials, channels, trailers, or music
- image/media when the topic is visually anchored
- comparison tables for compare/buy/choose questions
- action steps for how-to and troubleshooting

## 15.3 Do not enrich gratuitously

Do not add media or extra sections when the user only wanted:

- a quick fact
- a short direct answer
- a voice-first response where extra visual scaffolding adds noise

The richness system should improve utility, not perform sophistication.

---

# 16. Planner Rules

The planner chooses both:

- which skills to run
- which blocks to allocate
- the response mode (§10) and the enrichment budget

## 16.0 Planner input contract

The planner consumes the existing `DecompositionResult` fields — nothing else is a legitimate source of branching:

- `intent` — core user intent
- `response_shape` — `verbatim` vs `synthesized`
- `reasoning_complexity` — `fast` vs `thinking`, drives direct/standard vs rich/deep
- `capability_need` — skills required (planner maps these to blocks)
- `requires_current_data` — triggers web/current skills and a visible "fresh data" trust signal
- `knowledge_source` — stable knowledge vs current vs user data

If a rule below needs a signal that isn't in this list, extend `DecompositionResult` and the decomposer prompt/schema — do not keyword-match `user_input`. Every extension must:

1. stay within the 8,000-char `DECOMPOSITION_PROMPT` ceiling (CI-enforced per CLAUDE.md);
2. keep required schema fields ≤ 12;
3. prefer derivation in Python (`_build_ask` / `_derive_*`) when possible.

## 16.1 Stable knowledge explainer

Example: "What is a jellyfish?"

Plan:

- run knowledge/Wikipedia path
- allocate `summary`
- allocate `sources`
- optionally allocate `media` only if cheap and clearly helpful
- do not escalate into a search-style layout

## 16.2 Current-info query

Example: "What is the latest on Nintendo Switch 2 pricing?"

Plan:

- run web/current-data skill first
- allocate `summary`
- allocate `sources`
- allocate `key_facts` if multiple grounded facts appear
- do not wait for broad enrichment before first answer
- if the user is effectively browsing results, pivot into a search-style response layout instead of over-synthesizing

## 16.3 Video-seeking query

Example: "Show me a YouTube video for replacing a Tesla cabin filter"

Plan:

- run YouTube first
- allocate `media`
- allocate short `summary`
- allocate `sources`
- spoken text should be short and directive, not a readout of every card

## 16.4 Comparison query

Example: "Wikipedia vs Wikimedia"

Plan:

- allocate `summary`
- allocate `comparison`
- allocate `sources`
- skip media unless explicitly requested

## 16.5 How-to or troubleshooting

Example: "How do I fix a dripping faucet?"

Plan:

- allocate `summary`
- allocate `steps`
- allocate `sources`
- optionally allocate one tutorial/video block

## 16.6 Artifact-worthy output

Example: "Make me a simple interactive budget dashboard" or "Create a one-page HTML trip planner"

Plan:

- do not treat this as a normal rich answer
- switch into `artifact` mode explicitly
- render the artifact in a separate surface
- keep normal chat text short and supervisory
- version subsequent edits rather than replacing content silently

This follows Open WebUI's clearer artifact boundary, where only renderable outputs become artifacts and versions are preserved in the artifact surface. [R5][R8]

## 16.7 Attached-document query

Example: "Summarize this PDF" or "What does this document say about warranty coverage?"

Plan:

- if the document fits comfortably, prefer full-context injection
- if the document is too large, switch to retrieval mode
- always expose the provenance of retrieved sections
- keep the mode switch invisible unless the user needs to understand why results differ

This follows LM Studio's explicit split between full-document-in-context and RAG depending on file size. [R13]

---

# 17. Search-Style And Deep-Work Modes

One of the clearest product lessons from Onyx is that not every request should stay in the same chat-shaped UI.

## 17.1 Search-style mode

When the user intent is "help me find the right thing" more than "tell me the answer," LokiDoki should use a search-style answer layout.

Examples:

- "find the best article on..."
- "show me sources about..."
- "what docs say..."
- "search my archives for..."

Render target:

- result list first
- filters or source grouping when relevant
- optional short synthesized takeaway above the results

This mirrors the product logic Onyx documents in its Search UI: sometimes the right answer is a better retrieval surface, not a prettier paragraph. Onyx specifically describes auto-routing document-search intent into a dedicated search experience with top and side filters. [R2]

## 17.2 Deep-work mode

When the user explicitly asks for deeper multi-step work, LokiDoki should switch into a dedicated deep-work path rather than quietly bloating a normal turn.

Examples:

- deep comparison
- research brief
- report
- multi-source recommendation

Render target:

- progress-oriented shell
- staged evidence gathering
- sectioned final output
- optional artifact/report later

This mirrors the product separation Onyx uses for Deep Research and Craft, and the Open WebUI split between normal chats and persistent work surfaces like Notes. Standard chat should stay fast. Heavy work should be explicit. [R3][R4][R10]

## 17.3 Source-surface mode

When the answer is grounded in multiple retrieved or external sources, LokiDoki should show a persistent source surface rather than hiding provenance inside the prose.

This should support:

- compact inline source chips in the answer
- a richer side panel or drawer for inspection
- per-source metadata when available
- optional "use this source next" actions for follow-up turns

This is directly inspired by:

- Onyx's right sidebar containing sources/citations that can be selected into the next turn. [R11]
- Open WebUI's citation modal, which can expose source name, page number, parameters, relevance, and content. [R8]

## 17.4 Artifact mode

Artifact mode should be reserved for independently useful renderable outputs.

Qualifying outputs:

- self-contained HTML views (no remote resources, see security rules below)
- SVG visuals
- interactive JS visualizations whose dependencies are already bundled in the app shell
- future first-party report surfaces

Non-qualifying outputs:

- ordinary markdown
- plain text notes in the normal chat stream
- raw code snippets
- generic long answers

This follows Open WebUI's explicit artifact boundary and prevents "everything becomes a canvas" sprawl. [R5]

### 17.4.1 Artifact security & offline rules (non-negotiable)

LokiDoki artifacts are LLM-authored HTML/SVG/JS. Running untrusted code inside the main app origin is unacceptable. Every artifact surface MUST:

- render in a **sandboxed `<iframe sandbox>`** (no `allow-same-origin`, no `allow-top-navigation`, no `allow-popups`, no `allow-forms` unless explicitly required by the artifact type).
- apply a strict **Content-Security-Policy** on the iframe document: `default-src 'none'; script-src 'self' 'unsafe-inline'` only inside the sandbox (`'unsafe-inline'` is the price of LLM-generated code and must be *confined* to the sandbox origin); `img-src data: blob:`; `connect-src 'none'`; `font-src 'self'`; `frame-ancestors 'self'`.
- **never** reference a CDN, remote font, remote stylesheet, remote script, or remote image URL. If an artifact output contains a remote URL, the adapter rejects or rewrites it — no exceptions.
- ship any visualization library (D3, ThreeJS, Chart.js, Mermaid) via `frontend/package.json`, bundled by Vite into a local asset the iframe loads from disk. No runtime CDN fetch, ever.
- run JS only — no `eval` context from the host, no `postMessage` channel to the host beyond a narrow, typed RPC for save/export.
- be size-capped (e.g. 256 KB of artifact content) so a runaway generation cannot OOM a Pi.
- persist as versioned immutable snapshots; edits create a new version rather than mutating the prior one.

If an artifact would need the network to function (live API calls, remote datasets), the correct answer is to generate a skill that fetches at bootstrap time and embed the data locally. Never a runtime network dependency.

## 17.5 Workspace-context mode

LokiDoki is single-user and local. "Workspace" here does NOT mean a multi-tenant folder tree like AnythingLLM or Open WebUI — it means a **persona + memory + attached-knowledge lens** over the existing single-user data.

A workspace context envelope should capture:

- active persona (from `loki-doki-personas`) — drives tone + system prompt
- attached files / knowledge scope (which bootstrap-materialized corpora are in play)
- response tone/layout preferences (mode defaults, enrichment aggressiveness)
- chat history subset that counts as "in context" for memory retrieval

What it should NOT become:

- a multi-user permissions model
- a separate content-management system
- a cloud-synced workspace

Implementation leverages the existing memory tiers (see `MEMORY.md` — memory phases M0–M6 shipped). Workspace = a named slice of persona + memory scope, not a new subsystem.

Directional evidence from AnythingLLM and Open WebUI folders/projects. [R9][R15] — adopt the *user-legibility* of scoped context, not the org structure.

---

# 18. Synthesis Rules

The small model fills prose *inside* pre-allocated blocks. It does not design the response.

## 18.1 LLM job

The synthesis model should:

- write the `summary` block content
- write readable step/bullet/comparison text when the planner has already chosen those block types
- preserve citation markers the adapter passed in
- produce a short `spoken_text` in the same call (not a separate pass)

## 18.2 LLM non-job

The synthesis model should not:

- decide layout by itself
- choose block types
- fabricate cards, sources, or image sections
- decide whether media exists
- guess current facts when skills have not grounded them
- decide artifact eligibility without planner support
- emit raw JSON/HTML that bypasses the adapter

## 18.3 Compression discipline

Because LokiDoki targets small local models:

- the planner chooses a small number of blocks (≤ 8 soft cap)
- only grounded skill outputs reach synthesis
- visual richness comes from attached structured data, not longer prompts
- synthesis runs once per turn when possible; block-by-block prose is a last resort and must not become the default path

This keeps the rich response system compatible with Pi-class hardware.

## 18.4 Deterministic block assembly (the core bet)

The bet that makes this design work on a 4B-class local model:

- **block selection is deterministic** (planner, Python)
- **block data is deterministic** (skill adapters, Python)
- **block ordering is deterministic** (response mode + planner)
- **block prose is the only thing the LLM writes** — and even that is scoped to specific block types (`summary`, `steps`, narrative inside `comparison`)

Sources, media, key facts, follow-up suggestions, artifact candidates all come from skill adapters. The LLM is never asked to produce URLs, structured JSON layouts, or fabricated citations.

When synthesis must produce structured output (e.g. a key-fact bullet list), prefer constrained JSON decoding via the synthesis engine's native grammar support over free-form prompting. If constrained decoding is too slow on `pi_cpu`, fall back to adapter-generated bullets and let the LLM only write the summary paragraph.

## 18.5 Block rendering cache

Deterministic block assembly makes history replay cheap:

- each turn persists its canonical `response_snapshot` (§11.4 / §12.2).
- reopening a chat renders from the snapshot, no re-inference, no re-stream.
- the LLM is invoked exactly once per turn, never on history load.

This is a direct SQLite-backed extension of the existing chat-history store.

---

# 19. Shared Architecture Contract

**This section is the foundation — everything in §11–§17 depends on it.** If the adapter layer does not land before the block contract ships, every skill will re-implement block creation and this design will have failed.

The response redesign should not turn into dozens of one-off skill renderers.

If richness is implemented separately inside each skill, LokiDoki will get harder to maintain with every new capability. The shared design rule is:

> skills return data, planners choose presentation, shared components render it

## 19.1 Skill output contract

Every skill should return structured data in a normalized shape that is safe for:

- synthesis
- source attribution
- progressive rendering
- storage/replay
- TTS summarization

Each skill result should map into a common envelope with concepts like:

- `summary_candidates`
- `facts`
- `sources`
- `media`
- `actions`
- `artifact_candidates`
- `follow_up_candidates`

The exact fields can vary internally, but the planner should not have to understand a hundred incompatible shapes.

## 19.2 Skill adapter layer

LokiDoki should introduce an adapter layer between raw skill results and UI blocks.

Responsibilities of the adapter layer:

- normalize skill-specific payloads into shared response primitives
- extract sources into a common citation/source model
- classify whether media is visual enrichment or primary payload
- identify artifact-eligible outputs
- produce safe inputs for the synthesis model

Design rule:

- skills do not render UI
- skills do not choose components
- skills do not emit frontend-specific markup beyond already-supported structured payloads

The adapter layer is the only place where "skill output" becomes "response building material."

## 19.3 Response block registry

Frontend rendering should be driven by a block registry, not by giant conditionals spread across chat components.

Conceptually:

- block type -> renderer component
- block type -> loading state component
- block type -> collapse/mobile behavior
- block type -> optional TTS policy

Initial block registry entries should include:

- `summary`
- `key_facts`
- `steps`
- `comparison`
- `sources`
- `media`
- `clarification`
- `follow_ups`
- `artifact_preview`

This keeps the system extensible while preserving one rendering pattern.

## 19.4 Shared UI primitives

The frontend should provide reusable primitives for all rich-answer surfaces.

At minimum:

- `ResponseShell`
- `ResponseBlock`
- `ResponseBlockHeader`
- `ResponseSkeleton`
- `SourceSurface`
- `SourceChipRow`
- `ArtifactSurface`
- `ArtifactVersionNav`
- `FollowUpChips`
- `StatusLine`

These should be generic enough that adding a new skill usually means:

1. add or update an adapter
2. emit an existing block type
3. only create a new renderer if the block type is genuinely new

## 19.5 Shared source model

All citations and source panels should use one shared source model across the app.

The shared source model should support:

- title / label
- canonical URL
- source kind
- snippet/content excerpt
- page/section info
- relevance/confidence metadata
- optional author/publication/date info
- optional "selected for next turn" state

This avoids every subsystem inventing its own source representation.

## 19.6 Shared artifact model

Artifacts should also use one shared model.

The artifact model should support:

- artifact id
- artifact type
- display title
- renderable content
- version list
- created/updated timestamps
- fullscreen/copy support
- relationship to the originating chat turn

Artifact rendering must remain separate from ordinary response blocks even if the artifact is launched from a block.

## 19.7 Streaming ownership rules

To keep streaming sane, each layer must own a narrow concern:

- skills own data acquisition
- adapters own normalization
- planner owns block selection and response mode
- synthesis owns prose/phrasing for text blocks
- renderer owns block display and progressive hydration

No layer should reach across these boundaries casually.

Especially important:

- do not let a skill decide the final visual layout
- do not let the frontend infer business meaning from raw skill payload quirks
- do not let synthesis invent sources or media

## 19.8 Common loading and fallback behavior

Every block type should inherit shared behavior for:

- loading state
- empty state
- failure state
- retry affordance where appropriate
- collapse/expand behavior
- mobile layout rules

This keeps the app from feeling inconsistent as richer blocks are added.

## 19.9 Componentization rule of thumb

When a new capability is added:

- prefer a new adapter over a new renderer
- prefer a new block instance over a new block type
- prefer extending the shared source/artifact models over adding ad hoc fields
- only introduce a new component family if the interaction model is genuinely different

This is how LokiDoki avoids turning rich responses into a long tail of bespoke UI.

---

# 20. Voice and Visual Must Diverge Cleanly

The app already supports `spoken_text`. This should become a first-class design rule.

## 20.1 Visual answer

Can include:

- cards
- chips
- multi-part structure
- citations
- optional related items

## 20.2 Spoken answer

Should usually include:

- direct answer
- one short supporting sentence
- one short clarification or next action if necessary

Do not read:

- raw URLs
- long source lists
- card grids
- long tables

Rich responses should feel rich on screen without becoming exhausting in TTS.

## 20.3 One-call synthesis for both tracks

`spoken_text` and visual block prose come from the **same synthesis call** (one JSON output with both fields), not two model passes. Two passes double Pi latency for no product benefit. DESIGN.md's existing response-shape-aware prompting already produces multi-field structured output — extend that, don't add a second inference round.

## 20.4 Barge-in and TTS durability

- TTS must be interruptible. A block_failed or user barge-in mid-speech should cut TTS cleanly, not finish the sentence from a now-stale block.
- `spoken_text` is produced atomically before TTS begins; block patches arriving after TTS starts do not retroactively edit what's being spoken. They update the on-screen block only.

---

# 21. UI Design Implications

The frontend should move from "message bubble with attachments" toward "message shell with staged regions." Every new component uses shadcn/ui primitives on Onyx Material — no raw HTML elements, no bespoke design system, no `window.confirm`/`alert`/`prompt` (use `ConfirmDialog` / `Dialog`).

## 21.1 Message shell

Each assistant turn should have stable regions:

- header/activity
- summary region
- structured block stack
- sources/footer region

Additionally, the UI should support three distinct answer frames:

- chat frame for normal answers
- search frame for retrieval-heavy turns
- deep-work frame for explicit longer-running research/report turns
- artifact frame for renderable standalone outputs

## 21.2 Stable layout

Reserve enough space for likely blocks to reduce layout jumpiness.

## 21.3 Progressive hydration

Text, sources, and media should hydrate independently.

## 21.4 Mobile behavior

On small screens:

- summary always first
- sources compact by default
- media collapsible or lower in the stack
- follow-ups short and tappable

## 21.5 Kiosk / Pi display behavior

LokiDoki's primary display surface is often the Pi itself (touch kiosk, small wall display, or car/RV console), not a phone. The layout must also work at:

- 7" Pi touch display (1024×600, landscape)
- small desktop browser (1280×800+)

Rules:

- summary and source surface visible at 1024×600 without scrolling
- artifact surface collapses into a modal rather than a side pane on narrow layouts
- touch targets meet Onyx Material spec

## 21.6 Current component impact

The existing chat components ([`MessageItem.tsx`](../frontend/src/components/chat/MessageItem.tsx), [`SourcesPanel.tsx`](../frontend/src/components/chat/SourcesPanel.tsx), [`MediaBar.tsx`](../frontend/src/components/chat/MediaBar.tsx), [`ThinkingIndicator.tsx`](../frontend/src/components/chat/ThinkingIndicator.tsx), [`PipelineInfoPopover.tsx`](../frontend/src/components/chat/PipelineInfoPopover.tsx)) are reusable but should be organized around blocks rather than a single prose body with side attachments. Migration is block-type-by-block-type, not a big-bang rewrite — MessageItem first grows a block registry, then existing behavior moves into `summary`, `sources`, and `media` block renderers.

## 21.7 Specific competitive UI lessons

From Onyx:

- right-side source inspection is valuable during ordinary chat, not only in search mode [R2]
- source selection into the next turn is a useful bridge between retrieval and synthesis [R2]
- explicit deep research toggles prevent accidental cost and latency inflation [R3]

From Open WebUI:

- artifact surfaces should be visibly separate from the main message thread [R5]
- artifact versions should be navigable [R5][R8]
- citations can support richer metadata than just a URL and title [R6][R8]

From LM Studio:

- document handling should adapt to context size rather than using one rigid path [R13]
- find-in-chat and cross-chat search are meaningful product features, not just admin/debug tooling [R14]

From AnythingLLM:

- workspace isolation helps users reason about what context is active [R15]

From Perplexica:

- evidence-first search UX is a distinct product mode, not just a prettier answer template [R16]

---

# 22. Confidence And Trust Signals

Modern AI products feel richer partly because they show confidence signals.

LokiDoki should expose trust in lightweight ways:

- grounded source chips
- "checking sources" and "wrapping up" activity text
- clear distinction between current-data answers and model-only synthesis (hook into `requires_current_data` / `knowledge_source`)
- visible clarification blocks when ambiguity exists
- **offline-state indicator** — when the device has no network and a skill needed network data, show a clear "offline — using local knowledge" chip; the user should never wonder why an answer feels thinner

It should not expose noisy internal jargon.

Good:

- Checking sources
- Looking for a video
- Pulling a quick summary
- Comparing results

Bad:

- execute phase
- capability resolution
- prompt assembly

The pipeline popover can remain more technical. The inline response shell should stay human.

---

# 23. Failure And Degradation Rules

The rich-response design must degrade gracefully. Offline is the default assumption, not the exception.

## 23.1 If enrichment fails

Still show:

- summary
- best sources available

Never collapse the whole answer because images or media failed. The failing block emits `block_failed` with a short reason and remains visible (greyed) so the user understands the shape of the answer.

## 23.2 If synthesis is slow

Still show:

- early grounded partial text
- active block shells
- visible progress

## 23.3 If no good sources exist

Say so clearly and stay concise.

Do not simulate richness with filler sections.

## 23.4 If the query is trivial

Return a direct answer and finish quickly.

Not every response should become a rich canvas.

## 23.5 If the device is offline

- skills that require network (web search, YouTube, fresh news) emit `block_failed` with `reason: "offline"` and do not retry in a tight loop
- a global offline chip appears in the shell (§22)
- the summary block is written using local knowledge and memory, with a clear caveat if freshness matters
- artifacts that would require remote data are rejected by the planner with a clarification block, not attempted with broken references

## 23.6 If a deep turn times out

- existing blocks are preserved in their current state and flipped to `ready` or `partial`
- a final `summary` pass runs on what was gathered so the user gets a usable answer
- the timeout is surfaced as a trust signal, not a generic error

---

# 24. Metrics For Success

The redesign is successful if it improves both speed perception and response usefulness. Every metric below is measured **per profile** (`mac`, `pi_hailo`, `pi_cpu`) because Pi regressions are invisible in mac-only dashboards.

Primary product metrics (with Pi 5 targets):

- time to first visible assistant shell — p95 < 250 ms on `pi_cpu`
- time to first useful content — p95 < 1.5 s on `pi_cpu`, < 900 ms on `pi_hailo`
- time to first source shown — p95 < 3 s on `pi_cpu`
- percent of turns with visible progress inside 300 ms — target > 95% on all profiles
- percent of standard/rich turns that include at least one non-text grounded block — target > 60%
- percent of grounded turns with inspectable source metadata — target > 90%
- percent of artifact-mode turns where artifact updates/versioning work without breaking the chat stream — target > 99%
- percent of offline turns that surface the offline trust signal — target 100%
- deep-mode turns completing under wall-clock cap — target > 95%
- history replay time from `response_snapshot` — target < 100 ms per turn

Behavioral metrics:

- user retry rate
- user re-ask rate
- feedback score on assistant turns
- usage of in-chat and cross-chat search once available
- percent of document-chat turns that use full-context vs retrieval appropriately

Qualitative success criteria:

- answers feel alive before they are complete
- users understand where the answer came from
- rich turns feel intentionally composed, not just verbose
- the Pi version still feels fast

Instrumentation: the existing SSE phase events already carry timestamps; the new `response_*` events should include monotonic timings so the timeline popover + a hidden dev-mode metrics view can surface regressions without shipping telemetry off the device (no remote analytics — CLAUDE.md).

---

# 25. Rollout Plan

**This rollout is the raw material for a chunked plan, not the plan itself.** Per CLAUDE.md, the actual execution lives under `docs/rich-response/PLAN.md` with one chunk-doc per stage. Each chunk must fit a single fresh Claude Code session (<6 files touched, <1 commit, single `Verify` command).

Stage ordering is deliberate: foundations before surface, value before polish, security before release. Stage 2 is a **prerequisite** of Stage 3, not a parallel track — shipping the block contract without an adapter layer guarantees per-skill sprawl.

## Stage 1: Shared adapter + shared source model

**Ship this first.** Without it the rest of the plan cannot land cleanly.

- introduce the skill adapter layer (one adapter per existing skill)
- define the canonical shared source model
- retrofit existing skills (calculator, wiki, youtube, movies_fandango, web, maps) to emit via adapters
- keep existing SSE events unchanged — this is a pure Python refactor

Exit criteria: every current skill routes its output through an adapter; `sources` field is shape-identical across skills.

## Stage 2: Response contract + block registry

Define block-oriented response assembly while preserving current text/sources/media compatibility.

- `ResponseEnvelope` + `Block` dataclasses in `lokidoki/orchestrator/core/types.py`
- block registry in the frontend (`frontend/src/components/chat/blocks/`)
- initial block types: `summary`, `sources`, `media` (mirrors today's payload so existing UI keeps working)
- wire the envelope through `synthesis` as the canonical output; legacy `output_text` stays populated for compatibility

## Stage 3: Progressive rendering + new response events

- add the `response_init` / `block_init` / `block_patch` / `block_ready` / `response_snapshot` / `response_done` family
- frontend starts consuming new events; legacy event handlers remain as fallback
- render assistant shells and block placeholders before synthesis completes
- persist `response_snapshot` for history replay

Exit criteria: time-to-first-shell p95 < 250 ms on `pi_cpu`; history replay renders without re-inference.

## Stage 4: Source-first trust layer

Make citations and sources a permanent answer region with compact inline chips plus a richer source panel/sidebar. Direct takeaway from Onyx [R3][R11].

- `SourceSurface` component
- structured citation payload (use adapter source model from Stage 1)
- source metadata (title, URL, kind, snippet, relevance, date)
- offline trust chip (§22)

## Stage 5: Planner-driven richness + response modes

Add response mode selection and block planning per ask type.

- planner consumes existing `DecompositionResult` fields (§16.0)
- direct / standard / rich / deep selection (deep requires explicit user opt-in)
- search-style result layout selection
- stricter gating for media/cards
- if a new decomposer field is needed, extend `DecompositionResult` + schema within the 8,000-char prompt ceiling

## Stage 6: Expanded block types + enrichment rules

Add `key_facts`, `steps`, `comparison`, `follow_ups`, `clarification`, `status` block renderers. Apply §15 enrichment budgets per mode.

## Stage 7: Voice parity

Ensure every rich visual answer has a clean short `spoken_text` from the same synthesis call (§20.3). Barge-in rules (§20.4). Do this before adding heavier modes so voice never falls behind visual.

## Stage 8: Adaptive document handling

Add an explicit document strategy that chooses:

- full inline context for small attachments (fits the model's context window)
- retrieval mode for large attachments (uses existing memory / vector path)

Direct LM Studio lesson [R13], fits LokiDoki's local-hardware constraints.

## Stage 9: Deep-work separation

Introduce a dedicated deep-work path for explicit research/report requests. Enforce §10.4 contract: explicit opt-in, wall-clock cap, checkpointed block writes, single concurrent deep turn.

## Stage 10: Artifact surface (security-first)

Add a distinct artifact/report surface with narrow eligibility rules, versioning, and copy/fullscreen affordances.

**Must land with §17.4.1 enforced on day one** — sandboxed iframe, strict CSP, no remote resources, bundled visualization libs only. Shipping artifacts without these is a release-blocking security bug.

Follows Open WebUI's "separate surface, narrow trigger" pattern rather than turning all rich replies into artifacts [R5].

## Stage 11: Workspace context

Recast as persona + memory lens (§17.5), not multi-tenant folders. Reuses existing memory pipeline [R9][R15].

## Stage 12: Visual polish + kiosk layout

Refine rich-answer layouts, mobile collapse behavior, 7" Pi touch display layout, and trust/status language (§21.5).

## Stage 13: Cross-chat search

LM Studio-inspired find-in-chat and search-all-chats [R14]. Local SQLite FTS over chat history; zero network.

---

This sequence keeps the architecture stable and improves the product incrementally. No stage depends on a later one. Every stage is individually shippable and reversible.

---

# 26. Final Design Position

LokiDoki should not chase ChatGPT richness by making the model larger or the prompts longer.

It should beat the "small local model feels plain" problem by doing the opposite:

- deterministic retrieval first
- explicit response planning driven by existing decomposer signals, not new regex heuristics
- structured response blocks assembled by Python, filled with LLM prose only where prose is needed
- progressive hydration via additive SSE events
- grounded sources and media from skill adapters, never fabricated by the model
- durable source and artifact surfaces when warranted, sandboxed and offline-safe
- adaptive document handling that respects Pi context limits
- persona/memory-scoped context (not multi-tenant workspaces)
- short-model synthesis used only where it adds value
- every asset resolved locally at runtime; bootstrap is the one network moment

That preserves LokiDoki's real advantage:

> quick, current, accurate answers on lightweight local hardware — fully offline, fully private

while making the experience feel much more premium, expressive, and complete.

---

# 27. Open Questions

These should be resolved while authoring `docs/rich-response/PLAN.md`, not during execution:

1. **Constrained JSON decoding on `pi_cpu`** — does `llama.cpp` grammar-constrained output meet the §14.6 timing budget for standard mode, or must we fall back to adapter-generated structure with LLM writing only `summary`? Bench before committing.
2. **Decomposer field growth** — the planner input contract (§16.0) may need one new field (`response_mode` or similar). Can it be derived in Python from existing fields, or must it be added to `DECOMPOSITION_SCHEMA`? Measure prompt-budget impact first.
3. **Artifact dependency set** — which visualization libraries (if any) are bundled in the first artifact release? D3 and Mermaid alone add ~300 KB gzipped to the frontend bundle; ThreeJS is larger. Decide eligibility vs. bundle cost.
4. **History migration** — turns written before the envelope lands have no `response_snapshot`. Decide: leave them as legacy text-only, or run a one-time adapter pass at Stage 3 shipping.
5. **Mode toggle UX** — how does the user opt into `deep` or `search` mode? A slash command, a compose-bar toggle, a persona setting, or all three? Onyx uses a toolbar — LokiDoki's voice-first posture may need a spoken `/deep` trigger too.
6. **Per-profile enrichment budgets** — `pi_cpu` may need to skip `key_facts` for direct/standard turns while `pi_hailo` and `mac` include them. Decide the default per-profile policy.

---

# References

- [R1] Onyx repository README and feature overview: https://github.com/onyx-dot-app/onyx
- [R2] Onyx RAG and Search docs: https://docs.onyx.app/overview/core_features/internal_search
- [R3] Onyx changelog, including chat revamp and citation-related notes: https://docs.onyx.app/changelog
- [R4] Onyx Craft docs: https://docs.onyx.app/overview/core_features/craft
- [R11] Onyx Chat UI docs: https://docs.onyx.app/overview/core_features/chat
- [R5] Open WebUI Artifacts docs: https://docs.openwebui.com/features/chat-features/code-execution/artifacts/
- [R6] Open WebUI tool and event-emitter docs, including citation event schema and mode compatibility: https://docs.openwebui.com/features/extensibility/plugin/tools/development/
- [R7] Open WebUI Code Execution docs: https://docs.openwebui.com/features/chat-conversations/chat-features/code-execution/
- [R8] Open WebUI source snippets reviewed via raw GitHub paths:
  https://raw.githubusercontent.com/open-webui/open-webui/main/src/lib/components/chat/Messages/CitationsModal.svelte
  https://raw.githubusercontent.com/open-webui/open-webui/main/src/lib/components/chat/Artifacts.svelte
- [R9] Open WebUI Folders & Projects docs: https://docs.openwebui.com/features/chat-conversations/chat-features/conversation-organization/
- [R10] Open WebUI Notes docs: https://docs.openwebui.com/features/ai-knowledge/notes/
- [R12] LM Studio docs home: https://lmstudio.ai/docs
- [R13] LM Studio Chat with Documents docs: https://lmstudio.ai/docs/app/basics/rag
- [R14] LM Studio 0.3.27 blog post, Find in Chat / Search All Chats: https://lmstudio.ai/blog/lmstudio-v0.3.27
- [R15] AnythingLLM (Mintplex Labs) repository/product overview: https://github.com/Mintplex-Labs/anything-llm
- [R16] Perplexica (ItzCrazyKns) repository/product overview: https://github.com/ItzCrazyKns/Perplexica
