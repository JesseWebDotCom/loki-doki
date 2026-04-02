# LokiDoki Skill System Design

## 1. Purpose

This document defines the architecture for LokiDoki's extensible **Skill System**.

Goals:

- Run **many skills with minimal CPU/RAM overhead** on Raspberry Pi 5.
- Keep the runtime **fast, deterministic, and local-first**.
- Make skills **easy to develop, validate, install, remove, enable, and configure**.
- Allow a separate **Skill Repository** that LokiDoki can browse, download, install, and update from inside the app.
- Support both:
  - simple local/device skills
  - remote account-backed skills such as Home Assistant and Google Calendar
- Keep skill execution separate from:
  - routing
  - response generation
  - persona/style
  - permissions
  - account/context management

This design intentionally favors a **small custom in-process runtime** over heavier agent/plugin frameworks.

---

## 2. Core terminology

### Skill
A focused capability LokiDoki can perform.

Examples:
- `home_assistant`
- `weather`
- `movie_showtimes`

A skill is not a giant domain bucket. It should stay focused enough to be understandable, configurable, and routable.

### Action
A callable operation inside a skill.

Examples:
- `home_assistant.turn_on`
- `weather.get_forecast`
- `movie_showtimes.get_showtimes`

### Account
A configured external integration used by a skill.

Examples:
- Home Assistant `home`
- Home Assistant `office`
- Google Calendar `personal`
- Google Calendar `work`

Not every skill needs an account.

### Context
Runtime information used to execute or route a request.

Examples:
- user identity
- location
- timezone
- preferred theater
- current site (`home`, `office`)
- permission tier

### Result
Structured data returned by a skill action.

The skill returns facts and metadata. It does **not** return the final spoken response — that is the Response Generator's job.

### Runtime Dependencies
Python packages a skill requires to execute. Declared in the manifest and installed via pip when the skill is installed.

Examples:
- `web_search` depends on `duckduckgo-search`
- `home_assistant` depends on `httpx`
- `weather` depends on `httpx`

### Skill Dependencies
Other skills a skill requires to be installed and enabled. Declared in the manifest and resolved by the installer before the requesting skill is installed.

Examples:
- `movie_showtimes` depends on `web_search` (for provider fallback)

Skill dependencies come in two forms:
- **required**: the skill cannot function without it; goes `degraded` if the dependency is missing or disabled
- **optional**: the skill works without it but has reduced capability; degrades gracefully

---

## 3. Why this design

### Chosen design
A **custom in-process Skill/Action/Account/Context runtime** with:

- skill manifests
- validation
- lazy loading
- deterministic routing (sole routing method — no model fallback)
- separate response generation layer
- separate skill repository and installer

### Why this over other options

#### Option A: One giant plugin framework / agent framework
Rejected as the core runtime.

Why not:
- more memory overhead
- more startup overhead
- harder to reason about on Pi
- often optimized for cloud/LLM orchestration, not local capability execution
- tends to blur routing, execution, formatting, and reasoning together

#### Option B: MCP/FastMCP as the core runtime
Rejected as the core runtime, but useful at the edges.

Why not as core:
- adds protocol and transport concerns you do not need internally
- encourages server/tool boundaries that cost more than in-process skill calls
- great for interoperability, but not the lightest path for a Pi-local assistant

Where MCP still fits:
- optional adapter layer later
- exposing selected skills to external tools/hosts
- consuming external MCP servers if ever needed

#### Option C: Pure regex routing
Rejected as sole routing method.

Why not:
- too brittle
- hard to scale
- overlaps become unmanageable
- poor handling of fuzzy language

#### Option D: Full LLM routing for every request (including Gemma function-calling)
Rejected as the routing method.

Why not:
- **latency**: even a purpose-built function-calling model (e.g. Gemma 3 fine-tuned for tool use) runs 500ms–2s on Pi 5 hardware
- for a voice assistant, every extra second feels broken — this matters more than routing flexibility
- less predictable than deterministic scoring for high-frequency, well-known requests
- unnecessary for the vast majority of requests ("turn on the lights", "what's the weather")

Note on Gemma function-calling models specifically: these models are fine-tuned to take natural language and output structured JSON tool calls — no training required on your part. They are excellent at what they do. The reason LokiDoki does not use one is purely latency on Pi. If LokiDoki ever runs on faster hardware where 500ms–1s is acceptable, a function-calling model becomes a strong candidate to replace the deterministic scorer entirely. The skill manifest format already maps cleanly to tool schemas. This is not a dead end — it is a deferred option.

#### Option E: Hybrid deterministic + small-model fallback
Rejected as unnecessarily complex.

Why not:
- two routing systems to maintain and debug
- requires tuning thresholds for handoff decisions
- failures can come from either layer, making diagnosis harder
- the added complexity is not worth the marginal routing improvement on a Pi assistant
- better to pick one approach and handle true ambiguity with a clarification prompt to the user

### Why the chosen design is best for LokiDoki

It gives:

- **minimal overhead**: one process, lazy imports, shared resources
- **predictable behavior**: deterministic routing for all requests, clarification for genuine ambiguity
- **extensibility**: skills are packaged, validated, and installable
- **clean separation of concerns**: skills return facts, Response Generator builds spoken/screen output
- **swappable providers**: system skills like `web_search` define a stable interface; users can swap the backend (DuckDuckGo → Google → Brave) without other skills knowing or caring
- **future compatibility**: can swap to a function-calling model router later if hardware improves; can add MCP adapter for external interoperability

---

## 4. High-level architecture

```text
User speech / text
  ↓
STT (if voice)
  ↓
Normalizer
  ↓
Context Builder
  ↓
Router  ←─ reads skill manifests (phrases, keywords, entities, context)
  ├─ deterministic scorer
  ├─ clarification prompt if confidence is too low (returned to user)
  └─ "not a skill call" path → Response Generator handles directly
  ↓
Skill Manager
  ├─ skill registry
  ├─ lazy loader
  ├─ permission check
  ├─ account resolution
  ├─ context validation
  └─ action execution
  ↓
Structured skill result
  ↓
Response Generator  ←─ receives result + context + persona config
  ├─ voice response builder  (concise natural language for TTS)
  ├─ screen/card builder     (structured UI for display)
  └─ follow-up suggestion builder
  ↓
Persona layer  (applies LokiDoki tone/style)
  ↓
TTS / UI / logs
```

