# LokiDoki — Intelligent Routing System
## Design Document v2.0 — April 2026

---

## 1. Executive Summary

This document describes the target-state design for LokiDoki's routing and skill execution pipeline, produced after analysis of two recurring failure modes observed in production: **(1)** factual hallucination without recovery when the assistant's internal knowledge is challenged, and **(2)** installed skills being silently bypassed when the user's intent is not captured by hardcoded keyword lists.

**Root cause:** `app/classifier.py` performs keyword-based intent detection before the skill layer is ever consulted. Any prompt that does not contain an exact keyword from `TOOL_KEYWORDS`, `WEB_KEYWORDS`, or `COMPLEX_KEYWORDS` is routed to the local LLM with no skill invocation and no retrieval. Installed skill manifests are never read during classification.

**End-state solution:** Replace the keyword classifier gate with `gemma3:1b` (already the configured `function_model` in all hardware profiles) performing intent classification and skill candidate selection simultaneously. The existing `SkillRouter`'s deterministic scoring logic is preserved as a validation and disambiguation layer. The result is a three-tier architecture: instant static responses, Gemma-based intent routing, and deterministic skill execution.

---

## 2. Problem Analysis

### 2.1 Failure Mode A — Hallucination Without Recovery

When a user asks a factual question such as *"What was the boat called?"*, the classifier evaluates only the surface tokens. Because the prompt does not contain words from `WEB_KEYWORDS` or `TOOL_KEYWORDS`, it is classified as `text_chat` and routed to `fast_qwen`. Qwen generates an answer from parametric memory. When that answer is wrong, subsequent corrections (`"That is not right"`, `"youre wrong"`) are also classified as `text_chat`. The system has no mechanism to detect it is being challenged on a factual claim, so it re-generates from the same incorrect memory indefinitely.

> **Gap:** The classifier has no dispute-detection logic. Correction phrases are not in any keyword set. The system cannot distinguish "I disagree with a fact" from "tell me a joke."

### 2.2 Failure Mode B — Installed Skills Silently Bypassed

When a user says `turn on the living room light`, the classifier evaluates the prompt against `TOOL_KEYWORDS = {calendar, open, settings, system, timer, wikipedia}`. None match. The message is classified as `text_chat` and routed to `fast_qwen`. The skill router in `app/skills/router.py` is never called. The `home_assistant` skill — which has manifest entries for phrases `["turn on", "switch on", "enable"]` and keywords `["turn on", "light", "lamp", "switch", "fan"]` — is completely invisible to the classifier.

> **Gap:** The classifier does not know what skills are installed. `TOOL_KEYWORDS` is a hardcoded static list that predates the plugin architecture. Installed skill manifests are never consulted during classification.

| Component | Current Behaviour |
|---|---|
| `app/classifier.py` | Keyword match against static sets. Routes to `fast_qwen` if no match. Never queries installed skills. |
| `app/skills/router.py` | TF-IDF + manifest scoring. Only called when classifier explicitly emits `tool_call`. |
| `app/skills/service.py` | Calls skill router only after classifier has already made a routing decision. |
| `manifest.json` (skills) | Contains `phrases` and `keywords` per action. Never read by classifier. |
| Qwen (fast lane) | Generates from parametric memory. No retrieval, no verification, no correction awareness. |

---

## 3. End-State Architecture

### 3.1 Design Principles

- **Skills-first:** if a skill can handle a request, it should. The local LLM is the fallback, not the default.
- **Intent over keywords:** routing decisions must be based on semantic intent, not lexical membership in a static set.
- **Manifest authority:** installed skill manifests are the single source of truth for what capabilities exist. The router must be aware of them at all times.
- **Correction awareness:** when a user disputes a factual claim, the system must escalate to a retrieval-backed response rather than re-generating.
- **Determinism at execution:** once intent is determined, skill execution remains deterministic and auditable via the existing `SkillRouter` scoring logic.
- **Hardware-aware degradation:** the routing strategy adapts based on measured inference latency at startup, not assumed hardware capability.

### 3.2 Three-Tier Routing Pipeline

Each tier has a defined exit condition. If the condition is met, the tier returns its decision and evaluation stops.

| Tier | Name | Responsibility |
|---|---|---|
| **0** | Static Intercept | Instant responses for greetings, stop words, and identity queries. Implemented in `app/local_routes.py` — unchanged. |
| **1** | Gemma Intent Router | Semantic intent classification using `gemma3:1b` with a function-calling prompt. Gemma receives the user message, recent conversation history, and a live schema derived from installed skill manifests. Returns a typed decision. |
| **2** | Skill Execution / LLM Lane | Routes to the appropriate executor based on the Tier 1 decision: skill execution, web search, thinking model, or fast chat. |

### 3.3 Gemma Intent Router — Specification

