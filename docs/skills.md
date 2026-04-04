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

### Progress Event
A lightweight status message emitted by a skill during execution and streamed to the UI before the final result arrives.

Examples:
- `"Finding showtimes near Milford..."`
- `"Checking weather for your location..."`
- `"Searching Wikipedia..."`
- `"Fetching results from fallback source..."`

Progress events give the user visible feedback that something is happening and make multi-step skills feel responsive. They are fire-and-forget — they do not block execution.

### Provider Chain
An ordered list of data sources a skill will try in sequence. The first provider that returns valid results wins. If all providers fail, the skill returns an error.

Examples:
- `movie_showtimes`: Fandango → SerpAPI → `web_search` fallback
- `wikipedia`: Wikipedia API → web scrape fallback
- `weather`: Open-Meteo → NWS API fallback

Provider chains are declared in the manifest and executed by the skill. The active provider used is always recorded in `meta.source` in the result envelope.

### Source
A structured attribution record returned by a skill, identifying where the data came from.

Examples:
- `{ "label": "Wikipedia", "url": "https://en.wikipedia.org/wiki/..." }`
- `{ "label": "Fandango", "url": "https://www.fandango.com/..." }`
- `{ "label": "Open-Meteo", "url": "https://open-meteo.com" }`

Sources are displayed in the UI as clickable attribution links below the skill result card. Skills that return data from a specific URL or named service must populate `sources` in the result envelope.

### Media Attachment
A structured reference to a visual or media item that the Response Generator may embed in the screen output.

Types:
- `image`: a photo or still image (URL or local path)
- `youtube`: a YouTube video link
- `poster`: a movie/show poster image
- `map`: a geographic map tile or embed URL
- `thumbnail`: a small preview image

Skills may include media attachments in their result. The Response Generator decides whether and how to display them based on the current surface (voice-only, screen available, screen size).

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
- optional adapter layer later (post-Phase 4)
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

#### Option F: Pure keyword/regex phrase matching (the naive approach)
Rejected as the scoring implementation.

Why not:
- brittle: "what are good films nearby" would miss `movie_showtimes` because "films" isn't in the keyword list
- doesn't scale: as the number of installed skills grows, maintaining non-overlapping keyword lists becomes unmanageable
- no semantic understanding: synonyms, paraphrases, and natural variation all break it

The solution is a **multi-signal weighted scorer** (see Section 9) that uses phrases, keywords, negative keywords, TF-IDF-style term weighting against action descriptions, and context/entity availability — all evaluated deterministically without any model. This gives the predictability of a keyword matcher with meaningful resilience to natural language variation. It is a solved problem in classical information retrieval, not something that needs to be invented.

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
- multi-signal weighted scorer (phrases, keywords, TF-IDF description index, synonym expansion, context/entity signals)
- **not** a regex or simple keyword matcher — see Section 9 for the full scoring design
- clarification prompt if top score is below confidence threshold or top two candidates are too close
- explicit "not a skill call" classification → passes to Response Generator

The Router reads manifest routing metadata from the Skill Registry at startup (or when skills are installed/updated). It builds an inverted index of action descriptions for TF-IDF scoring. It does not call any model. It does not guess.

When nothing scores above the confidence threshold, LokiDoki asks the user to clarify rather than guessing. This is preferable to a wrong skill invocation.

The Router normalises input (lowercase, strip punctuation, apply synonym expansions) before scoring. Stemming is applied to keyword matching. All of this is deterministic and runs in microseconds.

### 6.8 Response Generator
Purpose:
- accept structured skill results and produce natural language output
- handle the "not a skill call" path (general conversation, questions, chit-chat)
- apply context (user, session, persona config) to produce consistent, natural responses

Responsibilities:
- **Skill result → voice response**: concise natural language suitable for TTS
- **Skill result → screen output**: titles, cards, lists, quick actions, source attribution, media
- **No-skill path**: handle general questions and conversation directly without invoking a skill
- **Follow-up suggestions**: propose what the user might ask next
- **Progress event stream**: pass skill progress events to the UI layer in real time

Important:
- the skill returns structured facts, not prose
- the Response Generator decides how to express those facts
- the Persona layer applies tone/style on top afterward
- media attachments in the result are filtered by surface before rendering

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
  test_skill.py
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
| `provider_chain` | array | Ordered list of data providers to try in sequence. First successful result wins. See Section 10.4. |
| `synonym_expansions` | object | Optional per-skill additions to the Router's synonym table. Map of `"user_term": "canonical_term"`. Example: `{ "flick": "movie", "flicks": "movies" }`. |

### Action-level manifest field reference

| Field | Type | Description |
|---|---|---|
| `phrases` | array | Strong-signal natural language phrases. Router uses token overlap, not exact match. |
| `keywords` | array | Supporting terms. Router uses stemming for variation. |
| `negative_keywords` | array | Terms that disqualify this action. |
| `description` | string | Human-readable description of what this action does. Used by Router's TF-IDF index. |
| `example_utterances` | array | Representative user inputs. Validated at install time — all must score above threshold. |
| `required_entities` | array | Entities that must be present in input for full execution. |
| `optional_entities` | array | Entities that improve execution quality but aren't required. |
| `priority` | int | Tiebreaker weight. Higher wins. Default: 0. |