### Key clarifications on the pipeline

**Router → "not a skill call" path**
Not every utterance is a skill call. "Tell me a joke", "what's 12 times 8", or general conversation does not map to a skill action. The Router must detect this case and route directly to the Response Generator, which handles it as a general response without invoking the Skill Manager.

**Response Generator**
This is the component that takes a structured skill result and produces natural language. It is not the skill's job to write prose, and it is not raw template substitution — the Response Generator has access to context (user, persona config, prior turn) so it can produce responses that sound natural and consistent. For simple skill results (entity state changed, current weather) this can be template-driven. For richer results it may use lightweight generation.

The Response Generator is also responsible for handling the "not a skill call" path — general questions, chit-chat, and anything the Router could not match to a skill action.

---

## 5. Repository model

There are **two repos/sources**:

### A. Main LokiDoki app repo
Contains:
- core runtime
- router
- skill manager
- account manager
- context manager
- response generator
- skill installer
- built-in/system skills if desired

### B. Separate Skill Repository
Contains installable skill packages.

LokiDoki can:
- browse available skills
- view details and compatibility
- download skill packages
- verify package integrity/signature
- install or update skills
- enable/disable/remove skills

### Recommended skill repository structure

```text
skills-repo/
  index.json
  skills/
    home_assistant/
      1.0.0/
        package.zip
        package.sha256
    weather/
      1.0.0/
        package.zip
        package.sha256
    movie_showtimes/
      1.0.0/
        package.zip
        package.sha256
```

### `index.json` example

```json
{
  "schema_version": 1,
  "skills": [
    {
      "id": "home_assistant",
      "title": "Home Assistant",
      "latest_version": "1.0.0",
      "description": "Control Home Assistant devices and query states.",
      "domains": ["smart_home"],
      "download_url": "https://example.com/skills/home_assistant/1.0.0/package.zip",
      "sha256_url": "https://example.com/skills/home_assistant/1.0.0/package.sha256",
      "min_app_version": "1.0.0",
      "platforms": ["pi", "mac", "linux"],
      "account_mode": "multiple",
      "load_type": "warm",
      "permissions": ["trusted_users", "admin"]
    }
  ]
}
```

### Installation flow

1. App fetches repository index.
2. User browses/searches available skills.
3. User selects a skill.
4. App downloads package and checksum.
5. App verifies checksum and optional signature.
6. App unpacks to temp directory.
7. App validates manifest.
8. **App resolves skill dependencies:**
   - reads `skill_dependencies.required` and `skill_dependencies.optional`
   - checks which are already installed
   - installs any missing ones recursively (same install flow, depth-first)
   - detects and rejects circular dependencies before proceeding
   - if a required dependency fails to install, aborts the entire install
9. **App installs runtime dependencies:**
   - reads `runtime_dependencies`
   - runs `pip install` for any packages not already present
   - if pip install fails, aborts the entire install
10. App validates Python class/interface.
11. App registers skill in installed-skill DB.
12. User configures account/context/settings.
13. User enables the skill.

### Local installed skills directory

```text
LokiDoki_data/
  skills/
    installed/
      home_assistant/
        manifest.json
        skill.py
        assets/
      weather/
      movie_showtimes/
```

---

## 6. App pieces required

### 6.1 Skill Registry
Purpose:
- knows what skills are installed
- tracks enabled/disabled state
- tracks version and manifest metadata
- provides router-visible action metadata

Stores:
- installed skills
- versions
- compatibility
- current state
- load type
- permissions

### 6.2 Skill Loader
Purpose:
- lazy import skill implementations
- instantiate skill classes
- cache loaded skill objects

Behavior:
- `startup`: load at app startup
- `warm`: preload shortly after startup or after user/session becomes active
- `lazy`: load on first use

### 6.3 Skill Manager
Purpose:
- execute skill actions safely
- enforce permissions
- validate account/context requirements
- handle timeouts/retries
- record usage and errors

Responsibilities:
- resolve skill + action
- resolve account if needed
- validate context
- invoke action
- standardize result envelope

### 6.4 Account Manager
Purpose:
- manage external integrations/accounts
- support multiple accounts per skill

Examples:
- Home Assistant: `home`, `office`
- Calendar: `personal`, `work`

Stores:
- account id
- skill id
- label
- credentials/token
- endpoint URL
- auth metadata
- enabled/disabled state
- test/health status

### 6.5 Context Manager
Purpose:
- build effective context for routing and execution

Examples of context sources:
- current recognized user
- face profile
- device geolocation or saved home location
- network/site detection (`home`, `office`)
- user preferences
- time/date/timezone

Distinction:
- **Accounts** are configured integrations
- **Context** is runtime state and preferences

### 6.6 Permission Manager
Purpose:
- determine who can use which skills/actions/accounts

Examples:
- admin only
- trusted faces only
- kids blocked from purchases
- office account only for work profile

### 6.7 Router
Purpose:
- decide which skill/action should handle the request, or determine the input is not a skill call

Design:
- deterministic scorer only
- clarification prompt if top score is below confidence threshold
- explicit "not a skill call" classification → passes to Response Generator

The Router reads manifest routing metadata from the Skill Registry at startup (or when skills are installed/updated). It does not call any model. It does not guess.

When nothing scores above the confidence threshold, LokiDoki asks the user to clarify rather than guessing. This is preferable to a wrong skill invocation.

### 6.8 Response Generator
Purpose:
- accept structured skill results and produce natural language output
- handle the "not a skill call" path (general conversation, questions, chit-chat)
- apply context (user, session, persona config) to produce consistent, natural responses

Responsibilities:
- **Skill result → voice response**: concise natural language suitable for TTS
- **Skill result → screen output**: titles, cards, lists, quick actions
- **No-skill path**: handle general questions and conversation directly without invoking a skill
- **Follow-up suggestions**: propose what the user might ask next

Important:
- the skill returns structured facts, not prose
- the Response Generator decides how to express those facts
- the Persona layer applies tone/style on top afterward

This is a distinct component from the old "Result Formatter" concept. The difference is that the Response Generator must also handle inputs that did not come from a skill at all — it is the single exit point for all user-facing output before the Persona layer.

### 6.9 Persona Layer
Purpose:
- apply LokiDoki-specific tone, style, and personality after the Response Generator produces factual output
- keep voice consistent regardless of which skill produced the underlying data

