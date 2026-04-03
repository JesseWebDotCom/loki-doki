# Onyx Review for LokiDoki

## Executive Summary

Onyx is strong at turning retrieval, tools, and streaming UI state into one coherent product. Its biggest strengths are not "being more agentic" in the abstract, but having clear action contracts, richer packetized streaming, better source handling, and better separation between retrieval results and final presentation.

LokiDoki should not copy Onyx's enterprise-heavy architecture wholesale. We should borrow the parts that improve correctness and UX inside our local-first, profile-driven design:

- Better skill/action contracts
- Better source metadata and citation handling
- Better separation between voice output and screen rendering
- Better turn identity and freshness guarantees
- Better personalization inputs that align with Phase 8 memory work

The comparison also exposes likely root causes for the bugs already showing up locally:

- The skill stack was split between the newer `app/skills/*` runtime and an older Wikipedia path; that consolidation is now implemented in code
- The skill rendering rules were overly Markdown-oriented for TTS; this has been partially reduced, and the codebase now carries an explicit response-style contract, but the product UX still needs to move that control behind character and profile defaults
- We do not yet have a first-class concise-versus-detailed response policy
- Turn identity and voice summaries are now threaded through the chat/skill flow, but source payload consistency still needs more work

### Status Since This Review

The following recommendations from this memo have already been started in the codebase:

- Added `turn_id` and `voice_summary` through the chat and skill reply flow
- Shifted TTS playback to prefer `voice_summary` over rendered chat body content
- Reduced Markdown-heavy rendering guidance in the skill rendering layer
- Moved Wikipedia into the main built-in skill runtime and removed the legacy subsystem Wikipedia path
- Added explicit `brief`, `balanced`, and `detailed` response styles through chat, voice, rendering, and retry flows

## What Onyx Does Well

### Agent and Action Model

Onyx exposes a clear action model around built-in actions and custom actions. Its docs show four built-in actions out of the box: Internal Search, Web Search, Code Interpreter, and Image Generation, and it lets admins extend the system with MCP or OpenAPI-based custom actions. Actions are configured per agent rather than being mixed directly into one loose prompt path.

Why this matters for LokiDoki:

- The capability contract is clear
- Tool access is explicit
- The product can grow without every capability becoming special-case chat logic

### Connector-Based Retrieval and Access Control

Onyx's connector model is more mature than LokiDoki's current web-and-skill lookup flow. Connectors define what gets indexed, how sync works, and who can access the data. The docs also show ConnectorCredentialPairs as the active unit for sync, status, and access control.

Why this matters for LokiDoki:

- Retrieval is treated as a system, not an ad hoc feature
- Source boundaries are first-class
- Search filters and scoped retrieval feel native instead of bolted on

### Streaming Architecture

Onyx's streaming model is much richer than a plain text delta stream. The docs and code show packet types for:

- message start and delta
- reasoning start and delta
- tool starts and tool deltas
- citation packets
- section lifecycle packets

This is one of the cleanest product differences between the systems. Onyx can show the user what the assistant is doing without collapsing everything into one final reply blob.

Why this matters for LokiDoki:

- Better frontend state handling
- Better source attribution
- Better debugging when a tool or search step goes wrong
- Better separation between intermediate evidence and final answer text

### Personalization and Memory Inputs

Onyx has a limited memory system compared with LokiDoki's Phase 8 vision, but it does a better job of exposing lightweight personalization inputs today. Its docs and changelog show workspace-level context, user info, and request-scoped additional context. The current open-source memory code is intentionally small and bounded.

Why this matters for LokiDoki:

- Onyx already distinguishes persistent user context from request-scoped context
- It avoids overloading chat history with all state
- It proves there is immediate UX value in lightweight personalization even before a full companion-grade memory stack exists

### Search UX and Source-Aware Answers

Onyx treats search as a product surface. It supports internal search, web search, search filters, and source-aware output. The chat API also supports citations and packetized search/tool traces.

Why this matters for LokiDoki:

- Search results stay inspectable
- Users can see what the answer came from
- The system can stay grounded without forcing every answer into one voice-only prose path

## How LokiDoki Compares Today

### Skills and Routing

LokiDoki currently has a deterministic, manifest-driven skill router in `app/skills/router.py`. That is a good fit for our hardware targets and matches `docs/skills.md`, which explicitly rejects always-on LLM routing for latency and predictability reasons. This is one area where LokiDoki's direction is correct for the product.

The deterministic approach is still the right fit for LokiDoki. The remaining issue is not the router itself, but the consistency of result contracts and downstream rendering:

- `app/skills/router.py` handles manifest scoring and route decisions
- `app/skills/manager.py` executes skills and builds post-processed payloads
- `app/skills/response.py` builds a compact reply and generic render payload
- `app/skills/rendering.py` still shapes the final character-rendered reply
- the legacy Wikipedia subsystem path has been replaced by a built-in `wikipedia` skill under `app/skills/builtins/wikipedia`