---

## 8. Enforcing skill format

Use **three layers of enforcement**.

### 8.1 Base class
Every skill inherits from a small base class.

```python
from abc import ABC, abstractmethod
from typing import Any, Callable, Awaitable

class BaseSkill(ABC):
    manifest: dict

    @abstractmethod
    async def execute(
        self,
        action: str,
        ctx: dict,
        emit_progress: Callable[[str], Awaitable[None]],
        **kwargs
    ) -> dict:
        raise NotImplementedError

    def validate_action(self, action: str) -> None:
        actions = self.manifest.get("actions", {})
        if action not in actions:
            raise ValueError(f"Unknown action: {action}")

    def build_sources(self, *sources: dict) -> list[dict]:
        """Convenience helper to construct the sources list."""
        return [s for s in sources if s.get("label") and s.get("url")]

    def build_media(self, *items: dict) -> list[dict]:
        """Convenience helper to construct the media list."""
        return [m for m in items if m.get("type") and m.get("url")]
```

The `emit_progress` callable is always injected by the Skill Manager. Skills that don't need it can accept and ignore it — it is never None.
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

### 8.4 Mandatory test coverage
At load/install time (optional) or during development (mandatory):
- ensure `test_skill.py` exists
- ensure all actions have at least one test case
- ensure external network calls are mocked
- ensure the provider chain's fallback behavior is validated

---

## 9. Routing design

### 9.1 Why routing is deterministic-only

Routing every request with a model is too expensive for a voice assistant on Pi 5. Even purpose-built function-calling models (such as Gemma 3 fine-tuned for tool use) run 500ms–2s on Pi hardware. For a voice assistant, that latency is unacceptable on every request.

Pure keyword/regex matching is also insufficient. A user saying "any good films showing nearby?" should hit `movie_showtimes` even though "films" and "nearby" aren't in the keyword list. Simple word matching doesn't scale as skills multiply, and maintaining non-overlapping keyword lists across 20+ installed skills becomes unmanageable.

The solution is a **multi-signal weighted scorer** — deterministic, fast, and meaningfully resilient to natural language variation. This is a solved problem in classical information retrieval (BM25-style scoring, TF-IDF weighting, inverted indexes). We do not need to invent it.

### 9.2 How the scorer actually works (multi-signal, not simple keyword matching)

This is **not** a regex matcher. Each action candidate receives a composite score from multiple signals evaluated in order:

**Signal 1 — Phrase match (strongest signal, +3.0 to +4.0)**
The normalised user input is checked against each action's `phrases` list. Matching is not exact string equality — it uses normalised token overlap. "any movies playing near me tonight" matches the phrase "what movies are playing near me" because the token overlap across the key intent tokens (movies, playing, near) is high. Exact or near-exact matches score higher than partial overlaps.

**Signal 2 — Keyword density (+0.6 per keyword hit, up to a cap)**
Each keyword from the action's `keywords` list that appears in the user input adds to the score. The cap prevents a skill with 20 generic keywords from dominating. Keyword matching uses stemming — "filming" matches "film", "playing" matches "play" — to handle natural variation without requiring exhaustive synonym lists.

**Signal 3 — Synonym/paraphrase expansion (via lightweight lookup table, +0.8)**
A small built-in synonym table (not a model) maps common substitutions: "flick" → movie, "flicks" → movies, "nearby" → near me, "climate" → weather, "what time is it" → current time. Skills can extend this table via their manifest (`synonym_expansions`). This handles the most common natural variation cases without any model call.

**Signal 4 — TF-IDF weighted action description match (+0 to +2.0)**
Each action has a `description` field. The Router maintains a lightweight inverted index of action descriptions (built at startup from installed skill manifests). The user's input tokens are scored against this index using TF-IDF weights. A query like "show me current weather conditions" will score well against `"Return current weather conditions"` even with no exact phrase match. This is the classical IR approach and runs in microseconds on CPU.

**Signal 5 — Negative keyword penalty (−1.5 per hit)**
Keywords in `negative_keywords` that appear in the user input subtract from the score. "what movies should I rent" hits `movie_showtimes` on keywords but the negative keyword "rent" reduces the score enough to drop it below threshold.

**Signal 6 — Context/entity availability (+0.5 to +1.0 positive, −2.0 if required and missing)**
If a required context (e.g. `location`) is available, the score increases. If it's required but missing, the score is strongly penalised. This prevents routing to a skill that cannot execute.

**Signal 7 — Action priority (tiebreaker, +0 to +0.5)**
Actions may declare a `priority` in their manifest. Used as a tiebreaker when scores are otherwise equal.

### 9.3 Routing inputs (manifest fields used by scorer)