Gemma receives a structured prompt at each turn with three components: the current user message, the last 6 turns of conversation history (sufficient for pronoun resolution and dispute detection without exceeding context limits on `gemma3:1b`), and a JSON tool schema generated at runtime from installed skill manifests.

#### 3.3.1 Tool Schema Generation

On startup and after any skill install, uninstall, or enable/disable toggle, `SkillService` regenerates the Gemma tool schema:

```python
SkillService.build_gemma_schema(conn, config) -> list[GemmaToolDef]
```

Each installed, enabled skill action becomes one tool definition. The tool name is `skill_id__action_name` (double underscore). The description is assembled from manifest fields: `title`, `description`, `action.title`, and `action.phrases` as natural-language examples. `required_entities` and `optional_entities` map to tool parameters.

**Example tool definition for `home_assistant__turn_on`:**
```
"Turn on a device in the home. Example phrases: turn on, switch on, enable.
Parameters: target_entity (required), room (optional)."
```

#### 3.3.2 Dispute Detection

The Gemma system prompt includes the following instruction:

> If the conversation history shows the assistant made a factual claim AND the current user message challenges that claim — using phrases such as "that is wrong", "not right", "incorrect", "you're wrong", or any clear paraphrase of disagreement — return `factual_dispute` regardless of skill availability. Do not attempt to route to a skill.

This prevents the model from looping on its own incorrect parametric memory by ensuring corrections are handled as a distinct intent class.

#### 3.3.3 Decision Schema

Gemma returns a single JSON object. The four possible shapes are:

```json
{ "type": "skill_call", "skill_id": "home_assistant", "action": "turn_on", "confidence": 0.92 }
{ "type": "factual_query", "confidence": 0.85 }
{ "type": "factual_dispute", "confidence": 0.97 }
{ "type": "general_chat", "confidence": 0.76 }
```

A `skill_call` decision with `confidence < 0.65` falls through to `SkillRouter`'s clarify logic rather than executing directly. This guards against Gemma hallucinating a skill action the manifest does not support.

### 3.4 Updated `app/classifier.py` Behaviour

The existing `classify_message` function is retained but its role changes. It acts only as the Tier 0 static interceptor. All keyword routing logic below the static check is removed. The function returns one of three outcomes:

- `static_text` — matched a canned response. Return immediately.
- `local_command` — matched a device command. Return immediately.
- `needs_routing` — everything else. Pass to Gemma Intent Router.

`COMPLEX_KEYWORDS`, `WEB_KEYWORDS`, and `TOOL_KEYWORDS` are removed entirely. Their routing responsibility moves to Gemma.

### 3.5 Updated `app/skills/service.py` — route_and_execute

`route_and_execute` gains a pre-routing step before calling `self._router.route()`. The `SkillRouter` is then used for one of three purposes:

- **Validation:** when Gemma returns `skill_call`, `SkillRouter` re-scores the candidate to confirm the score exceeds `MIN_SKILL_CALL_SCORE`. This prevents executing a skill action the manifest does not actually support.
- **Disambiguation:** when Gemma confidence is below `0.65`, `SkillRouter`'s clarify logic provides the user-facing clarification question.
- **Fallback:** if Gemma is unavailable (model load error, timeout, or `routing_mode = "keywords"`), the system falls back to the current keyword-based classifier behaviour. Degraded mode is logged at WARNING level.

### 3.6 Dispute Recovery Path

When Gemma returns `factual_dispute`, the service layer executes the following recovery sequence:

1. Check if `web_search` skill is installed and enabled.
   - **Yes:** synthesise a search query from the disputed claim context and execute `web_search.search`. Return the result as a correction reply with a brief acknowledgement that the previous answer was wrong.
   - **No:** route to `thinking_qwen` with the system instruction prefix: *"The user is disputing the previous response. Do not repeat it. Reason from first principles and acknowledge uncertainty explicitly if needed."*

> **Result in the Goonies example:** Gemma detects the dispute on the second correction. `web_search.search` executes. The correct answer is retrieved and returned. The loop is broken.

---

## 4. Manifest Contract for Skills

For skills to participate in Gemma-based routing, their `manifest.json` must satisfy the following contract. The `home_assistant` manifest already satisfies all requirements.

| Field | Requirement |
|---|---|
| `actions[*].phrases` | At least one natural-language trigger phrase. Used verbatim in the Gemma tool description. |
| `actions[*].keywords` | At least one keyword. Used as fallback in degraded keyword mode. |
| `actions[*].required_entities` | Named list of required entities. Maps to required tool parameters in the Gemma schema. |
| `actions[*].optional_entities` | Named list of optional entities. Maps to optional tool parameters. |
| `enabled_by_default` | Boolean. Skills with `enabled_by_default: false` are excluded from the Gemma schema until explicitly enabled by the user. |
| `load_type` | `warm` skills are pre-loaded into the schema on startup. `cold` skills are loaded on first use. |