That is a meaningful improvement, but the source and presentation contracts still need to be tightened.

### Rendering and Voice

LokiDoki still does not fully separate voice output from screen rendering, but it is closer than before. `app/skills/response.py` now carries a `voice_summary`, the frontend voice path uses that field, and the render path now accepts explicit `response_style` values. The remaining product issue is not the absence of a style contract. It is deciding who should own that decision by default.

That means the worst TTS leakage is reduced, but not all verbosity and formatting decisions are yet intentionally tied to character or profile behavior.

### Classifier Split

`app/classifier.py` still makes broad top-level route decisions using keywords for web queries, tool calls, and text chat. That works as an early-stage classifier, but it creates tension with the deterministic skill runtime. Some queries are treated as top-level web requests while others enter the skill system, which increases the number of answer paths and the chance of inconsistent behavior.

### Chat Persistence and Retry Behavior

`app/chats/store.py` persists full chat history and payload JSON, and `app/api/chat.py` appends user and assistant messages per turn. This is a good foundation, but the current flow does not carry a strong request identity through classification, skill execution, render rewrite, persistence, and retry.

That means the system can preserve content, but it has fewer guards against stale or mismatched structured results being reused or rendered in the wrong conversational context.

### Memory Direction

LokiDoki's memory direction is more ambitious than Onyx's. `docs/PHASE_CURRENT.md`, `docs/memory_architecture_spec.md`, and `docs/LokiDoki_Memory_System_Master_Plan.md` define session, person, family, and character-scoped memory, plus future reflection and master/child sync concepts.

This is strategically stronger than Onyx for a household companion product. The gap is not vision. The gap is that Onyx already exposes lightweight personalization inputs and request-scoped context in a cleaner productized way today.

## Gaps and Bugs Exposed by the Comparison

### 1. Recently Fixed: Mixed Skill Architectures

This was a real issue when this memo was first drafted. LokiDoki had:

- the newer `app/skills/*` runtime
- the older Wikipedia path in `app/subsystems/text/skill.py`

That consolidation has now been implemented by moving Wikipedia into the built-in skill runtime. The underlying recommendation still stands for future knowledge-style capabilities: do not reintroduce parallel skill architectures.

### 2. Voice and Screen Formatting Are Not Cleanly Separated

This is the clearest explanation for the wiki/header TTS issue.

Current code paths ask the renderer to produce:

- headings
- bullet lists
- inline citations
- follow-up questions

Those are useful for the screen, but not for speech. LokiDoki needs separate presentation fields instead of asking one generated answer to serve both screen and TTS equally well.

### 3. No Explicit Concise-vs-Verbose Policy

Right now LokiDoki has the beginnings of a real response-style contract, but the product still needs a clear policy for how that style is chosen automatically. Voice, chat, and knowledge answers should intentionally differ, and that choice should come from the interaction type and character/profile settings, not from a user-facing toggle.

This directly maps to the concern that chat does not understand when to be concise versus verbose.

### 4. Partially Fixed: Freshness and Turn Identity

The current chat and skill flow preserves history, but not a strong turn identity. A request can be:

- classified
- routed to a skill
- rewritten through character rendering
- stored in history
- later retried or followed up

without an explicit `turn_id` or `request_id` tying all artifacts together. That increases the chance of old skill output or mismatched structured state surfacing in the wrong turn.

LokiDoki now carries `turn_id` through the chat and skill reply flow, which directly reduces this risk. The remaining work is to use that identity more broadly in retries, citations, and future packetized streaming.

### 5. Weak Source and Citation Structure

LokiDoki has some source-oriented presentation ideas, but nothing close to Onyx's explicit citation and packet model. Source metadata is not consistently normalized across web, Wikipedia, and skill answers.

As a result:

- source-aware UI is harder to build
- citation rendering is fragile
- voice cannot easily suppress citation formatting while the screen keeps it

### 6. Limited User and Workspace Personalization Inputs

LokiDoki has the stronger long-term memory plan, but it still lacks a lightweight, always-available personalization layer like:

- household profile context
- user profile context
- request-scoped context that should not persist into history

Onyx already productizes those inputs more clearly.

## Recommended Changes for LokiDoki

### Priority 1: Phase 8 Safe Now

#### 1. Consolidate onto One Skill Runtime Path

Phase fit: `Phase 8 safe now`

Status: `Implemented`

Why it matters:
The current split between `app/skills/*` and `app/subsystems/text/skill.py` is likely causing inconsistent behavior and complicating debugging.

What Onyx does:
Onyx presents one action model to the rest of the system, even though the implementations underneath differ.

What LokiDoki does now:
We have a modern skill runtime plus an older Wikipedia-specific path with its own rendering assumptions.