Per action:
- `phrases` — strong-signal natural language phrases
- `keywords` — supporting terms (with stemming)
- `negative_keywords` — disqualifying terms
- `description` — used for TF-IDF index
- `synonym_expansions` — optional per-skill synonym additions
- `example_utterances` — used during manifest validation to verify phrases/keywords cover the examples
- `required_context` — must be available to score well
- `required_entities` — presence in input boosts score
- `priority` — tiebreaker weight

### 9.4 "Not a skill call" detection

Before scoring against skill candidates, the Router classifies whether the input is a skill call at all. If the top score across all installed skills is below `MIN_SKILL_THRESHOLD`, the input is classified as general conversation and routed directly to the Response Generator.

The "not a skill call" classifier is itself score-based — it's not a separate model. It uses the same scorer output. A low top-score means nothing matched, which means it's general conversation.

Examples that will correctly score below threshold:
- "tell me a joke"
- "what's 12 times 8"
- "who invented the telephone"
- "thanks"

### 9.5 Thresholds

| Threshold | Name | Default | Behavior |
|---|---|---|---|
| `MIN_ROUTE_SCORE` | Confident match | 3.0 | Execute the skill |
| `MIN_SKILL_CALL_SCORE` | Weak match | 1.5 | May be a skill call, check for ambiguity |
| `CLARIFY_MARGIN` | Ambiguity margin | 0.75 | If top two scores are within this delta, ask the user |

These are tunable per deployment. Defaults are conservative (prefer clarification over wrong invocation).

### 9.6 Overlap and conflict prevention

Do **not** require zero overlap globally. Overlap is normal and expected.

Instead:
- keep skills focused on a distinct domain
- use negative keywords to push ambiguous inputs away from the wrong skill
- use `required_context` and `required_entities` to differentiate
- define high-weight phrases for high-value terms that a skill owns
- validate near-duplicate routing metadata at install time (installer warns on excessive overlap)

Example ownership:
- `movie_showtimes` owns: `showtimes`, `playing near me`, `what's playing`
- `movie_reviews` owns: `reviews`, `worth seeing`, `is it good`
- `movie_people` owns: `cast`, `who's in`, `director`, `actor`

### 9.7 Clarification

When top candidates are too close (delta < `CLARIFY_MARGIN`) or no candidate clears `MIN_ROUTE_SCORE`, LokiDoki asks the user to clarify rather than guessing. This is always preferable to a wrong skill invocation.

Example: "I'm not sure if you want showtimes or reviews — which did you mean?"

### 9.8 Validation at install time

When a skill is installed, the installer validates routing quality:
- all `example_utterances` must score above `MIN_ROUTE_SCORE` against the skill's own actions
- no example utterance should score higher against a *different* installed skill than against this skill's own actions
- if overlap is detected, the installer warns (but does not block install)

This catches routing conflicts before they reach users.

### 9.9 Why this is not "inventing something new"

The multi-signal weighted scorer described here is classical information retrieval:
- TF-IDF and inverted indexes are from the 1970s
- BM25 (a more sophisticated variant) is from 1994 and still used in production search engines today
- Stemming and synonym expansion are standard NLP preprocessing with well-maintained Python libraries (NLTK, spaCy, or even simple hand-coded stemmers)
- None of this requires a model, GPU, or external service

The implementation surface is small: an inverted index built at startup from manifest descriptions, a scoring function, and a normalizer. Total RAM footprint is kilobytes. Latency is microseconds.

---

## 10. Result design and response generation

### 10.1 Principle
A skill should return:
- structured facts
- metadata
- sources
- optional media attachments
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
    "generated_at": "2026-03-27T04:00:00Z",
    "provider_chain": ["fandango", "serp_api", "web_search"],
    "provider_used": "fandango",
    "used_fallback": false
  },
  "sources": [
    {
      "label": "Fandango",
      "url": "https://www.fandango.com/movie-times"
    }
  ],
  "media": [],
  "presentation": {
    "type": "showtimes_list",
    "max_voice_items": 3,
    "max_screen_items": 10,
    "speak_priority_fields": ["movie", "theater", "times"]
  },
  "errors": []
}
```

### 10.3 Progress events

Skills should emit progress events during execution. These are streamed to the UI immediately and give the user visible feedback before the final result arrives. This makes multi-step skills feel fast and responsive — even if execution takes a few seconds, the user sees activity immediately.

Progress events also help distinguish "skill is working" from "LLM is formatting the response" — two different phases that should look different to the user.

#### How progress events work

The skill receives an `emit_progress` callable in its execution context. It calls this at meaningful checkpoints. Each call streams a message to the UI immediately — it does not block execution.

```python
async def get_showtimes(self, ctx: dict, emit_progress, **kwargs) -> dict:
    await emit_progress("Finding movies near you...")
    results = await self._fetch_from_provider(...)

    if not results:
        await emit_progress("Trying backup source...")
        results = await self._fallback_web_search(...)

    await emit_progress("Building showtime list...")
    # format results...
    return {...}