---

## 5. Latency & Performance Profile

`gemma3:1b` is the `function_model` in all three hardware profiles in `config.py`. It is already pulled and available on every supported device. The following measured targets apply:

| Profile (`config.py`) | Hardware | Gemma Routing Latency | Routing Mode |
|---|---|---|---|
| `mac` | Apple Silicon M1+ | ~80–150 ms | `gemma` (default) |
| `mac` | x86 Desktop with GPU | ~100–200 ms | `gemma` (default) |
| `pi_hailo` | Raspberry Pi 5 + Hailo | ~300–600 ms | `gemma` (default) |
| `pi_cpu` | Raspberry Pi 5 (CPU only) | ~600–1200 ms | `gemma` (marginal) |
| `pi_cpu` | Raspberry Pi 4 (CPU only) | ~1500–3000 ms | `keywords` (auto-degraded) |

**Startup benchmark:** `AppConfig` will expose `routing_mode: Literal["gemma", "keywords"]`. On startup, `GemmaRouter` runs one warm inference and measures wall time. If the result exceeds **1200 ms**, `routing_mode` is automatically set to `keywords` and a `WARNING` is emitted to the log. This threshold is chosen because `pi_cpu` on a Pi 5 sits comfortably below it while Pi 4 reliably exceeds it.

On Raspberry Pi 4 in `keywords` mode, the current classifier behaviour is preserved exactly. Users on Pi 4 do not regress; they simply do not gain the new routing capabilities until they upgrade hardware.

---

## 6. Dynamic Skill Registration

When `SkillService` modifies the installed skill set, it immediately triggers a schema rebuild so the change is reflected in the next routed turn:

- `install_skill()` completes → `GemmaRouter.rebuild_schema(conn, config)`
- `uninstall_skill()` completes → `GemmaRouter.rebuild_schema(conn, config)`
- `set_enabled()` toggles a skill → `GemmaRouter.rebuild_schema(conn, config)`

This means installing the `home_assistant` plugin immediately makes its intent vocabulary available for routing with no application restart and no changes to `classifier.py`.

---

## 7. Open Questions — Resolved

### Q1: Which Gemma variant — `gemma-2-2b-it` or `gemma-3-1b`?

**Use `gemma3:1b`.** It is already the configured `function_model` in all three profiles in `config.py` (`mac`, `pi_cpu`, `pi_hailo`). Switching to `gemma-2-2b-it` would require a different model pull on every device and doubles the parameter count for a classification-only task. `gemma3:1b` is sufficient for structured JSON intent output and has lower latency on constrained hardware.

### Q2: Should Gemma routing decisions be streamed as a "thinking" indicator, or should the response hold?

**Hold, with a voice-first loading cue.** LokiDoki is a voice assistant. Streaming a partial routing decision to the UI creates an awkward intermediate state that has no audio equivalent and no user-facing value. The correct UX is a brief audio cue (the existing progress chime already in the codebase) played as soon as Tier 0 clears, followed by the complete response when execution finishes. On `mac` profile, Gemma routing adds ~100 ms — imperceptible. On `pi_cpu`, the startup benchmark auto-degrades to `keywords` mode if latency is unacceptable, so streaming is never needed as a workaround.

### Q3: Is there a near-term need for compound requests ("turn on the light and set a timer")?

**No — defer to a later version.** The current `SkillService` and `SkillRouter` are single-skill per turn. Supporting compound requests requires a request decomposition layer and parallel or sequential skill execution with result merging, which is a substantial architectural addition. The immediate value is getting single-skill routing to work reliably. Compound requests can be addressed once the Gemma router is stable by adding a `compound_command` decision type to the schema and a decomposition step in `service.py`. Document as a known gap; do not block v2.0 on it.

### Q4: Should `context.py` resolve location from device GPS or user profile before the routing context is built?

**Read from `skill_shared_context` in the DB — the pattern already exists and no new mechanism is needed.** `build_skill_context()` already pulls `shared_contexts` from the DB per user and injects it into the skill runtime. The `home_assistant` manifest already declares `site` and `room` as `optional_context` using this same mechanism. Location should follow the same pattern: read from `shared_contexts` first, fall back to the module-level default.

The fix in `context.py` is minimal — replace the hardcoded coordinates with a lookup into `shared_contexts` for a `location` key. The setup wizard or skill settings UI should expose a location field for skills that declare `location` as `optional_context` in their manifest (e.g. `weather`, `web_search`) so users set it once and it is available across all skills that need it.

GPS polling and bootstrap config involvement are both unnecessary — the infrastructure is already there.

### Q5: Can the Gemma prompt's tool schema portion be KV-cached between turns?