Recommended LokiDoki change:
Move wiki/web-style knowledge lookups behind the same `app/skills/*` contracts and deprecate legacy presentation logic in `app/subsystems/text/skill.py`.

#### 2. Split Presentation Contracts into Voice, Screen, and Sources

Phase fit: `Phase 8 safe now`

Status: `Started`

Why it matters:
One payload should not have to serve TTS, chat UI, and source display equally well.

What Onyx does:
Onyx separates streamed answer text, citations, search/tool traces, and intermediate packets.

What LokiDoki does now:
We mix compact replies with Markdown-forward render instructions and ask the LLM to make one answer serve every channel.

Recommended LokiDoki change:
Adopt a future presentation contract shaped like:

```json
{
  "voice_summary": "short spoken answer",
  "screen_content": {},
  "source_metadata": [],
  "response_style": "brief",
  "turn_id": "uuid"
}
```

This should be proposed now and implemented through the existing skill/result path later.

#### 3. Add an Explicit Response-Style Policy

Phase fit: `Phase 8 safe now`

Status: `Implemented in backend and UI plumbing; product-default policy still needed`

Why it matters:
Concise voice, balanced chat, and detailed research answers are different products.

What Onyx does:
Onyx exposes richer answer structure and request-scoped context, which gives it more room to shape output intentionally.

What LokiDoki does now:
LokiDoki now supports explicit `brief`, `balanced`, and `detailed` values through chat, voice, retry, and render flows. The normal chat composer no longer exposes a user-facing selector, and typed chat can now default from care-profile policy. The remaining opportunity is to push more of that decision into character and profile design rather than leaving it as a mostly backend concern.

Recommended LokiDoki change:
Introduce explicit response styles:

- `brief`
- `balanced`
- `detailed`

The renderer should honor the style instead of always defaulting to formatted, multi-section responses.

Product direction note:

- Voice interactions should default to `brief`
- Typed chat should default from character and care/profile configuration
- Users should not be shown a response-style selector in the normal product UX

This is closer to how strong voice-first systems behave in practice. Most do not ask the user to choose a voice style on every turn. They infer it from the modality and the assistant persona.

#### 4. Add Turn and Request IDs Across the Skill Path

Phase fit: `Phase 8 safe now`

Status: `Implemented in core chat/skill flow`

Why it matters:
We need a stronger freshness guarantee to avoid stale skill carryover.

What Onyx does:
Onyx's streaming, tool, and citation model is packetized and identity-aware.

What LokiDoki does now:
We persist messages and metadata, but not a durable end-to-end turn identity for skill execution and render rewrites.

Recommended LokiDoki change:
Carry a `turn_id` or `request_id` through:

- classification
- skill execution
- render payload generation
- assistant message persistence
- retry flows

That creates a concrete guardrail for debugging and stale-result prevention.

#### 5. Normalize Source Payloads

Phase fit: `Phase 8 safe now`

Status: `Partially started`

Why it matters:
Web results, wiki data, and skill answers should expose source information in one predictable shape.

What Onyx does:
Onyx has explicit search documents, citations, and packetized tool outputs.

What LokiDoki does now:
Source information is uneven. For example, `app/skills/builtins/web_search/skill.py` returns titles and snippets but empty URLs, while wiki rendering asks for citations in a separate path.

Recommended LokiDoki change:
Normalize source payloads to always prefer a common structure such as:

- `title`
- `url`
- `snippet`
- `source`

That creates a better foundation for both screen citations and voice-safe summarization.

### Priority 2: Later, but Aligned

#### 6. Add Action-Level Filters and Source Scoping

Phase fit: `Later, but aligned`

Why it matters:
Users should be able to constrain where answers come from when the source matters.

What Onyx does:
Onyx supports source filters for internal search and has stronger action-level configuration.

What LokiDoki does now:
Routing chooses a skill, but users do not get comparable control over source scope.

Recommended LokiDoki change:
Add optional action-level source filters and retrieval scopes once the Phase 8 memory interfaces settle.

#### 7. Add Richer Citation and Tool Streaming

Phase fit: `Later, but aligned`

Why it matters:
The UI should be able to show what LokiDoki is doing, not just the final answer.

What Onyx does:
Onyx streams reasoning, tool activity, citations, and final answer packets independently.

What LokiDoki does now:
The streaming API is still mostly answer-text oriented.

Recommended LokiDoki change:
Evolve the frontend stream toward packet types for:

- tool start
- tool delta
- citation info
- final answer

Do this after the core skill contract is simplified.

#### 8. Add Lightweight User and Household Profile Context

Phase fit: `Later, but aligned`

Why it matters:
Not every personalization need should wait on full episodic memory or character evolution.

What Onyx does:
Onyx already uses workspace info, user info, and request-scoped extra context.