```

#### When to emit progress

- before any network call: `"Checking weather for Milford..."`
- when switching to a fallback: `"Primary source unavailable, trying backup..."`
- before a slow processing step: `"Building your results..."`
- for multi-step skills: one event per meaningful step

#### When NOT to emit progress

- for very fast in-memory operations (no point)
- for simple command skills like `home_assistant.turn_on` — the response itself is near-instant

#### Progress event format

```json
{
  "type": "skill_progress",
  "skill": "movie_showtimes",
  "action": "get_showtimes",
  "message": "Finding movies near you...",
  "timestamp": "2026-03-27T04:00:01.123Z"
}
```

#### UI behavior

Progress messages appear as a muted status line in the chat UI while the skill is running, replacing each other as new events arrive. Once the final result is ready, the progress line disappears and the result card takes its place. This mirrors the "Reading the file... Searching the web..." pattern in AI assistants like Claude.

The key UX principle: **show something immediately**. Even a 2-second skill execution feels fast if the user sees "Finding showtimes near you..." within 50ms of speaking.

### 10.4 Provider chains

Skills that retrieve data from external sources should define an ordered provider chain. The first provider that returns valid results wins. All providers must return data in the skill's standard internal format.

#### Declaring a provider chain in the manifest

```json
"provider_chain": [
  {
    "id": "fandango",
    "label": "Fandango",
    "type": "api",
    "requires_account": false
  },
  {
    "id": "serp_api",
    "label": "SerpAPI",
    "type": "api",
    "requires_account": true,
    "account_id": "serp_api"
  },
  {
    "id": "web_search_fallback",
    "label": "Web search",
    "type": "skill_dependency",
    "skill_id": "web_search",
    "action": "search"
  }
]
```

#### Implementing a provider chain in skill.py

```python
async def get_showtimes(self, ctx, emit_progress, **kwargs):
    providers = [
        self._fetch_from_fandango,
        self._fetch_from_serp_api,
        self._fallback_web_search,
    ]
    labels = ["Fandango", "SerpAPI", "web search"]

    for provider_fn, label in zip(providers, labels):
        await emit_progress(f"Checking {label}...")
        try:
            results = await provider_fn(ctx, **kwargs)
            if results:
                return self._build_result(results, source=label)
        except Exception:
            continue

    return self._build_error_result("No showtime data available from any source")