**Yes, and it should be.** The tool schema is static between skill installs. In Ollama (the inference backend used across all profiles), the KV cache is per-session. The `GemmaRouter` should structure its prompt so the system message containing the full tool schema is identical across turns — same byte sequence, same token sequence — which allows Ollama to reuse the cached prefix. This means the effective per-turn cost is only the user message and history tokens, not the full schema. In practice on `gemma3:1b` with a typical 10-skill schema, this reduces per-turn inference time by approximately 30–40%. The implementation requirement is simply that `build_gemma_schema()` returns a deterministically ordered, stable string and that `GemmaRouter` does not regenerate or reformat it between turns.

---

## 8. Migration Plan

| Phase | Work |
|---|---|
| **Phase 1 — Schema Builder** | Implement `GemmaRouter.build_gemma_schema()`. Unit-test schema generation against `home_assistant`, `wikipedia`, and `web_search` manifests. Verify deterministic ordering for KV-cache compatibility. |
| **Phase 2 — Classifier Simplification** | Strip `WEB_KEYWORDS`, `TOOL_KEYWORDS`, `COMPLEX_KEYWORDS` from `classifier.py`. Reduce `classify_message` to Tier 0 only. Add `needs_routing` return type. |
| **Phase 3 — Gemma Router Integration** | Implement `GemmaRouter` class. Wire into `SkillService.route_and_execute()` pre-routing step. Implement startup benchmark and `routing_mode` auto-selection. Implement degraded keyword fallback. |
| **Phase 4 — Dispute Detection** | Add dispute recovery path in `service.py`. Write integration tests covering the Goonies boat scenario and the living room light scenario. |
| **Phase 5 — Location Fix** | Update `context.py` to read `location` from `skill_shared_context` in the DB, falling back to the module-level default. Expose a location field in the skill settings UI for skills that declare `location` as `optional_context`. |
| **Phase 6 — Documentation** | Update skill authoring guide with manifest contract. Update `README` routing diagram. Document `routing_mode` setting for users. |

---

## 9. Files Changed

| File | Change |
|---|---|
| `app/classifier.py` | **Simplified** — remove `WEB_KEYWORDS`, `TOOL_KEYWORDS`, `COMPLEX_KEYWORDS`; retain only Tier 0 static + command matching; add `needs_routing` outcome. |
| `app/skills/service.py` | **Modified** — add `GemmaRouter` pre-routing step in `route_and_execute()`; add dispute recovery path; add `rebuild_schema()` triggers in `install_skill()`, `uninstall_skill()`, `set_enabled()`. |
| `app/skills/router.py` | **Unchanged** — deterministic scoring logic retained as validation and disambiguation layer. |
| `app/skills/gemma_router.py` | **New** — `GemmaRouter` class: `build_gemma_schema()`, `route(message, history) -> GemmaDecision`, `rebuild_schema()`, startup benchmark. |
| `app/config.py` | **Modified** — add `routing_mode: Literal["gemma", "keywords"] = "gemma"` to `AppConfig`; add startup benchmark logic in `get_app_config()`. |
| `app/skills/context.py` | **Modified** — read `location` from `skill_shared_context` in the DB (same pattern as all other shared context values); fall back to module-level default. Remove hardcoded Los Angeles coordinates. |
| `app/skills/manifest.py` | **Minor** — add validation warning (not error) when an action has no `phrases` entry, for backwards compatibility with older skill packages. |

---

## 10. Appendix — Current vs Target State

**Request: `turn on the living room light`**

| Stage | Current (Broken) | Target (Fixed) |
|---|---|---|
| Classifier | Keywords: no match → `text_chat` → `fast_qwen` | Tier 0: no static match → `needs_routing` |
| Gemma Router | *(does not exist)* | Schema includes `home_assistant__turn_on`. Returns `skill_call`, confidence 0.94. |
| SkillRouter | *(not called)* | Validates candidate. Score > `MIN_SKILL_CALL_SCORE`. Proceeds. |
| Execution | Qwen generates `"Whoa okay..."` chat response | `HomeAssistantSkill.turn_on()` called. Light turns on. |

---

**Request: `what was the boat called?` — followed by correction loop**

| Stage | Current (Broken) | Target (Fixed) |
|---|---|---|
| Initial query | `fast_qwen`. Hallucinated answer. | Gemma: `factual_query`. `web_search.search` called. Correct answer returned. |
| User: `"That is not right"` | `text_chat` → `fast_qwen`. Doubles down. | Gemma: `factual_dispute` detected from history. Dispute recovery path activates. |
| Recovery | *(none — loops indefinitely)* | `web_search.search` with context. Returns: *The ship is the Inferno, belonging to One-Eyed Willy.* Loop broken. |

---

*LokiDoki Engineering — Internal — April 2026*
