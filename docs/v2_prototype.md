# LokiDoki — Capability-Orchestrated Request Pipeline (v2 prototype)
## Design Document

---

> ⚠️ **IMPORTANT — PROTOTYPE SCOPE**
>
> We are building a **prototype only accessible under the Dev Tools section of the LokiDoki app**.
> All code goes under a **`v2/` parent folder** — no existing project code should be modified in any way,
> other than to display the v2 prototype on the Dev Tools page.
> If v2 proves successful, we can later plan a migration into / replacement of existing code.

---

## Implementation Status — at-a-glance

| Phase | Title | Status | Notes |
|-------|-------|--------|-------|
| 1 | Minimal Working Pipeline | ✅ **Done** | spaCy single-call parser, doc-aware split/extract, mature fast lane, full trace |
| 2 | Semantic Routing (MiniLM) | ✅ **Done** | Registry-backed routing, startup vector index, fastembed/MiniLM with hash fallback |
| 3 | Real Resolver | 🟡 **Done against in-memory adapters** | People / device / media / pronoun resolvers ship; real PeopleDB / Home Assistant clients still to wire |
| 4 | Parallel Execution | 🟡 **Mostly done** | `asyncio.gather` + `to_thread` everywhere; sequential-vs-parallel benchmarks still TODO |
| 5 | Gemma Fallback | 🟡 **Stubbed** | `decide_gemma()`, trace flag, deterministic stub synthesizer; real Ollama Gemma client not wired |
| 6 | Production Hardening | 🟡 **Core in place** | Per-handler timeout/retry, error classes, 80+ unit/integration tests; broader regression fixtures pending |

**Live source of truth:** the Dev Tools panel at `/api/v1/dev/v2/status` reflects the same status with per-phase shipped/remaining lists. The detail under each phase in §15 below is kept in sync with that endpoint.

---

## Table of Contents