### 6.10 Skill Store UI / Manager UI
Needed screens:

#### Installed Skills
- list installed skills
- version
- state
- enabled/disabled
- last used
- health
- update available

Actions:
- enable
- disable
- configure
- remove
- update
- test skill

#### Available Skills
- browse/search remote repository
- filter by category/domain
- see compatibility and permissions
- install

#### Skill Detail Page
Show:
- description
- actions
- required accounts
- required context
- allowed users
- configuration options
- changelog/version
- install/update/remove buttons

### 6.11 Installer / Updater
Purpose:
- fetch package
- verify integrity
- unpack
- migrate config if updating
- rollback if install/update fails

### 6.12 Health Monitor
Tracks:
- account auth failures
- repeated action errors
- network failures
- stale caches
- last success time

### 6.13 Cache Layer
Purpose:
- avoid repeated network calls
- improve speed
- enable fallback behavior

Types:
- memory cache
- disk cache
- per-action TTL

---

## 7. Skill package format

Each skill package should contain:

```text
home_assistant/
  manifest.json
  skill.py
  README.md
  assets/
    icon.png
```

### Manifest fields

Recommended manifest structure:

```json
{
  "schema_version": 1,
  "id": "movie_showtimes",
  "title": "Movie Showtimes",
  "domain": "movies",
  "description": "Find theatrical movie showtimes by date and location.",
  "version": "1.0.0",
  "load_type": "lazy",
  "account_mode": "none",
  "system": false,
  "enabled_by_default": false,
  "required_context": ["location"],
  "optional_context": ["preferred_theater", "date"],
  "permissions": {
    "default": "all_users"
  },
  "runtime_dependencies": [
    { "package": "httpx", "version": ">=0.27.0" }
  ],
  "skill_dependencies": {
    "required": [],
    "optional": [
      { "id": "web_search", "reason": "Fallback when primary showtimes provider fails" }
    ]
  },
  "actions": {
    "get_showtimes": {
      "title": "Get Showtimes",
      "description": "Return theatrical showtimes for a date and location.",
      "enabled": true,
      "required_context": ["location"],
      "optional_context": ["preferred_theater", "date"],
      "timeout_ms": 5000,
      "cache_ttl_sec": 900,
      "phrases": [
        "what movies are playing",
        "movie showtimes",
        "showtimes tonight",
        "movies showing today",
        "what's playing near me"
      ],
      "keywords": [
        "movie",
        "movies",
        "showtimes",
        "theater",
        "playing",
        "tonight",
        "today",
        "near me"
      ],
      "negative_keywords": [
        "review",
        "reviews",
        "cast",
        "actor",
        "rent",
        "buy",
        "stream"
      ],
      "example_utterances": [
        "what movies are playing today",
        "what are the movie showtimes tonight",
        "any movies showing near me"
      ],
      "required_entities": [],
      "optional_entities": ["movie_title", "date"]
    }
  }
}
```

### Manifest field reference

| Field | Type | Description |
|---|---|---|
| `system` | bool | If true, skill is protected — cannot be uninstalled. Used for built-in skills like `web_search` that other skills depend on. |
| `account_mode` | string | `none`, `single`, or `multiple`. `single` means only one active account at a time (e.g. the active search provider). `multiple` allows concurrent accounts (e.g. HA home + office). |
| `runtime_dependencies` | array | Python packages required. Installed via pip at skill install time. |
| `skill_dependencies.required` | array | Skills that must be installed and enabled. Skill goes `degraded` if missing. |
| `skill_dependencies.optional` | array | Skills that improve capability but are not required. Skill works without them. |

---

## 8. Enforcing skill format

Use **three layers of enforcement**.

### 8.1 Base class
Every skill inherits from a small base class.

```python
from abc import ABC, abstractmethod
from typing import Any

class BaseSkill(ABC):
    manifest: dict

    @abstractmethod
    async def execute(self, action: str, ctx: dict, **kwargs) -> dict:
        raise NotImplementedError

    def validate_action(self, action: str) -> None:
        actions = self.manifest.get("actions", {})
        if action not in actions:
            raise ValueError(f"Unknown action: {action}")
```

### 8.2 Manifest schema validation
At install time and app startup:
- validate required fields
- validate enum fields
- validate action metadata
- validate routing metadata

### 8.3 Runtime registration tests
At load/install time:
- ensure no duplicate skill IDs
- ensure all actions listed in manifest are executable
- ensure routing phrases do not conflict too heavily
- ensure timeout/cache fields are valid

---

## 9. Routing design

### 9.1 Why routing is deterministic-only

Routing every request with a model is too expensive for a voice assistant on Pi 5. Even purpose-built function-calling models (such as Gemma 3 fine-tuned for tool use) run 500ms–2s on Pi hardware. For a voice assistant, that latency is unacceptable on every request.

Pure regex is too brittle. So the solution is a **deterministic scorer** with meaningful signal: phrases, keywords, negative keywords, required context, required entities, and priority weighting. When the scorer cannot produce a confident winner, LokiDoki asks the user to clarify. This is simpler, faster, and more debuggable than a hybrid approach.

### 9.2 Deterministic routing inputs
Per action, use:
- phrases
- keywords
- negative keywords
- example utterances
- required context
- required entities
- priority

### 9.3 Score model
Candidate score components:
- exact phrase match: strong positive
- keyword overlap: positive
- negative keyword overlap: negative
- required context available: positive
- required context missing: strong negative
- required entities present: positive
- ownership term match: positive
- permissions/account availability: negative if blocked

### 9.4 "Not a skill call" detection

Before scoring against skill candidates, the Router should determine whether the input is a skill call at all. Inputs that score below a minimum threshold across all skills should be classified as general conversation or questions and routed directly to the Response Generator without invoking the Skill Manager.

Examples of non-skill inputs:
- "tell me a joke"
- "what's 12 times 8"
- "who invented the telephone"
- "thanks"

The Response Generator handles these directly.

### 9.5 Overlap prevention
Do **not** require zero overlap globally. Overlap is normal.

Instead:
- keep skills focused
- use negative keywords
- use required context/entities
- define ownership phrases for high-value terms
- validate near-duplicate routing metadata at install/build time

Example:
- `movie_showtimes` owns `showtimes`, `playing near me`
- `movie_reviews` owns `reviews`, `worth seeing`
- `movie_people` owns `cast`, `actor`, `director`