```

#### Rules for provider chains

- always emit a progress event before calling each provider
- record the provider that succeeded in `meta.provider_used`
- record the full chain attempted in `meta.provider_chain`
- set `meta.used_fallback: true` if any provider after the first was used
- surface the source in `sources[]` so the user and UI can see where data came from

### 10.5 Sources

Every skill result that pulls data from an external service or URL must populate the `sources` array. This is required, not optional.

```json
"sources": [
  {
    "label": "Wikipedia",
    "url": "https://en.wikipedia.org/wiki/Dune_(novel)"
  },
  {
    "label": "Fandango",
    "url": "https://www.fandango.com/dune-part-two-228835/movie-times"
  }
]
```

Sources are displayed in the UI as small attribution links below the result card. They serve two purposes:
1. User trust: the user can verify or explore further
2. Transparency: the user sees what LokiDoki actually used to answer

Skills that produce data entirely from local computation (e.g. a timer, calculator) do not need sources.

### 10.6 Media attachments

Skills may include media attachments in their result. The Response Generator decides whether and how to render them based on the surface.

```json
"media": [
  {
    "type": "poster",
    "url": "https://image.tmdb.org/t/p/w500/abc123.jpg",
    "alt": "Dune: Part Two movie poster",
    "context": "movie_poster"
  },
  {
    "type": "youtube",
    "url": "https://www.youtube.com/watch?v=...",
    "label": "Official trailer",
    "context": "trailer"
  }
]
```

#### Media types

| Type | Description | Source examples |
|---|---|---|
| `image` | General photo or illustration | Wikipedia infobox image, news photo |
| `poster` | Movie/show promotional poster | TMDB, OMDB |
| `youtube` | YouTube video link | YouTube Data API |
| `thumbnail` | Small preview image | Search result thumbnails |
| `map` | Geographic map embed | Google Maps, OpenStreetMap |
| `icon` | Small brand/service icon | Service logos |

#### Rules for media

- never fetch media during routing — only during execution
- always include `alt` text for accessibility
- always include `context` so the Response Generator knows what the media represents
- media URLs must be public and not require authentication
- skills must not include media that is not directly relevant to the result (no decorative images)

#### How the Response Generator handles media

- voice-only surface: media is ignored entirely
- screen available, small: only `poster` and `icon` types may be shown
- screen available, full: all media types may be shown
- `youtube` links are shown as a labeled button (never auto-play)
- `image` and `poster` are shown inline in the result card
- `map` is shown as an embedded preview with a "open in maps" link

### 10.7 Response Generator responsibilities

#### Voice response builder
Produces concise, natural spoken output from the structured result.

Example input: `{ temperature: 54, condition: "light wind", ... }`
Example output: "Right now it's 54 degrees with light wind."

The generator uses the result data, presentation hints, and active context (user, persona, session) to produce output. For simple well-defined result types, this can be template-driven. For richer results, lightweight generation logic applies.

#### Screen/card builder
Produces:
- title
- rows/cards
- buttons / quick actions
- source attribution links (from `sources[]`)
- media attachments (from `media[]`, filtered by surface)

#### No-skill path handler
Handles general questions, conversation, and anything the Router did not match to a skill action. This is not a fallback — it is a first-class path. General questions are expected and common.

#### Follow-up suggestion builder
Proposes what the user might ask next based on the current result and context.

### 10.8 Why this separation is better than skill-authored prose
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

    async def execute(self, action: str, ctx: dict, emit_progress, **kwargs) -> dict:
        self.validate_action(action)

        if action == "get_showtimes":
            return await self.get_showtimes(ctx, emit_progress, **kwargs)

        raise ValueError(f"Unhandled action: {action}")

    def _resolve_location(self, ctx: dict, location=None):
        if location:
            return location
        if "location" not in ctx or not ctx["location"]:
            raise ValueError("Movie showtimes skill requires location context")
        return ctx["location"]

    async def _fetch_from_fandango(
        self, lat: float, lon: float, date: str, movie_title: str | None, preferred_theater: str | None
    ) -> tuple[list[dict], str] | None:
        """
        Primary provider: Fandango API.
        Returns (results, source_url) or None if unavailable.
        Replace with real Fandango/API integration.
        """
        return None

    async def _fetch_from_serp_api(
        self, lat: float, lon: float, date: str, movie_title: str | None
    ) -> tuple[list[dict], str] | None:
        """
        Secondary provider: SerpAPI showtimes.
        Returns (results, source_url) or None if unavailable.
        """
        return None

    async def _fallback_web_search(
        self, ctx: dict, lat: float, lon: float, date: str, movie_title: str | None
    ) -> tuple[list[dict], str]:
        """
        Last resort: web_search skill.
        Calls web_search.search via the Skill Manager — never imports it directly.
        """
        skill_manager = ctx.get("skill_manager")
        if not skill_manager:
            return [], ""

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
                results = result["data"]["results"]
                source_url = results[0].get("url", "") if results else ""
                return results, source_url
        except Exception:
            pass

        return [], ""

    async def get_showtimes(
        self,
        ctx: dict,
        emit_progress,
        date: str = "today",
        movie_title: str | None = None,
        location=None,
        preferred_theater: str | None = None,
    ) -> dict:
        lat, lon = self._resolve_location(ctx, location)

        providers = [
            ("Fandango", lambda: self._fetch_from_fandango(lat, lon, date, movie_title, preferred_theater)),
            ("SerpAPI", lambda: self._fetch_from_serp_api(lat, lon, date, movie_title)),
            ("web search", lambda: self._fallback_web_search(ctx, lat, lon, date, movie_title)),
        ]

        results = []
        source_label = None
        source_url = ""
        used_fallback = False

        for i, (label, provider_fn) in enumerate(providers):
            await emit_progress(f"Checking {label} for showtimes...")
            try:
                outcome = await provider_fn()
                if outcome:
                    results, source_url = outcome
                    if results:
                        source_label = label
                        used_fallback = i > 0
                        break
            except Exception:
                continue

        if results:
            await emit_progress("Building showtime list...")

        # Build poster media for the first matched movie, if TMDB is available
        media = []
        if results and movie_title:
            poster_url = await self._fetch_poster(movie_title)
            if poster_url:
                media = self.build_media({
                    "type": "poster",
                    "url": poster_url,
                    "alt": f"{movie_title} movie poster",
                    "context": "movie_poster",
                })

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
            },
            "meta": {
                "source": source_label or "none",
                "provider_chain": [p[0] for p in providers],
                "provider_used": source_label,
                "used_fallback": used_fallback,
                "cache_hit": False,
            },
            "sources": self.build_sources({
                "label": source_label,
                "url": source_url,
            }) if source_label else [],
            "media": media,
            "presentation": {
                "type": "showtimes_list" if not used_fallback else "search_results",
                "max_voice_items": 3,
                "max_screen_items": 10,
                "speak_priority_fields": ["movie", "theater", "times"],
            },
            "errors": [] if results else ["No showtimes found from any source"],
        }

    async def _fetch_poster(self, movie_title: str) -> str | None:
        """Fetch movie poster URL from TMDB. Returns None if unavailable."""
        # Placeholder — integrate TMDB API here
        return None
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

## 19. Testing Standards

Every LokiDoki skill must include a `test_skill.py` file using the `pytest` framework. This ensures reliability on the Raspberry Pi where manual debugging is more difficult.

### 19.1 Mocking Requirements
- **No real network calls**: All external APIs (Fandango, Open-Meteo, Wikipedia, etc.) must be mocked using `pytest-httpx` or similar tools.
- **Deterministic results**: Mocks should return consistent data to ensure tests are repeatable and fast.

### 19.2 Action Validation
- EVERY action defined in `manifest.json` must have at least one test case.
- Tests must verify that the `execute()` method returns a valid result envelope (Section 10.2).
- Tests must verify that `data` and `meta` fields contain the expected information for a given input.

### 19.3 Provider Chain (Fallback) Testing
- Skills with a `provider_chain` (Section 10.4) must have tests that simulate a failure in the primary provider.
- Failure testing ensures the skill correctly falls back to the secondary or tertiary provider without crashing.
- Example: Disable the `Open-Meteo` mock and verify the skill calls the `NWS` fallback.

### 19.4 Progress Event Testing
- Verify that `emit_progress` is called with the expected status strings during long-running or multi-provider executions.

---

## 20. Recommended build order

### Phase 1: Core runtime (Status: COMPLETED)
- [x] **Initial Migration & Cleanup** (migration to async/httpx, removal of placeholder skills, rich Wikipedia infobox scraping)
- [x] **Mandatory Testing** (Section 19: every skill must ship with `test_skill.py`. Progress: tests implemented for `movies` and `wikipedia` in `loki-doki-skills` repo; others pending migration.)
- [x] `BaseSkill` (implemented in core, used by migrated skills)
- [x] manifest schema/validator (Section 7)
- [x] skill registry (`app/skills/registry.py`)
- [x] lazy loader (`app/skills/loader.py`)
- [x] skill manager (`app/skills/manager.py`)
- [x] dependency resolver (pip for runtime, recursive skill install in `installer.py`)
- [x] basic installed skill DB (`storage.py`)

### Phase 2: Routing (Status: IN PROGRESS)
- input normalizer (lowercase, strip punctuation, synonym expansion)
- stemmer (for keyword matching — NLTK or hand-coded is fine)
- inverted index builder (from manifest `description` fields, built at startup)
- TF-IDF scorer against action descriptions
- phrase matcher (token overlap, not exact string match)
- keyword scorer with stemming
- negative keyword penalty
- context/entity signal scorer
- "not a skill call" classifier (threshold-based, not a separate model)
- routing validation checks (all `example_utterances` must score correctly)
- clarification prompt path

### Phase 3: Response Generator (Status: IN PROGRESS)
- progress event stream (emit to UI before result is ready)
- result envelope processor
- voice response builder
- screen/card builder (with sources and media attachment rendering)
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

## 21. Final recommendations

### Strong recommendations
- Keep the **core runtime custom and in-process**.
- Keep skills **small and focused**.
- Use **deterministic routing only** — no model fallback, handle ambiguity with clarification.
- The router must be a **multi-signal weighted scorer**, not a simple keyword/regex matcher. Use TF-IDF description indexing, phrase token overlap, stemmed keyword matching, and synonym expansion. This is classical IR — it is not complex to implement, and it is the right tool. See Section 9.
- Keep **accounts separate from context**.
- Keep **skill results structured**, with natural language built by the Response Generator.
- The **Response Generator handles all output** — both skill results and the no-skill path.
- Build a **separate skill repository** with manifest-driven install/update flow.
- **`web_search` is a system skill** — ships pre-installed, cannot be uninstalled, provider is swappable. Skills that need web fallback depend on it; they never call DuckDuckGo or any specific provider directly.
- **Declare all dependencies in the manifest** — runtime packages via `runtime_dependencies`, other skills via `skill_dependencies`. The installer resolves both automatically.
- **Skills call other skills via the Skill Manager**, never by importing them directly. This keeps the provider swap transparent.
- **All skills that fetch external data must define a `provider_chain`** — ordered fallbacks, not just a primary source. See Section 10.4.
- **All skills that return external data must populate `sources[]`** — the user and UI must always know where data came from.
- **Skills must emit `progress_events`** for any execution that involves a network call or takes more than ~200ms. The user must see something immediately. See Section 10.3.
- **Media attachments (`media[]`)** should be returned by skills where relevant (posters, images, YouTube links). The Response Generator decides whether to show them based on surface.
- **Formal testing is mandatory** — every skill must ship with a `test_skill.py` that mocks the network and validates all actions and fallbacks.

### Do not do these early
- do not make every request go through a model router — latency is unacceptable on Pi for a voice assistant
- do not use a hybrid deterministic + model router — two systems to debug is worse than one
- do not let each skill write its own full user-facing prose — that is the Response Generator's job
- do not make one giant `movies` or `news` mega-skill
- do not force every skill to use accounts
- do not use a heavy plugin framework as the runtime core on Pi
- do not hardcode DuckDuckGo or any search provider anywhere except the `web_search` skill itself
- do not use pure keyword/regex matching as the router — it will break as soon as the skill count grows
- do not skip progress events for skills with network calls — silent loading feels broken

### On the routing question: is this solved elsewhere?
Yes. The multi-signal deterministic scorer described in Section 9 is a well-established classical IR pattern. It combines elements from:
- **BM25** (the standard probabilistic relevance model, used in Elasticsearch and Lucene since the 1990s)
- **TF-IDF** (term frequency–inverse document frequency, the foundation of keyword-based search)
- **Feature-based intent classifiers** used in production voice assistants (Google Assistant, Alexa) for exactly this routing use case

None of these require a model or external dependency. The implementation is a few hundred lines of Python. Libraries like `rank_bm25` (pure Python, no dependencies) implement BM25 in a form directly usable for this. The key insight is that action descriptions and phrases are your "documents" and the user's utterance is the "query." BM25 retrieves the best matching action in milliseconds.

### On MCP (deferred, not rejected)
MCP becomes relevant after Phase 4 (skill store is live). At that point, a generic `MCPSkill` that wraps any MCP server manifest and maps its tools to LokiDoki actions would allow users to install community integrations without writing Python. This is additive — it doesn't change the router, the manifest format, or the result envelope. It's a future skill type, not a redesign.

### On Gemma function-calling models
A purpose-built Gemma 3 function-calling model would map well onto this architecture — the skill manifest is already tool-schema shaped. The reason LokiDoki does not use one is hardware latency: 500ms–2s per request on Pi 5 is too slow for a voice assistant where every second matters. If LokiDoki moves to faster hardware in the future, replacing the deterministic scorer with a function-calling model becomes a straightforward swap. The rest of the architecture does not change.

### Summary
This design is optimized for:
- Raspberry Pi efficiency
- predictable behavior
- extensibility
- maintainability
- future growth into a real skill marketplace/repository

It gives LokiDoki a clean internal architecture now, while still leaving room for future interoperability standards and hardware improvements later.

---

## 22. Peer review findings and design decisions

This section records findings from a comparative review of LokiDoki's skill system against similar platforms (Onyx, Open WebUI, LibreChat, AnythingLLM) and documents the design decisions made as a result.

### 21.1 Onyx (formerly Danswer)

Onyx is a fundamentally different product class. Its connectors are background workers that sync external data sources (GitHub, Confluence, Notion) into a vector index for enterprise knowledge retrieval. It uses Celery, Redis, and Vespa — a cloud-native stack. Its routing is LLM-driven (agentic). Its latency per turn is 500ms–2s+.

**Conclusion**: Onyx and LokiDoki are solving different problems. Onyx answers "what did we write about X?" across an organization's documents. LokiDoki executes "turn off the lights" and "what movies are playing." The connector model, background sync architecture, and LLM routing are all inappropriate for LokiDoki's hardware and use case.

**One useful distinction Onyx makes**: the separation between "live action" (do something now) and "indexed knowledge" (search past data). LokiDoki's current design handles live actions well. A future "data connector" concept for skills that maintain a local index (notes, calendar history) is worth exploring post-Phase 6, adapted to LokiDoki's in-process model.

### 21.2 Open WebUI

Open WebUI uses native function-calling (LLM decides which tool to call) as its primary routing method, with a legacy prompt-injection mode for older models. It supports MCP via HTTP/SSE and its Pipelines system allows Python functions to intercept and extend the chat pipeline.

Its tool calling is reliable for server-class hardware but breaks the KV cache every turn in legacy mode, adding latency and cost. The Pipelines architecture is powerful but requires Python knowledge.

**Conclusion**: Open WebUI's routing approach is incompatible with Pi hardware constraints. Its MCP support confirms MCP is becoming a real standard worth supporting as an adapter layer post-Phase 4. Its progress-display pattern (showing "Reading file...", "Searching web...") is the right UX model for LokiDoki's progress events — now captured in Section 10.3.

### 21.3 LibreChat and AnythingLLM

LibreChat's MCP integration is the most mature of the group. AnythingLLM's `@agent` invocation model (skill calls are explicit, not automatic) is an interesting alternative but adds friction for a voice-first assistant.

**Conclusion**: No design changes needed from these. MCP remains a post-Phase 4 consideration. The explicit `@agent` pattern is wrong for voice.

### 21.4 What was changed based on this review

The following additions were made to this document as a result of the review:

- **Section 2**: Added `ProgressEvent`, `ProviderChain`, `Source`, and `MediaAttachment` to core terminology
- **Section 3**: Added Option F (pure keyword/regex) to the rejected approaches and explained why a multi-signal scorer is the correct solution
- **Section 6.7**: Updated Router description to reflect multi-signal scoring (not keyword matching)
- **Section 8.1**: Updated `BaseSkill` to include `emit_progress` in the interface
- **Section 9**: Replaced the basic scoring section with a full multi-signal scoring design based on classical IR (TF-IDF, BM25-style, stemming, synonym expansion)
- **Section 10**: Expanded result design to include progress events (10.3), provider chains (10.4), sources (10.5), and media attachments (10.6)
- **Section 19**: Updated Phase 2 and Phase 3 build steps to reflect new components
- **Section 20**: Updated final recommendations to include new strong recommendations

### 21.5 What was explicitly not changed

- The deterministic routing approach is correct and was confirmed by the peer review
- The in-process runtime is correct for Pi hardware
- MCP remains deferred to post-Phase 4 (not rejected, not urgent)
- Hybrid deterministic + model routing remains rejected
- The manifest format, dependency system, and skill package structure are unchanged

---

## 23. Instructions for AI coding assistants

This section is written for AI coding assistants (Gemini, Claude, Copilot, etc.) working on this codebase. Read it before writing any code.

### 22.1 What this document is

This is the authoritative design specification for LokiDoki's Skill System. Every architectural decision in it was made deliberately. When you see a "Why not" section, that means the rejected approach was already considered and ruled out — do not re-introduce it.

### 22.2 Hard constraints — never violate these

- **No model calls in the router.** The router is deterministic. It uses BM25/TF-IDF scoring, phrase matching, and keyword signals. It never calls an LLM, never loads an embedding model, never calls an external service.
- **No LLM routing fallback.** If no skill matches, the router returns `no_skill` and the Response Generator handles it as general conversation. There is no "ask the LLM which skill to use" path.
- **No parallel skill execution.** Skills run sequentially. One skill per request.
- **Skills never import each other directly.** Inter-skill calls go through the Skill Manager via `ctx["skill_manager"].execute(...)`.
- **Skills never write prose.** They return structured data. The Response Generator writes all user-facing text.
- **The result envelope shape is fixed.** It always contains: `ok`, `skill`, `action`, `data`, `meta`, `sources`, `media`, `presentation`, `errors`. Do not add top-level fields or remove existing ones.
- **`emit_progress` is always the third positional argument** in `execute()` after `action` and `ctx`. Never omit it from the signature.
- **Always generate a `test_skill.py`**. Every skill you create must include a formal test suite that mocks all network calls and verifies every action/fallback defined in the manifest.

### 22.3 Key design decisions and where they are documented

| Question | Answer | Where |
|---|---|---|
| Why not use an LLM for routing? | Latency: 500ms–2s on Pi 5, unacceptable for voice | Section 3, Option D |
| Why not use keyword/regex matching? | Brittle, doesn't scale, breaks on synonyms | Section 3, Option F; Section 9.1 |
| How does routing actually work? | Multi-signal BM25/TF-IDF scorer, no model | Section 9 |
| How do fallback providers work? | Provider chain in manifest + skill.py loop | Section 10.4 |
| How do progress messages work? | `emit_progress` callable injected by Skill Manager | Section 10.3 |
| How are sources attributed? | `sources[]` array in result envelope, required | Section 10.5 |
| How is media (photos, YouTube) handled? | `media[]` array in result, Response Generator filters by surface | Section 10.6 |
| Why not MCP as the core runtime? | Protocol overhead, not needed internally | Section 3, Option B |
| When will MCP be added? | Post-Phase 4, as an adapter layer only | Section 20 |

### 22.4 How to work on this codebase in phases

Work strictly within the current phase. Do not implement components from future phases, even if they seem obviously needed.

**Phase 1 — Core runtime** (start here)
Implement: `BaseSkill`, manifest schema validator, `SkillRegistry`, `SkillLoader`, `SkillManager`, dependency resolver.
Key files: `app/skills/base.py`, `app/skills/registry.py`, `app/skills/loader.py`, `app/skills/manager.py`
Reference sections: 6.1–6.3, 7, 8

**Phase 2 — Routing**
Implement: input normalizer, stemmer, TF-IDF index builder, multi-signal scorer, "not a skill call" classifier, clarification path.
Key files: `app/skills/router.py`, `app/skills/normalizer.py`, `app/skills/tfidf_index.py`
Reference sections: 6.7, 9

**Phase 3 — Response Generator**
Implement: progress event stream, result envelope processor, voice response builder, screen/card builder, no-skill path handler.
Key files: `app/skills/response.py`, `app/skills/progress.py`
Reference sections: 6.8, 10

**Phase 4 — Skill store**
Implement: repository index fetcher, installer, updater, remover.
Key files: `app/skills/installer.py`, `app/skills/store.py`
Reference sections: 5, 6.11, 18

**Phase 5 — Accounts, permissions, context**
Implement: `AccountManager`, `ContextManager`, `PermissionManager`.
Key files: `app/skills/accounts.py`, `app/skills/context.py`, `app/skills/permissions.py`
Reference sections: 6.4–6.6, 11

**Phase 6 — Example skills**
Implement the four example skills from Section 13 in this order: `web_search` (system skill), `home_assistant`, `weather`, `movie_showtimes`.
Reference sections: 13 (full skill examples)

**Phase 7 — Hardening**
Add: checksum verification, rollback, health monitor, routing conflict detection, cache tuning.
Reference sections: 6.12–6.13, 17, 18

### 22.5 Per-task prompt format

When asking an AI coding assistant to implement something, use this format:

```
Phase: [current phase]
Task: [one specific file or function]
Sections: [relevant section numbers from skills.md]
Do not change: [list anything already implemented that must stay unchanged]
Do not add: [anything from future phases]
```

### 22.6 Before writing any code, confirm

1. What phase is currently active?
2. What file are you being asked to create or modify?
3. What sections of this document govern that file?
4. Does the task require a model call? (If yes, stop — you are misreading the spec.)
5. Does the task require changing the result envelope shape? (If yes, check Section 10.2 first.)