What LokiDoki does now:
We have a strong long-term memory design, but a weaker lightweight personalization layer.

Recommended LokiDoki change:
Add simple profile-context inputs for:

- user role/preferences
- household summary
- request-scoped context that should not be stored in chat history

This should align with Phase 8 memory scopes instead of bypassing them.

#### 9. Add Plugin-Facing Action Contracts

Phase fit: `Later, but aligned`

Why it matters:
Plugins will need a stable contract that feels tool-like without collapsing LokiDoki's repo boundaries.

What Onyx does:
Onyx lets actions extend agents via MCP and OpenAPI.

What LokiDoki does now:
The plugin system is intentionally deferred, but the future contract should be clearer than "just another chat path."

Recommended LokiDoki change:
Design plugin-facing action contracts that feel closer to Onyx Actions while preserving:

- `loki-doki` for core
- `loki-doki-plugins` for optional capabilities
- `loki-doki-personas` for content only

### Priority 3: Do Not Adopt

#### 10. Do Not Replace Deterministic Local Routing with Fully Agentic Default Routing

Phase fit: `Do not adopt`

Why it matters:
Onyx is optimized for a different product category and hardware profile.

What Onyx does:
Onyx leans into agent/action orchestration, richer search, and more enterprise-style tool use.

What LokiDoki does now:
LokiDoki intentionally uses deterministic routing because Pi latency and voice responsiveness matter.

Recommended LokiDoki change:
Keep deterministic skill routing as the default. Improve contracts and result handling instead of replacing the router with an always-on agentic system.

#### 11. Do Not Import Cloud-First, Enterprise-Heavy Complexity

Phase fit: `Do not adopt`

Why it matters:
Local-first household UX is the core product constraint.

What Onyx does:
Onyx supports many connectors, hosted deployments, enterprise controls, and broad action surfaces.

What LokiDoki does now:
LokiDoki is profile-driven, local-first, and constrained by Pi-class hardware.

Recommended LokiDoki change:
Borrow structure, not weight. Prefer the lightest abstraction that solves the local problem.

#### 12. Do Not Collapse Core, Plugins, and Personas into One Packaging Model

Phase fit: `Do not adopt`

Why it matters:
LokiDoki's three-repo split is a deliberate product and architecture rule.

What Onyx does:
Onyx groups actions, agents, connectors, and personalization under one broader platform layer.

What LokiDoki does now:
The repo split is central to keeping core behavior, optional integrations, and persona content separate.

Recommended LokiDoki change:
Keep the existing boundary. Use Onyx as inspiration for contracts, not repository shape.

## What Not to Copy from Onyx

- Do not copy Onyx's enterprise-first product surface as-is. LokiDoki is not a workplace knowledge assistant.
- Do not let retrieval, actions, personas, plugins, and memory blur into one giant orchestration layer.
- Do not replace profile-driven local behavior with cloud-style abstraction layers that hide hardware realities.
- Do not assume richer streaming means richer prompts. The win is better state separation, not more prompt complexity.
- Do not downgrade LokiDoki's memory ambition to Onyx's simpler user-memory model. Onyx is better at lightweight personalization today, but LokiDoki's long-term memory design is stronger for a companion product.

## Source Links

### LokiDoki Sources

- `docs/spec.md`
- `docs/PHASE_CURRENT.md`
- `docs/skills.md`
- `docs/memory_architecture_spec.md`
- `docs/LokiDoki_Memory_System_Master_Plan.md`
- `app/skills/router.py`
- `app/skills/manager.py`
- `app/skills/response.py`
- `app/skills/rendering.py`
- `app/skills/builtins/wikipedia/skill.py`
- `app/classifier.py`
- `app/chats/store.py`
- `app/api/chat.py`
- `app/skills/builtins/web_search/skill.py`

### Onyx Sources

- Onyx README: <https://raw.githubusercontent.com/onyx-dot-app/onyx/main/README.md>
- Onyx actions overview: <https://docs.onyx.app/admins/actions/overview>
- Onyx core concepts and streaming/connectors: <https://docs.onyx.app/developers/core_concepts>
- Onyx chat API and streaming response model: <https://docs.onyx.app/developers/guides/chat_new_guide>
- Onyx workspace settings: <https://docs.onyx.app/admins/advanced_configs/workspace_settings>
- Onyx changelog entries for personalization, source filters, and MCP: <https://docs.onyx.app/changelog>
- Onyx tool runner: <https://raw.githubusercontent.com/onyx-dot-app/onyx/main/backend/onyx/tools/tool_runner.py>
- Onyx streaming models: <https://raw.githubusercontent.com/onyx-dot-app/onyx/main/backend/onyx/server/query_and_chat/streaming_models.py>
- Onyx memory model: <https://raw.githubusercontent.com/onyx-dot-app/onyx/main/backend/onyx/db/memory.py>