### 9.6 Clarification
When top candidates are too close or no candidate clears the confidence threshold, LokiDoki asks the user to clarify rather than guessing. This is always preferable to a wrong skill invocation.

Example: "I'm not sure if you want showtimes or reviews — which did you mean?"

---

## 10. Result design and response generation

### 10.1 Principle
A skill should return:
- structured facts
- metadata
- optional presentation hints

A skill should **not** return the final speech sentence. That is the Response Generator's job.

### 10.2 Standard result envelope

```json
{
  "ok": true,
  "skill": "movie_showtimes",
  "action": "get_showtimes",
  "data": {},
  "meta": {
    "source": "fandango",
    "cache_hit": false,
    "generated_at": "2026-03-27T04:00:00Z"
  },
  "presentation": {
    "type": "showtimes_list",
    "max_voice_items": 3,
    "max_screen_items": 10,
    "speak_priority_fields": ["movie", "theater", "times"]
  },
  "errors": []
}
```

### 10.3 Response Generator responsibilities

#### Voice response builder
Produces concise, natural spoken output from the structured result.

Example input: `{ temperature: 54, condition: "light wind", ... }`
Example output: "Right now it's 54 degrees with light wind."

The generator uses the result data, presentation hints, and active context (user, persona, session) to produce output. For simple well-defined result types, this can be template-driven. For richer results, lightweight generation logic applies.

#### Screen/card builder
Produces:
- title
- rows/cards
- buttons
- quick actions

#### No-skill path handler
Handles general questions, conversation, and anything the Router did not match to a skill action. This is not a fallback — it is a first-class path. General questions are expected and common.

#### Follow-up suggestion builder
Proposes what the user might ask next based on the current result and context.

### 10.4 Why this separation is better than skill-authored prose
- consistent voice across all skills
- easy UI reuse
- easier to test
- localization possible later
- skill code stays focused on data retrieval and action execution

---

## 11. Permissions and audience control

Each skill should support access control at both skill and account level.

### Skill-level permission examples
- `all_users`
- `trusted_users`
- `admin_only`
- `recognized_faces_only`

### Account-level permission examples
Home Assistant `office` account may only be usable by:
- work profile
- admin
- specific recognized users

### Action-level restrictions
Optional if needed.

Examples:
- allow `get_status`
- deny `unlock_door`
- allow `weather.get_forecast` for everyone

---

## 12. Installed skill UI requirements

### Installed Skills list
Columns/fields:
- icon
- title
- version
- state
- enabled
- load type
- last used
- health
- permissions summary

Actions:
- enable/disable
- configure
- open details
- test
- update
- remove

### Available Skills list
Fields:
- title
- description
- version
- category/domain
- required accounts
- required context
- compatibility
- install button

### Skill Detail view
Show:
- actions
- example utterances
- permissions
- account requirements
- context requirements
- load type
- version/changelog
- current status
- install/update/remove

### Accounts/Connections UI
Per skill:
- add account
- edit account
- test account
- set default account
- enable/disable account
- set allowed users

### Context Settings UI
Per skill:
- home location
- preferred theater
- timezone
- default site
- user-specific overrides

---

## 13. Fully built skill examples

The examples below are intentionally written for the proposed runtime.

System skills (marked `"system": true`) ship pre-installed with LokiDoki and cannot be uninstalled. They define stable interfaces that other skills depend on. The active provider can be swapped by the user, but the skill itself is always present.

---

# Skill 0: Web Search (system skill)

## Use case
Perform a web search and return structured results. Used directly by users ("search for X") and as a fallback by other skills when their primary provider fails.

## Why this is a system skill
Other skills depend on `web_search` as a fallback capability. It must always be present. Users can swap the active provider (DuckDuckGo → Google → Brave → SearXNG) but cannot uninstall the skill itself.

## Account mode
`single` — only one search provider is active at a time. Swapping providers is done in the Accounts UI.

The default pre-installed provider is DuckDuckGo (no account or API key required).

## Provider interface contract
Every `web_search` provider must implement `search(query, num_results)` and return the standard result envelope below. Skills that depend on `web_search` call this action — they never know or care which provider is active.

## Manifest

```json
{
  "schema_version": 1,
  "id": "web_search",
  "title": "Web Search",
  "domain": "search",
  "description": "Search the web and return structured results. Swappable provider — DuckDuckGo by default.",
  "version": "1.0.0",
  "load_type": "lazy",
  "account_mode": "single",
  "system": true,
  "enabled_by_default": true,
  "required_context": [],
  "optional_context": [],
  "permissions": {
    "default": "all_users"
  },
  "runtime_dependencies": [
    { "package": "duckduckgo-search", "version": ">=6.0.0" }
  ],
  "skill_dependencies": {
    "required": [],
    "optional": []
  },
  "actions": {
    "search": {
      "title": "Search",
      "description": "Search the web and return structured results.",
      "enabled": true,
      "required_context": [],
      "optional_context": [],
      "timeout_ms": 5000,
      "cache_ttl_sec": 300,
      "phrases": ["search for", "look up", "find", "google", "search the web"],
      "keywords": ["search", "find", "look up", "google", "web"],
      "negative_keywords": ["weather", "movie", "lights", "calendar"],
      "example_utterances": [
        "search for the best pizza places near me",
        "look up how to fix a leaky faucet"
      ],
      "required_entities": ["query"],
      "optional_entities": ["num_results"]
    }
  }
}
```

## Implementation (`skill.py`)