1. [Project Goal](#1-project-goal)
2. [System Name & One-Line Definition](#2-system-name--one-line-definition)
3. [Core Design Principles](#3-core-design-principles)
4. [Full Pipeline Overview](#4-full-pipeline-overview)
5. [Pipeline Step Reference Table](#5-pipeline-step-reference-table)
6. [Detailed Step Specifications](#6-detailed-step-specifications)
   - [Step −1: Fast Lane & Direct Utilities](#step--1-fast-lane--direct-utilities)
   - [Step 0: Normalize](#step-0-normalize)
   - [Parallel: Interaction & Tone Signals](#parallel-interaction--tone-signals)
   - [Step 1: Parse](#step-1-parse)
   - [Step 2: Split (Clause Segmentation)](#step-2-split-clause-segmentation)
   - [Step 3: Extract](#step-3-extract)
   - [Step 4: Route (MiniLM)](#step-4-route-minilm)
   - [Step 5: Select Implementation (Registry)](#step-5-select-implementation-registry)
   - [Step 6: Resolve](#step-6-resolve)
   - [Step 7: Execute (Parallel)](#step-7-execute-parallel)
   - [Step 8: Build RequestSpec](#step-8-build-requestspec)
   - [Step 9: Combine or Reason (Gemma)](#step-9-combine-or-reason-gemma)
   - [Step 10: Deliver](#step-10-deliver)
   - [Step 11: Observe](#step-11-observe)
7. [Capability Types: Core vs. Skill](#7-capability-types-core-vs-skill)
8. [Runtime Capability Registry](#8-runtime-capability-registry)
9. [Skill Contract (Drop-In Single File)](#9-skill-contract-drop-in-single-file)
10. [Parallelization Strategy](#10-parallelization-strategy)
11. [RequestSpec](#11-requestspec)
12. [Data Models](#12-data-models)
13. [Observability](#13-observability)
14. [Interaction & Tone Signals Layer](#14-interaction--tone-signals-layer)
15. [Phased Implementation Plan](#15-phased-implementation-plan)
16. [Folder & File Structure](#16-folder--file-structure)
17. [Pseudocode — Full Pipeline](#17-pseudocode--full-pipeline)
18. [Pseudocode — Per Module](#18-pseudocode--per-module)
19. [Function Registry Schema](#19-function-registry-schema)
20. [Edge Cases & Examples](#20-edge-cases--examples)
21. [Design Guardrails](#21-design-guardrails)

---

## 1. Project Goal

Build a **local, low-latency, no-training request orchestration layer** for LokiDoki that can:

- Accept raw user text or ASR text
- Lightly normalize input
- Parse once using spaCy
- Detect whether input is one request or multiple compound requests
- Extract meaningful parts (entities, predicates, references)
- Route each request chunk to the correct capability using semantic matching (MiniLM)
- Map capabilities to the highest-priority enabled skill
- Resolve references against local context and databases (People DB, Home Assistant, etc.)
- Execute independent tasks in parallel
- Combine results into a coherent, natural response
- Log and time every stage without noticeable overhead
- Use Gemma only where reasoning is genuinely needed

This layer must be:

- **Deterministic first**, LLM-assisted second
- **Local-first** — no required cloud calls in the core pipeline
- **Debuggable** — full trace at every stage
- **Modular** — each component is independently replaceable
- **No-training** — no intent models to train, label, or retrain

---

## 2. System Name & One-Line Definition

**System Name:** Capability-Orchestrated Request Pipeline
**Short name (in code/conversation):** Request Orchestrator

> Turns natural language into capability calls, runs the best enabled skill(s), and returns a unified answer. Gemma only steps in when reasoning or cleanup is needed.

---

## 3. Core Design Principles

| Principle | Rule |
|-----------|------|
| Parse once | Run spaCy one time per utterance. Reuse the same `doc` object everywhere. |
| Use the dumbest component that reliably works | Rules → spaCy → MiniLM → Gemma (escalate only when necessary) |
| Route to abstract capabilities | The router picks a capability name, not a skill. The registry picks the skill. |
| Only enabled capabilities go to the router | Disabled skills are invisible to MiniLM. |
| Parallelize after splitting | Normalize / parse / split / combine / deliver are sequential. Route / resolve / execute are parallel per chunk. |
| Gemma is fallback, not default | Only trigger Gemma for ambiguous splits, hard resolves, or multi-result synthesis. |
| Precompute, don't repeat | The runtime capability registry is built at startup and cached. Never rebuild it per request. |
| Interaction signals take priority | Detect negation, correction, and frustration before routing. |
| Fast Lane first | Trivial whole-utterance requests bypass the entire pipeline. |

---

## 4. Full Pipeline Overview

```
User Input
  │
  ▼
[ Normalize ]
  │
  ├──── (parallel) ────────────────────────────────────┐
  │                                                    │
  ▼                                                    ▼
[ Interaction & Tone Signals ]              [ Fast Lane Check ]
  │ negation / correction /                 │ trivial standalone?
  │ frustration / tone                      │
  │                                         │
  ▼                                         ▼
  If signal → handle signal first     If matched → Direct Utility → Response
  │
  └──── If no override → continue to main pipeline
              │
              ▼
        [ Parse — spaCy (ONE call) ]
              │
              ▼
        [ Split — Clause Segmentation ]
              │
              ▼
        [ Extract — Entities, Refs, Predicates ]
              │
              ▼  (parallel per chunk)
        [ Route — MiniLM → Capability Name ]
              │
              ▼  (parallel per chunk)
        [ Select Implementation — Registry + Priority ]
              │
              ▼  (parallel per chunk)
        [ Resolve — Context / People DB / Device DB ]
              │
              ▼  (parallel per chunk)
        [ Execute — Skill Handlers ]
              │
              ▼
        [ Build RequestSpec ]
              │
              ├── Simple path → [ Fast Combine ]
              │
              └── Complex / ambiguous → [ Gemma ]
                        │
                        ▼
                  [ Deliver — Text / TTS / UI ]
                        │
                        ▼
                  [ Observe — Logs / Trace / Timing ]
```

---

## 5. Pipeline Step Reference Table

| Step | Name | Tool | Input | Output |
|------|------|------|-------|--------|
| −1 | Fast Lane | string checks + rules | normalized text | immediate response OR fallthrough |
| 0 | Normalize | custom code | raw text | cleaned text |
| ∥ | Interaction & Tone Signals | rules / keyword match | normalized text | signal type + tone |
| 1 | Parse | spaCy (once) | cleaned text | spaCy `doc` |
| 2 | Split | custom logic on `doc` | spaCy `doc` | request chunks |
| 3 | Extract | custom logic on `doc` | spaCy `doc` | entities, predicates, references |
| 4 | Route | MiniLM embeddings | chunk text | capability name + confidence |
| 5 | Select Implementation | capability registry | capability name | chosen skill handler |
| 6 | Resolve | resolver + DB/context | refs/entities | concrete params |
| 7 | Execute | skill handler / API | function + params | task results |
| 8 | Build RequestSpec | builder | all results + context | structured snapshot |
| 9 | Combine / Reason | fast logic OR Gemma | RequestSpec | response object |
| 10 | Deliver | formatter / TTS / UI | response object | user-facing output |
| 11 | Observe | logger + tracer | events from all steps | structured trace |

---

## 6. Detailed Step Specifications

---

### Step −1: Fast Lane & Direct Utilities

**Purpose:** Bypass the full pipeline for trivial, standalone requests.

**Placement:** After normalization, in parallel with Interaction Signals.

**Rule:** Fast Lane only fires when the **entire utterance** is simple and standalone — not just when a simple phrase is embedded in a larger request.

**Fast Lane examples (match):**
- `"hello"` → greeting handler
- `"thanks"` → acknowledgment handler
- `"what time is it"` → Direct Utility: clock
- `"what is 6x4"` → Direct Utility: math
- `"how do you spell restaurant"` → Direct Utility: spelling
- `"what day is it"` → Direct Utility: date

**Fast Lane non-examples (fall through):**
- `"what time is it because I don't know if we'll make it to the 8pm movie"` — has a dependent clause
- `"hello, can you check if Sarah is home"` — has a real request following
- `"what is 6x4 and what time is it"` — compound, goes to full pipeline

**Eligibility check:**
```python
def is_fast_lane_eligible(text: str) -> bool:
    lower = text.lower().strip()
    # Fail if contains connectors
    connectors = ["because", "and", " if ", "so that", "but", "also"]
    for c in connectors:
        if c in lower:
            return False
    # Fail if above length threshold
    if len(lower.split()) > 8:
        return False
    # Check against known fast-lane patterns
    return matches_fast_lane_pattern(lower)
```

**Direct Utility Handlers (always-available, no skill needed):**

| Utility | Examples |
|---------|---------|
| `get_current_time` | "what time is it", "what's the time" |
| `get_current_date` | "what day is it", "what's today's date" |
| `calculate_math` | "what is 6x4", "what's 15% of 80" |
| `convert_units` | "how many feet in a mile", "convert 100F to Celsius" |
| `spell_word` | "how do you spell restaurant", "spell necessary" |
| `greeting_response` | "hello", "hey", "hi there" |
| `acknowledgment_response` | "thanks", "thank you", "got it" |

---

### Step 0: Normalize

**Purpose:** Make text consistent without destroying meaning.

**Responsibilities:**
- Trim leading/trailing whitespace
- Collapse repeated spaces
- Normalize unicode (NFKC)
- Normalize curly quotes and apostrophes
- Optionally produce a lowercase copy for matching
- Preserve the original text

**What to avoid:**
- Stopword removal
- Aggressive punctuation stripping
- Stemming or lemmatization at this stage
- Any transformation that destroys meaning

**Why:** Small words and punctuation carry meaning in commands.  
`"turn off the fan"` vs `"turn on the fan"` — destructive cleanup breaks this.

```python
import re
import unicodedata

def normalize_text(raw_text: str) -> NormalizedInput:
    cleaned = unicodedata.normalize("NFKC", raw_text)
    cleaned = cleaned.replace("\u201c", '"').replace("\u201d", '"')
    cleaned = cleaned.replace("\u2018", "'").replace("\u2019", "'")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return NormalizedInput(raw_text=raw_text, cleaned_text=cleaned)
```

---

### Parallel: Interaction & Tone Signals

**Purpose:** Detect user intent that *modifies* how the pipeline should behave, rather than triggering a capability.

**Placement:** Runs in parallel with Fast Lane eligibility check, immediately after normalization.

**Priority:** If an Interaction Signal fires, it takes precedence over Fast Lane.

**Signal types:**

| Group | Signal | Examples |
|-------|--------|---------|
| Interaction | `correction` | "that's not right", "no, I meant…", "you're wrong" |
| Interaction | `negation` | "no", "that's incorrect", "not that one" |
| Interaction | `affirmation` | "yes", "exactly", "that's it", "correct" |
| Interaction | `clarification` | "no I meant Sarah, not John" |
| Tone | `frustration` | "dammit", "why do you keep doing that", "ugh" |
| Tone | `confusion` | "wait I'm confused", "I don't understand" |
| Tone | `urgency` | "quick", "hurry", "right now" |
| Tone | `positive` | "awesome", "perfect", "great job" |

**Behavior by signal:**

| Signal | Effect |
|--------|--------|
| `correction` | Revisit last result; update entity state; rerun if necessary |
| `negation` | Do not execute capability; ask for clarification or retry |
| `affirmation` | Continue confidently; confirm action |
| `frustration` | Soften response tone; optionally explain |
| `confusion` | Increase explanation verbosity |
| `urgency` | Shorten response; prioritize action output |

**Output:**
```json
{
  "interaction_signal": "correction",
  "tone_signal": "frustrated",
  "urgency": "low",
  "confidence": 0.91
}
```

**Implementation:** Start with keyword/phrase rules. No model needed for Phase 1.

```python
NEGATION_PHRASES = ["not right", "wrong", "that's incorrect", "no that's"]
CORRECTION_PHRASES = ["no i meant", "i meant", "not that"]
FRUSTRATION_PHRASES = ["dammit", "why do you", "this is annoying", "wtf"]
CONFUSION_PHRASES = ["i'm confused", "don't understand", "wait what"]
URGENCY_PHRASES = ["quick", "hurry", "right now", "asap"]
```

---

### Step 1: Parse

**Purpose:** Build a complete linguistic representation of the utterance — once.

**Tool:** spaCy (`en_core_web_sm` or `en_core_web_md`)

**Critical rule:** Run spaCy exactly **once per utterance**. The same `doc` object is reused by Split, Extract, and any other step that needs structure.

**Do NOT call `nlp(text)` more than once per request.**

**Data available from `doc`:**
- Tokens and their positions
- Part-of-speech tags (`VERB`, `AUX`, `NOUN`, `ADJ`, etc.)
- Dependency tree (what modifies what)
- Named entities (`doc.ents`)
- Noun chunks (`doc.noun_chunks`)
- Sentence boundaries

```python
import spacy

_nlp = spacy.load("en_core_web_sm")

def parse_text(text: str) -> ParsedInput:
    doc = _nlp(text)
    return ParsedInput(doc=doc)
```

---

### Step 2: Split (Clause Segmentation)

**Purpose:** Determine whether the utterance is a single request, one request with multiple attributes, or multiple distinct requests.

**Tool:** Custom logic operating on the spaCy `doc`. Rules are how you use spaCy output, not a separate tool.

**Key distinction: "and" does not always mean split.**

| Input | Decision | Reason |
|-------|----------|--------|
| `"is that movie rated r and what time is it playing"` | **Split** | Two predicates from different families (rating vs. schedule) |
| `"is that movie scary and gory"` | **Keep together** | Two adjectives in the same predicate family (content/tone) |
| `"turn off the TV and what's the weather"` | **Split** | Device action + weather query — different tools |
| `"is it funny and appropriate for kids"` | **Keep together** | Two descriptive attributes, same evaluation |

**Split rule:**  
Split when the conjoined parts imply **different tools, different data sources, or different predicate families**.  
Keep together when the parts are **coordinated attributes of the same frame**.

**Clause role classification (after split):**

After splitting, classify each clause as:
- `primary_request` — a real actionable request
- `secondary_request` — another actionable request
- `supporting_context` — explanation or motivation (e.g., `"because I don't know if we'll make it"`)

Example:
```
"what time is it because I don't know if we'll make it to the 8pm movie"
  → clause 1: "what time is it"              → primary_request
  → clause 2: "because I don't know..."      → supporting_context
```

Only `primary_request` and `secondary_request` chunks are routed. `supporting_context` is passed to the resolver and Gemma as metadata.

```python
def split_requests(doc) -> list[RequestChunk]:
    text_lower = doc.text.lower()

    if " and " not in text_lower:
        return [RequestChunk(text=doc.text, index=0, role="primary_request")]

    verbs = [t for t in doc if t.pos_ in ("VERB", "AUX")]
    if len(verbs) <= 1:
        return [RequestChunk(text=doc.text, index=0, role="primary_request")]

    # Split and classify predicate families
    parts = [p.strip() for p in doc.text.split(" and ") if p.strip()]
    if predicate_families_differ(parts, doc):
        return [RequestChunk(text=p, index=i, role="primary_request") for i, p in enumerate(parts)]
    else:
        return [RequestChunk(text=doc.text, index=0, role="primary_request")]
```

---

### Step 3: Extract

**Purpose:** Pull meaningful parts from the same spaCy `doc`.

**Tool:** Custom logic on the already-parsed `doc`. No second spaCy call.

**Extracted data:**
- Named entities (`doc.ents`)
- Noun chunks (candidate subjects/objects)
- Pronouns and references (`"it"`, `"that movie"`, `"there"`, `"him"`, `"her"`)
- Predicates (verb subtrees)
- Likely subjects

```python
def extract_chunk_data(doc, chunks: list[RequestChunk]) -> list[RequestChunk]:
    noun_chunks = [c.text for c in doc.noun_chunks]
    entities = [(e.text, e.label_) for e in doc.ents]
    reference_words = ["it", "that", "that movie", "there", "him", "her", "they"]

    for chunk in chunks:
        lower = chunk.text.lower()
        refs = [r for r in reference_words if r in lower]
        chunk.subject_candidates = noun_chunks
        chunk.references = refs
        chunk.entities = entities
    return chunks
```

---

### Step 4: Route (MiniLM)

**Purpose:** Map each request chunk to the most likely abstract capability name using semantic similarity.

**Tool:** MiniLM (`all-MiniLM-L6-v2` via `sentence-transformers`)

**Model characteristics:**
- ~100MB, fast on CPU
- Produces 384-dimensional sentence embeddings
- Compares meaning, not exact phrasing

**How it works:**
1. At startup: embed all capability descriptions + examples for enabled capabilities only
2. At runtime: embed the chunk text, compare via cosine similarity, return best match

**Router sees only:** Enabled capabilities (from precomputed registry). Disabled skill capabilities are never included.

**Output:**
```json
{
  "chunk_index": 1,
  "capability": "get_movie_showtimes",
  "confidence": 0.94
}
```

**Confidence threshold:** If confidence falls below a configurable threshold (e.g., 0.6), flag for Gemma fallback.

```python
from sentence_transformers import SentenceTransformer, util

_model = SentenceTransformer("all-MiniLM-L6-v2")

def route_chunk(chunk: RequestChunk, router_index: list[dict]) -> RouteMatch:
    chunk_vec = _model.encode(chunk.text, convert_to_tensor=True)
    best_score = -1
    best_cap = None

    for item in router_index:
        for text in item["texts"]:
            cap_vec = item["embedding"]
            score = float(util.cos_sim(chunk_vec, cap_vec))
            if score > best_score:
                best_score = score
                best_cap = item["capability"]

    return RouteMatch(
        chunk_index=chunk.index,
        capability=best_cap,
        confidence=best_score
    )
```

---

### Step 5: Select Implementation (Registry)

**Purpose:** Map the abstract capability name to the highest-priority enabled skill handler.

**Tool:** In-memory capability registry (precomputed at startup).

**Capability vs. Handler distinction:**

| Term | Meaning | Example |
|------|---------|---------|
| Capability | Abstract action | `get_movie_showtimes` |
| Handler | Concrete implementation | `movies_fandango.handle_get_movie_showtimes` |

**Priority selection:**
```python
def choose_handler(capability_name: str, runtime: CapabilityRuntime) -> dict | None:
    return runtime.get_preferred_handler(capability_name)
```

Multiple skills can implement the same capability. The highest-priority enabled one always wins.

---

### Step 6: Resolve

**Purpose:** Map extracted references and partial entities to real records.

**Tool:** Custom resolver code + local data sources.

**Data sources:**
- Conversation context (last mentioned movie, last person, etc.)
- Current UI/screen state (what's visible, what's selected)
- People DB (family graph, contacts)
- Home Assistant entity registry
- Skill-specific registries (movie cache, calendar, etc.)

**Reference types to resolve:**
- Pronouns: `"it"`, `"that"`, `"they"`, `"him"`, `"her"`
- Definite references: `"that movie"`, `"the fan"`, `"the living room"`
- Name references: `"Sarah"`, `"mom"`, `"my sister"`

**Ranking signals (when ambiguous):**
1. Exact match
2. Alias match (`"mom"` → Sarah)
3. Relationship priority (family > coworker)
4. Recency (most recently mentioned)
5. Domain relevance (movie context → movie entity)
6. Current screen state

**Ambiguity handling:**
- If one clear match → use it
- If multiple matches and rankable → use highest ranked
- If genuinely ambiguous → flag as `unresolved`, pass to Gemma or ask user

```python
def resolve_task(chunk: RequestChunk, route: RouteMatch, context: dict) -> ResolvedTask:
    params = {}
    unresolved = []

    if "that movie" in chunk.references or "it" in chunk.references:
        movie = context.get("current_movie")
        if movie:
            params["movie_id"] = movie["id"]
            params["movie_name"] = movie["name"]
        else:
            unresolved.append("movie_reference")

    # People resolution
    for name in extract_person_mentions(chunk.text):
        person = people_db.resolve(name, context)
        if person:
            params["person"] = person
        else:
            unresolved.append(f"person:{name}")

    return ResolvedTask(
        chunk_index=chunk.index,
        capability=route.capability,
        params=params,
        unresolved=unresolved
    )
```

---

### Step 7: Execute (Parallel)

**Purpose:** Call the chosen skill handler with resolved params.

**Tool:** Async execution via `asyncio.gather()`

**Rule:** Independent tasks execute in parallel. Dependent tasks execute sequentially.

```python
async def execute_task(task: ResolvedTask, handler: callable) -> TaskResult:
    try:
        result = await handler(**task.params)
        return TaskResult(
            capability=task.capability,
            success=True,
            result=result
        )
    except Exception as e:
        return TaskResult(
            capability=task.capability,
            success=False,
            result={},
            error=str(e)
        )
```

---

### Step 8: Build RequestSpec

**Purpose:** Package the understood request + results into a structured object that Gemma (or the combiner) can reliably work with.

**When to build it:** Always build it after execution. Whether to *use* Gemma with it depends on complexity.

**What it contains:**
- Original request text
- Chunks and their roles
- Capability routed for each chunk
- Params resolved for each chunk
- Task results from each chunk
- Supporting context clauses
- Request-level context (location, user, session state)

```json
{
  "original_request": "is that movie rated r and what time is it playing",
  "chunks": [
    {
      "text": "is that movie rated r",
      "role": "primary_request",
      "capability": "get_movie_rating",
      "params": { "movie_id": "movie_123", "movie_name": "Sinners" },
      "result": { "rating": "R" }
    },
    {
      "text": "what time is it playing",
      "role": "primary_request",
      "capability": "get_movie_showtimes",
      "params": { "movie_id": "movie_123", "movie_name": "Sinners" },
      "result": { "showtimes": ["4:10 PM", "7:20 PM", "9:55 PM"] }
    }
  ],
  "supporting_context": [],
  "context": {
    "zip": "06461",
    "current_movie": "Sinners"
  }
}
```

---

### Step 9: Combine or Reason (Gemma)

**Purpose:** Merge results into one coherent response.

**Two paths:**

**Path A — Fast Combine (no Gemma):**  
Use when: single capability, clean result, no ambiguity, deterministic output sufficient.

```python
def fast_combine(spec: RequestSpec) -> ResponseObject:
    parts = []
    for chunk in spec.chunks:
        if chunk.capability == "get_movie_rating":
            parts.append(f"It's rated {chunk.result['rating']}.")
        elif chunk.capability == "get_movie_showtimes":
            times = ", ".join(chunk.result["showtimes"])
            parts.append(f"It's playing at {times}.")
    return ResponseObject(text=" ".join(parts))
```

**Path B — Gemma (reasoning/synthesis):**  
Use when:
- Multiple results need natural language merging
- Ambiguity remains after resolution
- Explanation or conversational tone is needed
- Confidence scores are low
- Supporting context should influence the response

Gemma receives the full `RequestSpec` as structured JSON, not raw text. This prevents hallucination of intent or entities.

```python
def needs_gemma(spec: RequestSpec) -> bool:
    if len(spec.chunks) > 1:
        return True
    if any(c.unresolved for c in spec.chunks):
        return True
    if any(c.confidence < CONFIDENCE_THRESHOLD for c in spec.chunks):
        return True
    return False
```

---

### Step 10: Deliver

**Purpose:** Render the response for the appropriate modality.

**Outputs:**
- `text` — chat / display
- `tts_text` — voice-optimized (shorter, no markdown)
- `cards` — optional rich UI components
- `status_update` — real-time pipeline status (dev tools / screen)

---

### Step 11: Observe

**Purpose:** Full trace of every request through every step, with timing, at negligible cost.

See [Section 13: Observability](#13-observability) for full implementation.

---

## 7. Capability Types: Core vs. Skill

The system has **two tiers** of capabilities. They share the same interface but have different origins and availability guarantees.

### Core Capabilities (System Layer)

Always available. Cannot be disabled. No external API. Deterministic.

| Capability | Description |
|-----------|-------------|
| `get_current_time` | Returns the current local time (with timezone support) |
| `get_current_date` | Returns today's date |
| `calculate_math` | Evaluates arithmetic expressions |
| `convert_units` | Unit conversion (temperature, length, weight, etc.) |
| `spell_word` | Returns correct spelling |
| `greeting_response` | Responds to greetings |
| `acknowledgment_response` | Responds to thanks/affirmations |

**Location:** `v2/orchestrator/core/capabilities/`

**Priority:** Core capabilities are implicitly highest priority. If a core capability and a skill capability both implement the same action, the core wins.

### Skill Capabilities (Plugin Layer)

Drop-in single-file skills. Can be enabled/disabled per user or environment. May call external APIs.

| Example Skill | Capabilities |
|--------------|-------------|
| `movies_fandango.py` | `get_movie_showtimes`, `get_movie_rating`, `search_movies` |
| `movies_tmdb.py` | `get_movie_rating`, `search_movies` (fallback) |
| `weather.py` | `get_weather_forecast`, `get_current_conditions` |
| `home_assistant.py` | `control_device`, `get_device_state`, `list_devices` |

**Location:** `v2/skills/`

### Combined Registry at Runtime

```python
all_capabilities = [
    *load_core_capabilities(),       # always included
    *load_enabled_skill_capabilities(settings, context)  # filtered by enabled state
]
```

The router sees one unified list. It does not know or care whether a capability comes from core or skill.

---

## 8. Runtime Capability Registry

The registry must be **precomputed at startup** and **cached in memory**. It is rebuilt only on config/skill changes — never per request.

### What Is Precomputed

**1. Enabled Skills Map**
```python
enabled_skills: dict[str, ModuleType]
# { "movies_fandango": <module>, "weather": <module> }
```

**2. Flat Capability List**
```python
capabilities: list[dict]
# [
#   {
#     "capability": "get_movie_showtimes",
#     "skill_id": "movies_fandango",
#     "description": "Get local showtimes for a movie",
#     "examples": [...],
#     "priority": 100,
#     "handler": <callable>
#   },
#   ...
# ]
```

**3. Capability → Implementations Map** (all enabled, sorted by priority)
```python
capability_map: dict[str, list[dict]]
# {
#   "get_movie_showtimes": [
#     {"skill_id": "movies_fandango", "priority": 100, "handler": ...},
#     {"skill_id": "movies_tmdb",     "priority": 50,  "handler": ...},
#   ]
# }
```

**4. Preferred Handler Map** (pre-resolved winner)
```python
preferred_handler_map: dict[str, dict]
# {
#   "get_movie_showtimes": {"skill_id": "movies_fandango", "handler": ...}
# }
```

**5. Router Index** (embeddings for MiniLM, enabled capabilities only)
```python
router_index: list[dict]
# [
#   {
#     "capability": "get_movie_showtimes",
#     "texts": ["Get local showtimes...", "what time is it playing", ...],
#     "embedding": <tensor>
#   }
# ]
```

### CapabilityRuntime Class

```python
class CapabilityRuntime:
    def __init__(self):
        self.enabled_skills: dict = {}
        self.capabilities: list = []
        self.capability_map: dict = {}
        self.preferred_handler_map: dict = {}
        self.router_index: list = []
        self.version: int = 0

    def rebuild(self, settings, context):
        # load + filter + embed
        self.version += 1

    def get_preferred_handler(self, capability_name: str) -> dict | None:
        return self.preferred_handler_map.get(capability_name)

    def get_all_handlers(self, capability_name: str) -> list[dict]:
        return self.capability_map.get(capability_name, [])
```

### Build Lifecycle

| Trigger | Action |
|---------|--------|
| App startup | `runtime.rebuild(settings, context)` |
| Skill enabled/disabled | `runtime.rebuild(settings, context)` |
| Skill file changed (dev mode) | `runtime.rebuild(settings, context)` |
| Settings saved | `runtime.rebuild(settings, context)` |
| Per request | **Never rebuild** — read from cache only |

### Performance Characteristics

| Stage | Cost |
|-------|------|
| Startup rebuild | skill loading + embedding (one-time) |
| Handler lookup per request | O(1) dict access |
| Router match per chunk | embed chunk + cosine similarity |
| DB/API execution | varies per skill |

---

## 9. Skill Contract (Drop-In Single File)

Every skill is a single `.py` file dropped into `v2/skills/`. No registration step required — the loader discovers it automatically.

### Required Exports

```python
# v2/skills/movies_fandango.py

SKILL_ID = "movies_fandango"
SKILL_NAME = "Fandango Movies"
SKILL_PRIORITY = 100

def is_enabled(settings: dict, context: dict) -> bool:
    return settings.get("skills", {}).get("movies_fandango", False)

def get_capabilities() -> list[dict]:
    return [
        {
            "name": "get_movie_showtimes",
            "description": "Get local showtimes for a movie at nearby theaters",
            "examples": [
                "what time is it playing",
                "when is this movie showing",
                "movie times near me",
            ],
            "priority": 100,
            "handler": handle_get_movie_showtimes,
        },
        {
            "name": "get_movie_rating",
            "description": "Get the MPAA rating of a movie such as G, PG, PG-13, or R",
            "examples": [
                "is it rated r",
                "what is the movie rating",
                "is this appropriate for kids",
            ],
            "priority": 100,
            "handler": handle_get_movie_rating,
        },
    ]

async def handle_get_movie_showtimes(movie_id: str, movie_name: str, zip: str = None, **kwargs) -> dict:
    # ... call Fandango API ...
    return {"showtimes": ["4:10 PM", "7:20 PM", "9:55 PM"]}

async def handle_get_movie_rating(movie_id: str, movie_name: str, **kwargs) -> dict:
    # ... call API or cache ...
    return {"rating": "R"}
```

### Skill Loader

```python
# v2/orchestrator/registry/loader.py

from pathlib import Path
import importlib.util

def load_skill_module(path: Path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def load_enabled_capabilities(skills_dir: Path, settings: dict, context: dict) -> list[dict]:
    capabilities = []

    for path in sorted(skills_dir.glob("*.py")):
        if path.name.startswith("_"):
            continue

        module = load_skill_module(path)

        if not (hasattr(module, "is_enabled") and hasattr(module, "get_capabilities")):
            continue

        if not module.is_enabled(settings, context):
            continue

        skill_id = getattr(module, "SKILL_ID", path.stem)
        skill_priority = getattr(module, "SKILL_PRIORITY", 0)

        for cap in module.get_capabilities():
            capabilities.append({
                "skill_id": skill_id,
                "capability": cap["name"],
                "description": cap["description"],
                "examples": cap.get("examples", []),
                "priority": cap.get("priority", skill_priority),
                "handler": cap["handler"],
            })

    return capabilities
```

---

## 10. Parallelization Strategy

### Sequential Stages (must be ordered)

- Normalize
- Parse (spaCy)
- Split
- Extract
- Build RequestSpec
- Combine / Reason
- Deliver

### Parallel Stages (independent per chunk)

- Route each chunk (MiniLM)
- Select implementation per chunk
- Resolve each chunk
- Execute each chunk

### Implementation Pattern

```python
import asyncio

async def handle_request(raw_text: str, context: dict, runtime: CapabilityRuntime) -> ResponseObject:
    # Sequential
    normalized = normalize_text(raw_text)
    parsed = parse_text(normalized.cleaned_text)
    chunks = split_requests(parsed.doc)
    chunks = extract_chunk_data(parsed.doc, chunks)

    # Parallel: route
    routes = await asyncio.gather(*[
        route_chunk_async(chunk, runtime.router_index)
        for chunk in chunks
    ])

    # Parallel: select + resolve
    resolved = await asyncio.gather(*[
        resolve_task_async(chunk, route, context)
        for chunk, route in zip(chunks, routes)
    ])

    # Parallel: execute
    results = await asyncio.gather(*[
        execute_task_async(task, runtime)
        for task in resolved
    ])

    # Sequential
    spec = build_request_spec(chunks, routes, resolved, results, context)
    response = fast_combine(spec) if not needs_gemma(spec) else await gemma_reason(spec)
    return build_delivery_response(response)
```

### Wrapping Blocking Functions

```python
async def route_chunk_async(chunk: RequestChunk, router_index: list) -> RouteMatch:
    return await asyncio.to_thread(route_chunk_sync, chunk, router_index)
```

### Dependency Rule

Only parallelize when tasks are **independent**. If one task needs another's output, keep it sequential.

Example of dependent tasks (must be sequential):
```
"text Sarah that the movie starts at 7"
  → must resolve Sarah BEFORE sending the text
```

---

## 11. RequestSpec

RequestSpec is the structured snapshot of the entire request lifecycle, built after execution and before combination/reasoning.

**Purpose:** Give the combiner (or Gemma) a reliable, structured package — not raw text — so reasoning is accurate and grounded.

**Always build it.** Whether to send it to Gemma is separate logic.

```python
@dataclass
class RequestSpec:
    trace_id: str
    original_request: str
    chunks: list[RequestChunkResult]
    supporting_context: list[str]
    context: dict
    runtime_version: int
```

```python
@dataclass
class RequestChunkResult:
    text: str
    role: str                   # primary_request | secondary_request | supporting_context
    capability: str
    confidence: float
    params: dict
    result: dict
    success: bool
    error: str | None = None
    unresolved: list[str] = field(default_factory=list)
```

**Gemma trigger conditions:**
```python
def needs_gemma(spec: RequestSpec) -> bool:
    if len([c for c in spec.chunks if c.role == "primary_request"]) > 1:
        return True
    if any(c.unresolved for c in spec.chunks):
        return True
    if any(c.confidence < CONFIDENCE_THRESHOLD for c in spec.chunks):
        return True
    if any(c.role == "supporting_context" for c in spec.chunks):
        return True
    return False
```

---

## 12. Data Models

```python
from dataclasses import dataclass, field
from typing import Any

@dataclass
class NormalizedInput:
    raw_text: str
    cleaned_text: str

@dataclass
class ParsedInput:
    doc: Any  # spaCy Doc

@dataclass
class RequestChunk:
    text: str
    index: int
    role: str = "primary_request"
    subject_candidates: list[str] = field(default_factory=list)
    predicates: list[str] = field(default_factory=list)
    references: list[str] = field(default_factory=list)
    entities: list[tuple] = field(default_factory=list)

@dataclass
class RouteMatch:
    chunk_index: int
    capability: str
    confidence: float
    metadata: dict = field(default_factory=dict)

@dataclass
class ResolvedTask:
    chunk_index: int
    capability: str
    params: dict
    unresolved: list[str] = field(default_factory=list)

@dataclass
class TaskResult:
    capability: str
    success: bool
    result: dict
    error: str | None = None

@dataclass
class ResponseObject:
    text: str
    tts_text: str | None = None
    cards: list[dict] = field(default_factory=list)

@dataclass
class InteractionSignal:
    interaction_signal: str   # correction | negation | affirmation | clarification | none
    tone_signal: str          # frustration | confusion | urgency | positive | none
    confidence: float
```

---

## 13. Observability

Every request gets a `trace_id`. Every step logs its duration. Total overhead is negligible.

### Design

- `time.perf_counter()` for sub-millisecond accuracy
- Structured dict logs (not plain text)
- Trace ID per request
- Step name, duration, key outputs
- Runtime version stamp
- Streaming-friendly (can push to terminal, UI, websocket)

### Implementation

```python
# v2/orchestrator/observability/tracing.py

from contextlib import contextmanager
from time import perf_counter
import uuid
import logging

log = logging.getLogger("v2.orchestrator.trace")

def start_trace(raw_text: str) -> dict:
    return {
        "trace_id": str(uuid.uuid4()),
        "raw_text": raw_text[:100],  # truncate for privacy
    }

@contextmanager
def timed_step(trace: dict, step: str, extra: dict = None):
    start = perf_counter()
    try:
        yield
    finally:
        duration_ms = round((perf_counter() - start) * 1000, 2)
        event = {
            "trace_id": trace["trace_id"],
            "step": step,
            "duration_ms": duration_ms,
        }
        if extra:
            event.update(extra)
        log.info(event)
```

### Example Usage

```python
trace = start_trace(raw_text)

with timed_step(trace, "normalize"):
    normalized = normalize_text(raw_text)

with timed_step(trace, "parse"):
    parsed = parse_text(normalized.cleaned_text)

with timed_step(trace, "split", extra={"chunk_count": len(chunks)}):
    chunks = split_requests(parsed.doc)
```

### Example Trace Output

```json
{ "trace_id": "abc123", "step": "normalize",    "duration_ms": 0.12 }
{ "trace_id": "abc123", "step": "parse",         "duration_ms": 11.4 }
{ "trace_id": "abc123", "step": "split",         "duration_ms": 0.8,  "chunk_count": 2 }
{ "trace_id": "abc123", "step": "route",         "duration_ms": 3.2,  "capability": "get_movie_showtimes" }
{ "trace_id": "abc123", "step": "resolve",       "duration_ms": 1.1,  "movie": "Sinners" }
{ "trace_id": "abc123", "step": "execute",       "duration_ms": 142,  "success": true }
{ "trace_id": "abc123", "step": "combine",       "duration_ms": 0.5 }
{ "trace_id": "abc123", "step": "total",         "duration_ms": 161,  "chunks": 2 }
```

### Optional: Rich Terminal Output (dev mode)

```python
from rich.console import Console
console = Console()
console.log(f"[cyan]route[/cyan] → get_movie_showtimes  [green]3.2ms[/green]")
```

---

## 14. Interaction & Tone Signals Layer

See [Section 6, Parallel: Interaction & Tone Signals](#parallel-interaction--tone-signals) for full specification.

**Summary table:**

| Signal | Type | Examples | Pipeline Effect |
|--------|------|---------|----------------|
| `correction` | interaction | "that's wrong", "no I meant…" | Override last result; re-resolve |
| `negation` | interaction | "no", "not that" | Block execution; ask for clarification |
| `affirmation` | interaction | "yes", "exactly" | Confirm and continue |
| `clarification` | interaction | "I meant Sarah not John" | Update entity context; rerun resolver |
| `frustration` | tone | "dammit", "ugh" | Soften response tone |
| `confusion` | tone | "I'm confused", "wait what" | Increase verbosity |
| `urgency` | tone | "quick", "hurry" | Shorten response |
| `positive` | tone | "awesome", "perfect" | Affirm; casual tone |

---

## 15. Phased Implementation Plan

### Phase 1 — Minimal Working Pipeline

**Goal:** End-to-end request handling with deterministic logic only.

**Status:** ✅ **Done**

**Done:**
- Isolated `v2/` prototype runner exposed only through Dev Tools
- Normalize, signals, mature fast lane (greetings / ack / time / date / spell / math) with normalized-lemma + fuzzy template matching
- spaCy single-call parser feeding split / extract (one `Doc` per utterance, reused everywhere)
- Doc-aware splitter with subordinate-clause peel (`because`/`if`/`since`) and predicate-family keep-together (`scary and gory`)
- Doc-aware extractor pulling pronouns (POS=PRON), definite noun phrases (determiner-led noun chunks), entities, and predicates from spaCy
- Centralized English linguistic constants in [`v2/orchestrator/linguistics/english.py`](../v2/orchestrator/linguistics/english.py) (no scattered keyword lists)
- Full structured trace with per-step status, per-chunk timing, and Dev Tools UI surfacing

**Not done:** *(none — this phase is closed)*

**Build:**
- `normalizer.py`
- `parser.py` (spaCy, single parse)
- `splitter.py` (basic split heuristics)
- `extractor.py`
- `router.py` (hardcoded string rules — no MiniLM yet)
- `resolver.py` (current context only)
- `executor.py` (stub skill calls)
- `observability/` (logging + timing)
- `pipeline.py` (wires it together)

**Success criteria:**
- Handles single requests end-to-end
- Handles obvious compound requests
- Handles `"that movie"` reference from context
- Logs full trace to terminal

---

### Phase 2 — Semantic Routing (MiniLM)

**Goal:** Replace brittle string routing with semantic similarity.

**Status:** ✅ **Done**

**Done:**
- Registry-backed routing runtime
- Static capability registry in `v2/data/function_registry.json`
- MiniLM embeddings via `fastembed` (`sentence-transformers/all-MiniLM-L6-v2`)
- Hash-based fallback embedding backend when `fastembed` is missing
- Startup embedding/index build cached in `CapabilityRuntime`
- Confidence scores + matched registry text + handler selection visible in trace and Dev Tools

**Not done:**
- Validate hardware-specific fallback behavior on `pi_cpu` and `pi_hailo` profiles

**Build:**
- `registry/loader.py`
- `registry/builder.py`
- `registry/runtime.py`
- `router.py` (MiniLM-based, replaces stubs)
- `data/function_registry.json`

**Success criteria:**
- Routes correctly using natural language variants
- New phrasings work without code changes
- Confidence scores surface in trace

---

### Phase 3 — Real Resolver

**Goal:** Resolve people, devices, movies, and pronouns using local data.

**Status:** 🟡 **Done against in-memory adapters; real backends still to wire**

**Done:**
- `adapters/people_db.py`, `adapters/home_assistant.py`, `adapters/movie_context.py`, `adapters/conversation_memory.py` (in-memory stubs with real-backend seams)
- `resolution/people_resolver.py`, `resolution/media_resolver.py`, `resolution/device_resolver.py`, `resolution/pronoun_resolver.py`
- People resolver: alias + family-priority ranking; ambiguous mentions surface as `person_ambiguous`
- Device resolver: substring + fuzzy match against the Home Assistant entity registry; ambiguous → `device_ambiguous`
- Pronoun resolver: skipped for direct utilities (`get_current_time`, etc.) so the dummy "it" in "what time is it" is not bound; bound for real referents from conversation memory
- Media resolver: recent / missing / ambiguous movie context flagged in `RequestSpec.unresolved`
- Definite-reference detection (`the X`, `that X`) is structural — driven by spaCy noun chunks + the `DETERMINERS` linguistic constant, not a literal phrase list

**Not done:**
- Replace stub adapters with real PeopleDB / Home Assistant clients
- Per-resolver latency budgets

**Build:**
- `resolution/people_resolver.py`
- `resolution/media_resolver.py`
- `resolution/device_resolver.py`
- `adapters/people_db.py`
- `adapters/home_assistant.py`
- `adapters/movie_context.py`
- `adapters/conversation_memory.py`

**Success criteria:**
- `"Sarah"` resolves correctly in common family scenarios
- `"that movie"` resolves from current state
- `"it"` resolves from most recent entity in context
- Ambiguous cases are flagged, not silently guessed

---

### Phase 4 — Parallel Execution

**Goal:** Reduce latency for compound requests.

**Status:** 🟡 **Mostly done — benchmarking remaining**

**Done:**
- Pipeline converted to `async`
- `asyncio.gather()` used for route / select implementation / resolve / execute (parallel per chunk)
- `asyncio.to_thread()` wrappers offloading routing, resolving, and synchronous handlers
- Per-step and per-chunk timing visible in trace and Dev Tools

**Not done:**
- Sequential-vs-parallel latency benchmark once real adapters are connected
- Streaming-friendly trace push (the trace is built in memory; not yet streamed to UI/websocket per spec §13)

**Build:**
- Convert pipeline to `async`
- `asyncio.gather()` for route / resolve / execute
- `asyncio.to_thread()` wrappers for blocking libs

**Success criteria:**
- Compound requests measurably faster than sequential
- Trace logs show per-step timing

---

### Phase 5 — Gemma Fallback

**Goal:** Use Gemma only for hard cases.

**Status:** 🟡 **Decision logic + stub synthesizer shipped; real Gemma client not wired**

**Done:**
- `fallbacks/gemma_fallback.py` with `decide_gemma()` (unresolved / failed / low-confidence / supporting-context triggers)
- `build_gemma_payload()` serializing the structured `RequestSpec` for downstream prompting
- `gemma_synthesize()` deterministic stub covering unresolved-media, ambiguous-media, ambiguous-person, ambiguous-device, and supporting-context paths
- `RequestSpec.gemma_used` + `RequestSpec.gemma_reason` flags surfaced in trace and Dev Tools (`combine` step's `mode` detail)

**Not done:**
- Set `CONFIG.gemma_enabled = True` and wire a real Ollama Gemma client in `_call_real_gemma()`
- Author split / resolve / combine prompt templates
- Confidence-threshold tuning against a real prompt corpus

**Success criteria:**
- Deterministic path handles ≥80% of real requests
- Gemma activates correctly for complex/ambiguous cases
- `gemma_used: true/false` visible in trace

---

### Phase 6 — Production Hardening

**Goal:** Stable, observable, testable system.

**Status:** 🟡 **Core hardening shipped; broader regression coverage still to come**

**Done:**
- `execution/executor.py` per-handler timeout + retry budget (configurable via `core/config.CONFIG`)
- `execution/errors.py` with `HandlerError`, `HandlerTimeout`, `TransientHandlerError`
- Failures captured on `ExecutionResult.success` / `error` / `attempts` (no exceptions reach the pipeline)
- 80+ v2 unit + integration tests covering adapters, resolvers, fast lane, splitter/extractor, Gemma fallback, executor resilience, linguistics constants, and the dev API

**Not done:**
- Broader regression prompt fixtures (multi-turn flows, edge utterances)
- End-to-end production validation against real PeopleDB / Home Assistant / Gemma backends
- Rich terminal trace renderer (Rich/CLI dev mode)

---

## 16. Folder & File Structure

```
v2/
├── README.md
├── pyproject.toml
├── requirements.txt
│
├── data/
│   ├── function_registry.json        # capability descriptions + examples
│   └── aliases.json                  # name/phrase aliases for resolver
│
├── tests/
│   ├── unit/
│   │   ├── test_normalizer.py
│   │   ├── test_splitter.py
│   │   ├── test_extractor.py
│   │   ├── test_router.py
│   │   └── test_resolver.py
│   ├── integration/
│   │   ├── test_pipeline_single.py
│   │   ├── test_pipeline_compound.py
│   │   └── test_pipeline_references.py
│   └── fixtures/
│       └── prompts.json              # regression prompt suite
│
├── skills/                           # drop-in single-file skills
│   ├── movies_fandango.py
│   ├── movies_tmdb.py
│   ├── weather.py
│   └── home_assistant.py
│
└── orchestrator/
    ├── __init__.py
    │
    ├── core/
    │   ├── __init__.py
    │   ├── pipeline.py               # top-level orchestrator
    │   ├── types.py                  # all dataclasses / typed models
    │   ├── config.py                 # settings, thresholds, flags
    │   └── capabilities/             # core (always-on) capabilities
    │       ├── __init__.py
    │       ├── math.py
    │       ├── datetime_utils.py
    │       ├── units.py
    │       └── language.py
    │
    ├── pipeline/
    │   ├── __init__.py
    │   ├── fast_lane.py              # fast lane eligibility + direct utility handlers
    │   ├── normalizer.py
    │   ├── parser.py                 # spaCy load + single parse
    │   ├── splitter.py               # clause segmentation
    │   ├── extractor.py              # entity / ref / predicate extraction
    │   ├── combiner.py               # fast_combine logic
    │   └── delivery.py               # format for text / TTS / UI
    │
    ├── signals/
    │   ├── __init__.py
    │   └── interaction_signals.py    # tone + correction + frustration detection
    │
    ├── routing/
    │   ├── __init__.py
    │   ├── router.py                 # MiniLM-based semantic routing
    │   └── similarity.py             # cosine similarity helpers
    │
    ├── registry/
    │   ├── __init__.py
    │   ├── loader.py                 # discovers + imports skill files
    │   ├── builder.py                # builds capability maps + router index
    │   ├── runtime.py                # CapabilityRuntime (in-memory cache)
    │   └── priority.py               # handler selection / ranking
    │
    ├── resolution/
    │   ├── __init__.py
    │   ├── resolver.py               # main resolver orchestrator
    │   ├── people_resolver.py
    │   ├── media_resolver.py
    │   └── device_resolver.py
    │
    ├── execution/
    │   ├── __init__.py
    │   ├── executor.py               # calls skill handlers
    │   └── request_spec.py           # builds RequestSpec
    │
    ├── fallbacks/
    │   ├── __init__.py
    │   └── gemma_fallback.py         # Gemma integration + prompt templates
    │
    ├── adapters/
    │   ├── __init__.py
    │   ├── people_db.py
    │   ├── movie_context.py
    │   ├── home_assistant.py
    │   └── conversation_memory.py
    │
    └── observability/
        ├── __init__.py
        ├── logger.py
        ├── timing.py
        └── tracing.py
```

---

## 17. Pseudocode — Full Pipeline

```python
async def handle_request(raw_text: str, context: dict, runtime: CapabilityRuntime) -> ResponseObject:
    trace = start_trace(raw_text)

    # Step 0: Normalize
    with timed_step(trace, "normalize"):
        normalized = normalize_text(raw_text)

    # Parallel: Fast Lane check + Interaction Signals
    fast_lane_result, signal = await asyncio.gather(
        check_fast_lane_async(normalized.cleaned_text),
        check_interaction_signals_async(normalized.cleaned_text)
    )

    # Interaction signals override fast lane
    if signal.interaction_signal not in ("none", None):
        with timed_step(trace, "signal_handler"):
            return await handle_signal(signal, context)

    if fast_lane_result.matched:
        with timed_step(trace, "fast_lane"):
            return await fast_lane_result.handler()

    # Step 1: Parse
    with timed_step(trace, "parse"):
        parsed = parse_text(normalized.cleaned_text)

    # Step 2: Split
    with timed_step(trace, "split"):
        chunks = split_requests(parsed.doc)

    # Step 3: Extract
    with timed_step(trace, "extract"):
        chunks = extract_chunk_data(parsed.doc, chunks)

    # Step 4: Route (parallel per chunk)
    with timed_step(trace, "route", {"chunk_count": len(chunks)}):
        routes = await asyncio.gather(*[
            route_chunk_async(chunk, runtime.router_index)
            for chunk in chunks
        ])

    # Step 5: Select + Resolve (parallel per chunk)
    with timed_step(trace, "resolve"):
        resolved = await asyncio.gather(*[
            resolve_task_async(chunk, route, context, runtime)
            for chunk, route in zip(chunks, routes)
        ])

    # Step 6: Execute (parallel per chunk)
    with timed_step(trace, "execute"):
        results = await asyncio.gather(*[
            execute_task_async(task, runtime)
            for task in resolved
        ])

    # Step 7: Build RequestSpec
    with timed_step(trace, "build_spec"):
        spec = build_request_spec(chunks, routes, resolved, results, context, runtime.version)

    # Step 8: Combine or Reason
    if needs_gemma(spec):
        with timed_step(trace, "gemma"):
            response = await gemma_reason(spec)
    else:
        with timed_step(trace, "combine"):
            response = fast_combine(spec)

    # Step 9: Deliver
    with timed_step(trace, "deliver"):
        final = build_delivery_response(response, signal.tone_signal)

    end_trace(trace)
    return final
```

---

## 18. Pseudocode — Per Module

### `pipeline/normalizer.py`

```python
import re, unicodedata

def normalize_text(raw_text: str) -> NormalizedInput:
    cleaned = unicodedata.normalize("NFKC", raw_text)
    cleaned = cleaned.replace("\u201c", '"').replace("\u201d", '"')
    cleaned = cleaned.replace("\u2018", "'").replace("\u2019", "'")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return NormalizedInput(raw_text=raw_text, cleaned_text=cleaned)
```

### `pipeline/parser.py`

```python
import spacy
_nlp = spacy.load("en_core_web_sm")

def parse_text(text: str) -> ParsedInput:
    doc = _nlp(text)
    return ParsedInput(doc=doc)
```

### `pipeline/splitter.py`

```python
def split_requests(doc) -> list[RequestChunk]:
    text_lower = doc.text.lower()
    if " and " not in text_lower:
        return [RequestChunk(text=doc.text, index=0, role="primary_request")]

    verbs = [t for t in doc if t.pos_ in ("VERB", "AUX")]
    if len(verbs) <= 1:
        return [RequestChunk(text=doc.text, index=0, role="primary_request")]

    parts = [p.strip() for p in doc.text.split(" and ") if p.strip()]

    # Classify: same predicate family → keep together
    if not predicate_families_differ(parts):
        return [RequestChunk(text=doc.text, index=0, role="primary_request")]

    return [RequestChunk(text=p, index=i, role="primary_request") for i, p in enumerate(parts)]
```

### `signals/interaction_signals.py`

```python
NEGATION = ["not right", "wrong", "that's incorrect", "no that's not"]
CORRECTION = ["no i meant", "i meant", "not that one", "I said"]
FRUSTRATION = ["dammit", "why do you", "this is annoying", "wtf", "ugh"]
CONFUSION = ["i'm confused", "don't understand", "wait what", "what do you mean"]
URGENCY = ["quick", "hurry", "right now", "asap", "fast"]

def check_interaction_signals(text: str) -> InteractionSignal:
    lower = text.lower()
    for phrase in CORRECTION:
        if phrase in lower:
            return InteractionSignal(interaction_signal="correction", tone_signal="none", confidence=0.9)
    for phrase in NEGATION:
        if phrase in lower:
            return InteractionSignal(interaction_signal="negation", tone_signal="none", confidence=0.85)
    for phrase in FRUSTRATION:
        if phrase in lower:
            return InteractionSignal(interaction_signal="none", tone_signal="frustration", confidence=0.9)
    for phrase in CONFUSION:
        if phrase in lower:
            return InteractionSignal(interaction_signal="none", tone_signal="confusion", confidence=0.85)
    return InteractionSignal(interaction_signal="none", tone_signal="none", confidence=1.0)
```

### `routing/router.py`

```python
from sentence_transformers import SentenceTransformer, util
_model = SentenceTransformer("all-MiniLM-L6-v2")

def route_chunk_sync(chunk: RequestChunk, router_index: list) -> RouteMatch:
    chunk_vec = _model.encode(chunk.text, convert_to_tensor=True)
    best_score, best_cap = -1, None
    for item in router_index:
        score = float(util.cos_sim(chunk_vec, item["embedding"]))
        if score > best_score:
            best_score, best_cap = score, item["capability"]
    return RouteMatch(chunk_index=chunk.index, capability=best_cap, confidence=best_score)

async def route_chunk_async(chunk, router_index) -> RouteMatch:
    return await asyncio.to_thread(route_chunk_sync, chunk, router_index)
```

### `resolution/resolver.py`

```python
async def resolve_task_async(chunk, route, context, runtime) -> ResolvedTask:
    return await asyncio.to_thread(resolve_task_sync, chunk, route, context, runtime)

def resolve_task_sync(chunk, route, context, runtime) -> ResolvedTask:
    params = {}
    unresolved = []

    # Movie reference
    if any(r in chunk.references for r in ["it", "that movie", "that"]):
        movie = context.get("current_movie")
        if movie:
            params.update({"movie_id": movie["id"], "movie_name": movie["name"]})
        else:
            unresolved.append("movie_reference")

    # Person reference
    for name in extract_person_mentions(chunk.text):
        person = people_db.resolve(name, context)
        if person:
            params["person"] = person
        else:
            unresolved.append(f"person:{name}")

    return ResolvedTask(chunk_index=chunk.index, capability=route.capability, params=params, unresolved=unresolved)
```

### `pipeline/combiner.py`

```python
def fast_combine(spec: RequestSpec) -> ResponseObject:
    parts = []
    for chunk in spec.chunks:
        if not chunk.success:
            parts.append(f"I couldn't complete that ({chunk.capability}).")
            continue
        r = chunk.result
        if chunk.capability == "get_movie_rating":
            parts.append(f"It's rated {r['rating']}.")
        elif chunk.capability == "get_movie_showtimes":
            times = ", ".join(r["showtimes"])
            parts.append(f"It's playing at {times}.")
        elif chunk.capability == "get_current_time":
            parts.append(f"It's currently {r['time']}.")
        elif chunk.capability == "calculate_math":
            parts.append(f"That's {r['result']}.")
        else:
            parts.append(str(r))
    text = " ".join(parts)
    return ResponseObject(text=text, tts_text=text)
```

---

## 19. Function Registry Schema

`v2/data/function_registry.json`

```json
[
  {
    "capability": "get_movie_showtimes",
    "description": "Get local showtimes for a movie at nearby theaters",
    "examples": [
      "what time is it playing",
      "when is this movie showing",
      "movie times near me",
      "what time does the movie start"
    ]
  },
  {
    "capability": "get_movie_rating",
    "description": "Get the MPAA rating of a movie such as G, PG, PG-13, or R",
    "examples": [
      "is it rated r",
      "what is the movie rating",
      "is this movie for kids",
      "what's the age rating"
    ]
  },
  {
    "capability": "get_weather_forecast",
    "description": "Get the weather forecast for a location",
    "examples": [
      "what's the weather",
      "is it going to rain",
      "what's the forecast"
    ]
  },
  {
    "capability": "control_device",
    "description": "Turn on or off a home device or adjust its settings",
    "examples": [
      "turn off the kitchen light",
      "set the thermostat to 72",
      "turn on the living room fan"
    ]
  },
  {
    "capability": "get_current_time",
    "description": "Get the current local time",
    "examples": [
      "what time is it",
      "what's the time"
    ]
  },
  {
    "capability": "calculate_math",
    "description": "Evaluate a mathematical expression",
    "examples": [
      "what is 6 times 4",
      "what's 15 percent of 80",
      "calculate 100 divided by 7"
    ]
  }
]
```

---

## 20. Edge Cases & Examples

### Single request
```
Input:   "what time is it playing"
Fast Lane: ✗ (too long for fast lane — involves skill)
Split:   1 chunk
Route:   get_movie_showtimes (0.95)
Resolve: current_movie → Sinners
Execute: Fandango API
Output:  "It's playing at 4:10 PM, 7:20 PM, and 9:55 PM."
```

### Compound request — different predicate families
```
Input:   "is that movie rated r and what time is it playing"
Split:   2 chunks
  chunk 1: "is that movie rated r"       → get_movie_rating
  chunk 2: "what time is it playing"     → get_movie_showtimes
Resolve: both → Sinners
Execute: both in parallel
Output:  "It's rated R, and it's playing at 4:10 PM and 7:20 PM."
```

### Compound — same predicate family (no split)
```
Input:   "is that movie scary and gory"
Split:   1 chunk (adjectives = same content/tone family)
Route:   get_movie_content_assessment
Output:  "It's fairly scary and also pretty gory."
```

### Fast Lane
```
Input:   "what time is it"
Fast Lane: ✓ — matches get_current_time
Output:  "It's 3:42 PM."
```

### Fast Lane non-match (embedded)
```
Input:   "what time is it because I don't know if we'll make it to the 8pm movie"
Fast Lane: ✗ — contains "because" connector
Split:   clause 1 = primary_request, clause 2 = supporting_context
Route:   clause 1 → get_current_time
Gemma:   interprets supporting context → "It's 6:15 PM — you still have time to make the 8 PM showing."
```

### Correction signal
```
Input:   "that's not right"
Signal:  correction (0.9)
Action:  revisit last result; re-resolve or ask for clarification
Output:  "I'm sorry about that — what should the answer have been?"
```

### Name resolution
```
Input:   "text Sarah"
Extract: "Sarah"
Resolve: People DB → { name: "Sarah", relationship: "mother", id: 123 }
Route:   send_text_message
Execute: compose text to Sarah
Output:  "Texting Sarah now."
```

### Ambiguous name
```
Input:   "text Sarah"
Resolve: People DB → 2 Sarahs found (mother + coworker)
         ranking: family wins → mother
         OR: flag ambiguous → ask user
```

### Math (Core Capability)
```
Input:   "what is 6x4"
Fast Lane: ✓ — matches calculate_math
Route:   → core calculate_math handler (no skill needed)
Output:  "24."
```

---

## 21. Design Guardrails

### Always Do

- Parse with spaCy exactly **once** per utterance
- Route to **abstract capability names**, not directly to skill handlers
- Build the router index from **enabled capabilities only**
- Cache the capability registry at startup; rebuild only on change
- Run route / resolve / execute **in parallel** per chunk
- Log every step with a trace ID and duration
- Surface unresolved references rather than silently guessing

### Never Do

- Call `nlp(text)` more than once per request
- Route directly to skill functions (route to capability, let registry choose)
- Use Gemma for routing
- Run Gemma by default (only on fallback conditions)
- Rebuild the capability registry per request
- Parallelize steps that depend on each other
- Aggressively strip or stem text before parsing
- Add hardcoded skill function names to the router (use semantic matching)

### Gemma Trigger Checklist

Before sending to Gemma, confirm at least one:

- [ ] Multiple primary request chunks after split
- [ ] One or more unresolved references remain
- [ ] Confidence score below threshold on any route match
- [ ] Supporting context clause present that may affect the response
- [ ] Results conflict or need synthesis
- [ ] User correction or clarification signal detected

---

## Appendix — Hardware Notes (LokiDoki Deployment)

| Component | Suggested Hardware | Notes |
|-----------|-------------------|-------|
| Normalize, Parse (spaCy) | Raspberry Pi | Cheap, local, fast |
| Interaction Signals | Raspberry Pi | Rule-based, trivial cost |
| Fast Lane | Raspberry Pi | String match only |
| MiniLM routing | Raspberry Pi or NUC | ~100MB model, fast on CPU |
| Resolver | Raspberry Pi | DB reads, in-memory |
| Gemma | NUC (or cloud fallback) | Heavy model, keep loaded |
| Skill APIs | NUC or direct outbound | Network-dependent |

**Key principle:** Keep Gemma loaded and resident. Never unload/reload between requests. MiniLM runs alongside Gemma — not instead of it — so no model swapping is ever required.

---

*End of LokiDoki Capability-Orchestrated Request Pipeline Design Document*