```python
from duckduckgo_search import DDGS
from core.base_skill import BaseSkill


class WebSearchSkill(BaseSkill):
    """
    Default provider: DuckDuckGo.
    To add a new provider (Google, Brave, SearXNG), subclass this skill
    and override _perform_search(). Register the subclass as an account
    in the skill repository.
    """

    manifest = {
        "id": "web_search",
        "domain": "search",
        "title": "Web Search",
        "actions": {
            "search": {},
        },
    }

    async def execute(self, action: str, ctx: dict, **kwargs) -> dict:
        self.validate_action(action)

        if action == "search":
            return await self.search(ctx, **kwargs)

        raise ValueError(f"Unhandled action: {action}")

    async def _perform_search(self, query: str, num_results: int) -> list[dict]:
        """Override this method to swap the search provider."""
        with DDGS() as ddgs:
            return list(ddgs.text(query, max_results=num_results))

    async def search(self, ctx: dict, query: str, num_results: int = 5) -> dict:
        try:
            results = await self._perform_search(query, num_results)
        except Exception as e:
            return {
                "ok": False,
                "skill": "web_search",
                "action": "search",
                "data": {},
                "meta": {"source": "duckduckgo"},
                "presentation": {"type": "search_results"},
                "errors": [str(e)],
            }

        return {
            "ok": True,
            "skill": "web_search",
            "action": "search",
            "data": {
                "query": query,
                "results": [
                    {
                        "title": r.get("title"),
                        "url": r.get("href"),
                        "snippet": r.get("body"),
                    }
                    for r in results
                ],
            },
            "meta": {
                "source": "duckduckgo",
                "cache_hit": False,
                "execution_mode": "fast",
            },
            "presentation": {
                "type": "search_results",
                "max_voice_items": 1,
                "max_screen_items": 5,
                "speak_priority_fields": ["results[0].title", "results[0].snippet"],
            },
            "errors": [],
        }
```

---

## Use case
Control entities and query states from one or more Home Assistant servers.

## Why this should be one skill
This skill is focused on smart-home interaction.
If it grows too large later, it can split into:
- `home_control`
- `home_status`
- `home_scenes`

For now, a focused Home Assistant skill is fine.

## Account model
`multiple`

Examples:
- `home`
- `office`

## Context
Required or useful:
- user identity
- current site
- room
- permissions

## Manifest

```json
{
  "schema_version": 1,
  "id": "home_assistant",
  "title": "Home Assistant",
  "domain": "smart_home",
  "description": "Control and query Home Assistant devices.",
  "version": "1.0.0",
  "load_type": "warm",
  "account_mode": "multiple",
  "system": false,
  "enabled_by_default": false,
  "required_context": [],
  "optional_context": ["site", "room", "user_id"],
  "permissions": {
    "default": "trusted_users"
  },
  "runtime_dependencies": [
    { "package": "httpx", "version": ">=0.27.0" }
  ],
  "skill_dependencies": {
    "required": [],
    "optional": []
  },
  "actions": {
    "turn_on": {
      "title": "Turn On",
      "description": "Turn on a Home Assistant entity.",
      "enabled": true,
      "required_context": [],
      "optional_context": ["site", "room"],
      "timeout_ms": 4000,
      "cache_ttl_sec": 0,
      "phrases": ["turn on", "switch on", "enable"],
      "keywords": ["turn on", "light", "lamp", "switch", "fan"],
      "negative_keywords": ["weather", "movie", "calendar"],
      "example_utterances": [
        "turn on the kitchen lights",
        "switch on the office lamp"
      ],
      "required_entities": ["target_entity"],
      "optional_entities": ["site", "room"]
    },
    "turn_off": {
      "title": "Turn Off",
      "description": "Turn off a Home Assistant entity.",
      "enabled": true,
      "required_context": [],
      "optional_context": ["site", "room"],
      "timeout_ms": 4000,
      "cache_ttl_sec": 0,
      "phrases": ["turn off", "switch off", "disable"],
      "keywords": ["turn off", "light", "lamp", "switch", "fan"],
      "negative_keywords": ["weather", "movie", "calendar"],
      "example_utterances": [
        "turn off the porch light",
        "switch off the conference room lights"
      ],
      "required_entities": ["target_entity"],
      "optional_entities": ["site", "room"]
    },
    "get_state": {
      "title": "Get State",
      "description": "Get the state of a Home Assistant entity.",
      "enabled": true,
      "required_context": [],
      "optional_context": ["site", "room"],
      "timeout_ms": 4000,
      "cache_ttl_sec": 5,
      "phrases": ["is the", "what is the status of", "what's the status of"],
      "keywords": ["status", "state", "on", "off", "temperature"],
      "negative_keywords": ["movie", "calendar", "forecast"],
      "example_utterances": [
        "is the garage door open",
        "what's the status of the office AC"
      ],
      "required_entities": ["target_entity"],
      "optional_entities": ["site", "room"]
    }
  }
}
```

## Implementation (`skill.py`)

```python
import httpx
from typing import Any

from core.base_skill import BaseSkill


class HomeAssistantSkill(BaseSkill):
    manifest = {
        "id": "home_assistant",
        "domain": "smart_home",
        "title": "Home Assistant",
        "actions": {
            "turn_on": {},
            "turn_off": {},
            "get_state": {},
        },
    }

    async def execute(self, action: str, ctx: dict, **kwargs) -> dict:
        self.validate_action(action)

        if action == "turn_on":
            return await self.turn_on(ctx, **kwargs)
        if action == "turn_off":
            return await self.turn_off(ctx, **kwargs)
        if action == "get_state":
            return await self.get_state(ctx, **kwargs)

        raise ValueError(f"Unhandled action: {action}")

    def _resolve_account(self, ctx: dict, account_id: str | None) -> dict:
        account = ctx["accounts"].resolve("home_assistant", account_id)
        if not account:
            raise ValueError("No Home Assistant account available")
        return account

    async def turn_on(self, ctx: dict, target_entity: str, account_id: str | None = None) -> dict:
        account = self._resolve_account(ctx, account_id)
        domain = target_entity.split(".")[0]

        async with httpx.AsyncClient(timeout=4.0) as client:
            await client.post(
                f"{account['url']}/api/services/{domain}/turn_on",
                headers={
                    "Authorization": f"Bearer {account['token']}",
                    "Content-Type": "application/json",
                },
                json={"entity_id": target_entity},
            )

        return {
            "ok": True,
            "skill": "home_assistant",
            "action": "turn_on",
            "data": {
                "entity_id": target_entity,
                "account": account["id"],
                "state": "on",
            },
            "meta": {
                "source": "home_assistant",
                "cache_hit": False,
                "execution_mode": "fast",
            },
            "presentation": {
                "type": "entity_state_change",
                "max_voice_items": 1,
                "max_screen_items": 1,
                "speak_priority_fields": ["entity_id", "state"],
            },
            "errors": [],
        }

    async def turn_off(self, ctx: dict, target_entity: str, account_id: str | None = None) -> dict:
        account = self._resolve_account(ctx, account_id)
        domain = target_entity.split(".")[0]

        async with httpx.AsyncClient(timeout=4.0) as client:
            await client.post(
                f"{account['url']}/api/services/{domain}/turn_off",
                headers={
                    "Authorization": f"Bearer {account['token']}",
                    "Content-Type": "application/json",
                },
                json={"entity_id": target_entity},
            )

        return {
            "ok": True,
            "skill": "home_assistant",
            "action": "turn_off",
            "data": {
                "entity_id": target_entity,
                "account": account["id"],
                "state": "off",
            },
            "meta": {
                "source": "home_assistant",
                "cache_hit": False,
                "execution_mode": "fast",
            },
            "presentation": {
                "type": "entity_state_change",
                "max_voice_items": 1,
                "max_screen_items": 1,
                "speak_priority_fields": ["entity_id", "state"],
            },
            "errors": [],
        }

    async def get_state(self, ctx: dict, target_entity: str, account_id: str | None = None) -> dict:
        account = self._resolve_account(ctx, account_id)

        async with httpx.AsyncClient(timeout=4.0) as client:
            response = await client.get(
                f"{account['url']}/api/states/{target_entity}",
                headers={
                    "Authorization": f"Bearer {account['token']}",
                    "Content-Type": "application/json",
                },
            )
            payload = response.json()

        return {
            "ok": True,
            "skill": "home_assistant",
            "action": "get_state",
            "data": {
                "entity_id": target_entity,
                "state": payload.get("state"),
                "attributes": payload.get("attributes", {}),
                "account": account["id"],
            },
            "meta": {
                "source": "home_assistant",
                "cache_hit": False,
                "execution_mode": "fast",
            },
            "presentation": {
                "type": "entity_state",
                "max_voice_items": 1,
                "max_screen_items": 1,
                "speak_priority_fields": ["entity_id", "state"],
            },
            "errors": [],
        }
```

---

# Skill 2: Weather

## Use case
Return current weather and forecast for a location.

## Why weather should be a focused skill
Weather is broad, but still coherent enough as one focused skill when limited to current/forecast.
If it grows later, split into:
- `weather_current`
- `weather_forecast`
- `weather_alerts`

## Account model
`none`

Weather does not need an account.
It needs **context**, mainly location and timezone.

## Context
Required:
- `location`

Optional:
- `timezone`
- `units`

## Manifest

```json
{
  "schema_version": 1,
  "id": "weather",
  "title": "Weather",
  "domain": "weather",
  "description": "Current weather and short forecast.",
  "version": "1.0.0",
  "load_type": "lazy",
  "account_mode": "none",
  "system": false,
  "enabled_by_default": true,
  "required_context": ["location"],
  "optional_context": ["timezone", "units"],
  "permissions": {
    "default": "all_users"
  },
  "runtime_dependencies": [
    { "package": "httpx", "version": ">=0.27.0" }
  ],
  "skill_dependencies": {
    "required": [],
    "optional": []
  },
  "actions": {
    "get_current": {
      "title": "Get Current Weather",
      "description": "Return current weather conditions.",
      "enabled": true,
      "required_context": ["location"],
      "optional_context": ["timezone", "units"],
      "timeout_ms": 4000,
      "cache_ttl_sec": 600,
      "phrases": ["what's the weather", "current weather", "weather right now"],
      "keywords": ["weather", "temperature", "forecast", "outside"],
      "negative_keywords": ["movie", "calendar", "light"],
      "example_utterances": [
        "what's the weather right now",
        "what's it like outside"
      ],
      "required_entities": [],
      "optional_entities": []
    },
    "get_forecast": {
      "title": "Get Forecast",
      "description": "Return forecast for a date or short range.",
      "enabled": true,
      "required_context": ["location"],
      "optional_context": ["timezone", "units"],
      "timeout_ms": 4000,
      "cache_ttl_sec": 1800,
      "phrases": ["weather tomorrow", "forecast", "will it rain", "do I need an umbrella"],
      "keywords": ["forecast", "tomorrow", "rain", "umbrella", "weather"],
      "negative_keywords": ["movie", "calendar", "showtimes"],
      "example_utterances": [
        "what's the weather tomorrow",
        "will it rain today"
      ],
      "required_entities": [],
      "optional_entities": ["date"]
    }
  }
}
```

## Implementation (`skill.py`)

```python
import httpx
from core.base_skill import BaseSkill


class WeatherSkill(BaseSkill):
    manifest = {
        "id": "weather",
        "domain": "weather",
        "title": "Weather",
        "actions": {
            "get_current": {},
            "get_forecast": {},
        },
    }

    async def execute(self, action: str, ctx: dict, **kwargs) -> dict:
        self.validate_action(action)

        if action == "get_current":
            return await self.get_current(ctx, **kwargs)
        if action == "get_forecast":
            return await self.get_forecast(ctx, **kwargs)

        raise ValueError(f"Unhandled action: {action}")

    def _resolve_location(self, ctx: dict, location: tuple[float, float] | None = None) -> tuple[float, float]:
        if location:
            return location
        if "location" not in ctx or not ctx["location"]:
            raise ValueError("Weather skill requires location context")
        return ctx["location"]

    async def get_current(self, ctx: dict, location: tuple[float, float] | None = None) -> dict:
        lat, lon = self._resolve_location(ctx, location)

        async with httpx.AsyncClient(timeout=4.0) as client:
            response = await client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current_weather": True,
                },
            )
            payload = response.json()

        current = payload.get("current_weather", {})

        return {
            "ok": True,
            "skill": "weather",
            "action": "get_current",
            "data": {
                "temperature": current.get("temperature"),
                "windspeed": current.get("windspeed"),
                "weathercode": current.get("weathercode"),
                "location": {"latitude": lat, "longitude": lon},
            },
            "meta": {
                "source": "open_meteo",
                "cache_hit": False,
                "execution_mode": "fast",
            },
            "presentation": {
                "type": "weather_current",
                "max_voice_items": 1,
                "max_screen_items": 1,
                "speak_priority_fields": ["temperature", "weathercode", "windspeed"],
            },
            "errors": [],
        }

    async def get_forecast(self, ctx: dict, date: str = "today", location: tuple[float, float] | None = None) -> dict:
        lat, lon = self._resolve_location(ctx, location)

        async with httpx.AsyncClient(timeout=4.0) as client:
            response = await client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                    "timezone": "auto",
                },
            )
            payload = response.json()

        daily = payload.get("daily", {})

        return {
            "ok": True,
            "skill": "weather",
            "action": "get_forecast",
            "data": {
                "date": date,
                "location": {"latitude": lat, "longitude": lon},
                "daily": daily,
            },
            "meta": {
                "source": "open_meteo",
                "cache_hit": False,
                "execution_mode": "detailed",
            },
            "presentation": {
                "type": "weather_forecast",
                "max_voice_items": 1,
                "max_screen_items": 5,
                "speak_priority_fields": ["date", "daily"],
            },
            "errors": [],
        }
```

---

# Skill 3: Movie Showtimes

## Use case
Return movies currently playing and their showtimes by date/location.

## Why this should be separate from a giant movies skill
Movies is too broad as one giant skill.
Showtimes should stay focused.
Details, reviews, cast, rentals, and purchases should be separate skills later.

## Account model
`none`

Movie showtimes usually do not require a user account.
They require context such as:
- location
- preferred theater
- date

## Context
Required:
- `location`

Optional:
- `preferred_theater`
- `date`

## Manifest

```json
{
  "schema_version": 1,
  "id": "movie_showtimes",
  "title": "Movie Showtimes",
  "domain": "movies",
  "description": "Find movie showtimes by location and date.",
  "version": "1.0.0",
  "load_type": "lazy",
  "account_mode": "none",
  "system": false,
  "enabled_by_default": true,
  "required_context": ["location"],
  "optional_context": ["preferred_theater", "date"],
  "permissions": {
    "default": "all_users"
  },
  "runtime_dependencies": [
    { "package": "httpx", "version": ">=0.27.0" }
  ],
  "skill_dependencies": {
    "required": [],
    "optional": [
      { "id": "web_search", "reason": "Fallback when primary showtimes provider is unavailable" }
    ]
  },
  "actions": {
    "get_showtimes": {
      "title": "Get Showtimes",
      "description": "Return movie showtimes for the given date and location.",
      "enabled": true,
      "required_context": ["location"],
      "optional_context": ["preferred_theater", "date"],
      "timeout_ms": 5000,
      "cache_ttl_sec": 900,
      "phrases": [
        "what movies are playing",
        "movie showtimes",
        "showtimes tonight",
        "movies showing today",
        "what's playing near me"
      ],
      "keywords": [
        "movie",
        "movies",
        "showtimes",
        "theater",
        "playing",
        "tonight",
        "today",
        "near me"
      ],
      "negative_keywords": [
        "review",
        "reviews",
        "cast",
        "actor",
        "rent",
        "buy",
        "stream"
      ],
      "example_utterances": [
        "what movies are playing today",
        "what are the movie showtimes tonight",
        "any good movies showing today"
      ],
      "required_entities": [],
      "optional_entities": ["movie_title", "date"]
    }
  }
}
```

## Implementation (`skill.py`)

```python
import httpx
from core.base_skill import BaseSkill


class MovieShowtimesSkill(BaseSkill):
    manifest = {
        "id": "movie_showtimes",
        "domain": "movies",
        "title": "Movie Showtimes",
        "actions": {
            "get_showtimes": {},
        },
    }

    async def execute(self, action: str, ctx: dict, **kwargs) -> dict:
        self.validate_action(action)

        if action == "get_showtimes":
            return await self.get_showtimes(ctx, **kwargs)

        raise ValueError(f"Unhandled action: {action}")

    def _resolve_location(self, ctx: dict, location=None):
        if location:
            return location
        if "location" not in ctx or not ctx["location"]:
            raise ValueError("Movie showtimes skill requires location context")
        return ctx["location"]

    async def _fetch_from_provider(
        self, lat: float, lon: float, date: str, movie_title: str | None, preferred_theater: str | None
    ) -> list[dict] | None:
        """
        Call the primary showtimes provider.
        Returns a list of results or None if unavailable.
        Replace this with a real provider integration.
        """
        # Placeholder — swap with Fandango, SerpAPI, etc.
        return None

    async def _fallback_web_search(
        self, ctx: dict, lat: float, lon: float, date: str, movie_title: str | None
    ) -> list[dict]:
        """
        Use the web_search skill as a fallback when the primary provider fails.
        Calls web_search.search via the Skill Manager — never imports it directly.
        """
        skill_manager = ctx.get("skill_manager")
        if not skill_manager:
            return []

        query = f"movie showtimes near {lat},{lon} {date}"
        if movie_title:
            query = f"{movie_title} showtimes near {lat},{lon} {date}"

        try:
            result = await skill_manager.execute(
                skill_id="web_search",
                action="search",
                ctx=ctx,
                query=query,
                num_results=5,
            )
            if result.get("ok") and result.get("data", {}).get("results"):
                # Return raw search results — Response Generator will format these
                return result["data"]["results"]
        except Exception:
            pass

        return []

    async def get_showtimes(
        self,
        ctx: dict,
        date: str = "today",
        movie_title: str | None = None,
        location=None,
        preferred_theater: str | None = None,
    ) -> dict:
        lat, lon = self._resolve_location(ctx, location)

        results = await self._fetch_from_provider(lat, lon, date, movie_title, preferred_theater)
        source = "showtimes_provider"
        used_fallback = False

        if not results:
            results = await self._fallback_web_search(ctx, lat, lon, date, movie_title)
            source = "web_search_fallback"
            used_fallback = True

        return {
            "ok": True,
            "skill": "movie_showtimes",
            "action": "get_showtimes",
            "data": {
                "date": date,
                "location": {"latitude": lat, "longitude": lon},
                "movie_title": movie_title,
                "preferred_theater": preferred_theater,
                "results": results,
                "used_fallback": used_fallback,
            },
            "meta": {
                "source": source,
                "cache_hit": False,
                "execution_mode": "detailed",
            },
            "presentation": {
                "type": "showtimes_list" if not used_fallback else "search_results",
                "max_voice_items": 3,
                "max_screen_items": 10,
                "speak_priority_fields": ["movie", "theater", "times"],
            },
            "errors": [],
        }
```

---

## 14. Response Generator design examples

### Example 1: weather current
Skill result data:
- temperature: 54
- weathercode: light wind
- windspeed: 8

Response Generator voice output:
- "Right now it's 54 degrees with light wind."

Response Generator screen output:
- title: `Current weather`
- subtitle: location
- metrics card: temp, wind, precipitation if present

### Example 2: movie showtimes
Skill result data:
- list of movies/theaters/times

Response Generator voice output:
- "Today near you, Dune: Part Two is playing at AMC Milford 12 at 1:10, 4:30, and 7:45."

Response Generator screen output:
- title: `Movie showtimes for today`
- grouped cards by theater or movie

### Example 3: Home Assistant
Skill result data:
- entity state changed to `on`

Response Generator voice output:
- "Kitchen lights turned on."

Response Generator screen output:
- title: `Home Assistant`
- card showing entity and new state

### Example 4: no-skill path (general question)
Input: "what's the capital of France"

Router: no skill match → routes to Response Generator directly

Response Generator voice output:
- "The capital of France is Paris."

No skill result envelope involved.

---

## 15. State and runtime model

Each installed skill should track:

- `installed`
- `enabled`
- `state`
- `load_type`
- `version`
- `health`
- `last_used_at`
- `last_error`

### Recommended states
- `disabled`
- `inactive`
- `loading`
- `ready`
- `degraded`
- `error`

### Recommended load types
- `startup`
- `warm`
- `lazy`

Suggested defaults:
- `home_assistant`: `warm`
- `weather`: `lazy`
- `movie_showtimes`: `lazy`

---

## 16. Data storage model

Minimum persistent tables/collections:

### `installed_skills`
- skill_id
- version
- enabled
- state
- load_type
- system (bool — protected from uninstall)
- installed_at
- last_used_at
- last_error

### `skill_runtime_dependencies`
- skill_id
- package_name
- version_constraint
- installed_version

### `skill_skill_dependencies`
- skill_id (the dependent)
- depends_on_skill_id (the dependency)
- dependency_type (`required` or `optional`)

### `skill_accounts`
- account_id
- skill_id
- label
- config_json
- enabled
- health_status
- last_tested_at

### `skill_permissions`
- skill_id
- action_id nullable
- audience type
- audience value

### `skill_context_defaults`
- skill_id
- key
- value
- scope (`global`, `user`, `site`)

### `skill_cache`
- key
- skill_id
- action_id
- payload
- expires_at

---

## 17. Security model

### Package integrity
- checksum verification required
- optional signing strongly recommended

### Sandboxing
Initial version may run installed skills in-process.
If third-party skill trust becomes a concern later:
- signed packages only
- optional isolated worker process for untrusted skills

### Secret handling
Accounts should store secrets securely, separate from skill package code.
Skill packages must never contain environment-specific secrets.

---

## 18. Update and removal behavior

### Update
- check compatibility
- download new package
- verify integrity
- install to temp path
- validate
- swap active version
- preserve account/config if compatible
- rollback on failure

### Remove
- check if any installed skills declare this as a required dependency — block removal and show which skills depend on it
- if `system: true` in manifest, block removal entirely
- disable skill
- unload if loaded
- optionally preserve config/accounts or offer full purge
- remove package files

Recommended UI choices:
- `Disable`
- `Uninstall`
- `Uninstall and remove accounts/settings`

---

## 19. Recommended build order

### Phase 1: Core runtime
- `BaseSkill`
- manifest schema (including `runtime_dependencies`, `skill_dependencies`, `system`, `account_mode: single`)
- skill registry
- lazy loader
- skill manager (including inter-skill calls via `ctx["skill_manager"]`)
- dependency resolver (pip for runtime deps, recursive skill install for skill deps)
- basic installed skill DB

### Phase 2: Routing
- deterministic scorer
- entity/context extractor
- "not a skill call" classifier
- routing validation checks
- clarification prompt path

### Phase 3: Response Generator
- result envelope processor
- voice response builder
- screen/card builder
- no-skill path handler
- persona integration hook

### Phase 4: Skill store
- available skill repository index
- installer/updater/remover
- installed skill UI
- available skill UI

### Phase 5: Accounts/permissions/context
- account manager
- context manager
- permission manager
- skill configuration UI

### Phase 6: Example skills
- Web Search (system skill, DuckDuckGo provider — migrated from existing app implementation)
- Home Assistant
- Weather
- Movie Showtimes (with web_search fallback)

### Phase 7: Hardening
- checksum/signing
- rollback
- health monitor
- cache tuning
- conflict detection and tests

---

## 20. Final recommendations

### Strong recommendations
- Keep the **core runtime custom and in-process**.
- Keep skills **small and focused**.
- Use **deterministic routing only** — no model fallback, handle ambiguity with clarification.
- Keep **accounts separate from context**.
- Keep **skill results structured**, with natural language built by the Response Generator.
- The **Response Generator handles all output** — both skill results and the no-skill path.
- Build a **separate skill repository** with manifest-driven install/update flow.
- **`web_search` is a system skill** — ships pre-installed, cannot be uninstalled, provider is swappable. Skills that need web fallback depend on it; they never call DuckDuckGo or any specific provider directly.
- **Declare all dependencies in the manifest** — runtime packages via `runtime_dependencies`, other skills via `skill_dependencies`. The installer resolves both automatically.
- **Skills call other skills via the Skill Manager**, never by importing them directly. This keeps the provider swap transparent.

### Do not do these early
- do not make every request go through a model router — latency is unacceptable on Pi for a voice assistant
- do not use a hybrid deterministic + model router — two systems to debug is worse than one
- do not let each skill write its own full user-facing prose — that is the Response Generator's job
- do not make one giant `movies` or `news` mega-skill
- do not force every skill to use accounts
- do not use a heavy plugin framework as the runtime core on Pi
- do not hardcode DuckDuckGo or any search provider anywhere except the `web_search` skill itself

### On Gemma function-calling models
A purpose-built Gemma 3 function-calling model (fine-tuned to turn natural language into structured JSON tool calls, no training required) would map well onto this architecture — the skill manifest is already tool-schema shaped. The reason LokiDoki does not use one is hardware latency: 500ms–2s per request on Pi 5 is too slow for a voice assistant where every second matters. If LokiDoki moves to faster hardware in the future, replacing the deterministic scorer with a function-calling model becomes a straightforward swap. The rest of the architecture does not change.

### Summary
This design is optimized for:
- Raspberry Pi efficiency
- predictable behavior
- extensibility
- maintainability
- future growth into a real skill marketplace/repository

It gives LokiDoki a clean internal architecture now, while still leaving room for future interoperability standards and hardware improvements later.
