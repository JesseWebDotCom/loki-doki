# LokiDoki Design Document

## 1. Project Overview

LokiDoki is a high-performance, private, and local AI conversational assistant designed for the Raspberry Pi 5. It provides a ChatGPT-like experience without paid subscriptions or external cloud processing.

### Key Goals
- **Privacy First**: All data processing remains local to the device.
- **Local Autonomy**: Functions without an active internet connection (using local mechanisms).
- **Agentic Intelligence**: Multi-step reasoning and skill orchestration using local LLMs.
- **Hardware Optimized**: Memory and resident-model policies to minimize latency on Pi 5.
- **Dynamic Adaptability**: Model selection based on query complexity.

---

## 2. Technology Stack
- **Environment**: `uv` (Python dependency management).
- **Backend**: **FastAPI** (Python) for API endpoints and orchestrator logic.
- **Frontend**: **React** (Vite) + **Tailwind CSS** + **shadcn/ui** + **Lucide** icons.
- **Database**: **SQLite** for structured data + **FTS5** for full-text search + optional **sqlite-vec** for embeddings.
- **LLM Engine**: Local execution via **Ollama** (Qwen for chat, Gemma for function-calling).
- **Hardware Target**: Raspberry Pi 5 (also runs on macOS for development).

---

## 3. System Architecture & Entry Points

### `run.sh` / `run.py`
`run.sh` is the user entry point. It performs system checks and executes `run.py`, which:
1. Installs/updates dependencies via `uv`.
2. Starts the FastAPI backend server.
3. Opens the local web interface in the default browser.

### Request Path
```
[STT] -> [Router] -> fast Qwen / thinking Qwen / Gemma function model -> [Tools/APIs] -> [TTS]
```

Full pipeline:
```
input -> normalize -> signals -> parse -> split -> extract -> resolve -> route -> execute -> combine -> response
```

---

## 4. User Interface

### Chat Tab (Primary)
- **History View**: Scrolling chronological list of prompts and responses.
- **Visual Execution Timeline**: Real-time agentic flow showing phases (Augmentation, Decomposition, Routing, Synthesis), model tags, latency per phase, and parallel skill status.

### Admin Tab
Admin-only surface with `require_admin` + password challenge:
- **Users panel**: CRUD, promote/demote, reset PIN.
- **Per-user Memory panel**: People and Facts panels with status filter (Live/Pending/Active/Rejected/Superseded) and lifecycle controls.

### Configuration Tab
- **Parental Controls**: System-level safety prompt.
- **User Customization**: Custom behavior prompt.
- **Audio Settings**: Piper voice selection, read-aloud toggle.

### Memory Tab
Dedicated interface for viewing/curating internal records:
- **Per-fact controls**: Confirm, Edit, Reassign person, Reject, Delete.
- **Per-person controls**: Rename, set relationship, Delete (cascade warning), Merge.
- **Disambiguation callout**: Ambiguous facts surface with candidate picker.
- **ConfidenceBar**: Recency-decayed confidence as Material-purple bar + numeric %.
- **Search**: BM25 across the user's fact corpus.

---

## 5. Intelligence & Orchestration

### I. Input Augmentation
User input is enriched with:
- System constraints (parental controls, bot-style guidelines).
- Recent chat context (short-term memory).
- Relevant long-term memories (facts, people, episodes).
- Intent capability map (available skills).

### II. Decomposition
The pipeline parses input into structured signals using spaCy (parse, split, extract) rather than an LLM. Each chunk gets:
1. **Intent Mapping**: Semantic matching against the capability registry via embedding similarity.
2. **Parameter Extraction**: Typed extraction of `location`, `date`, `movie_title`, etc.
3. **Routing Signals**: `need_preference`, `need_social`, `need_episode`, etc.

### III. Parallel Execution & Routing
Chunks are routed to appropriate skills in parallel:
- **Skills**: Weather, Search, Knowledge (Wikipedia), Showtimes, TV Shows, Calculator, Dictionary, Recipes, News, Unit Conversion, Smart Home, etc.
- **Mechanism Logic**: Prioritized fallback chains with strict timeouts and connectivity awareness.
- **First-Successful-Win**: Multiple mechanisms race; first valid response wins, others cancelled.

### III.b Silent Confirmation & Clarification
- **`silent_confirmation`** SSE event per successful fact write (quiet chip in UI).
- **`clarification_question`** emitted for ambiguous facts (threaded into synthesis prompt).

### IV. Final Synthesis
1. Consolidated prompt from skill results, user intent, and bot style/tone.
2. **Model selection**: Fast Qwen for simple queries, thinking Qwen for complex reasoning.
3. Response streamed to UI as SSE events.

### V. Model Resident & Switching Policy
- **Primary (fast Qwen)**: Stays resident in RAM via Ollama `keep_alive: -1`.
- **Reasoning (thinking Qwen)**: Loaded dynamically when `overall_reasoning_complexity` triggers it. Uses `keep_alive: "5m"`.
- **LLM fallback model**: `qwen3:4b-instruct-2507-q4_K_M` — used when no skill matches or skill returns empty. Override via `LOKI_LLM_MODEL` env var.

### V.a LLM Model Selection (Bake-Off Results)

A 10-model bake-off scored candidates on a 9-prompt curated corpus (Phase 1) then an 84-prompt regression corpus (Phase 2). Hardware: Mac M-series, all models Q4_K_M.

**Phase 1 — Top 5 (9-prompt curated set):**

| Model | Quality | Avg Latency | Issues | Notes |
|-------|---------|-------------|--------|-------|
| `phi4-mini` | 100/100 | 687ms | 0/9 | Phase 1 winner (overturned in Phase 2) |
| `gemma3:4b` | 100/100 | 774ms | 0/9 | Clean but slower |
| `gemma4:e2b` | 98/100 | 518ms | 1/9 | Fastest, minor combine refusal |
| `llama3.1:8b` | 100/100 | 1095ms | 0/9 | Clean but too slow |
| `qwen3:4b` (thinking) | 60/100 | 3689ms | 9/9 | **Disqualified** — leaks reasoning monologue, ignores `think=False` |

**Phase 2 — Final decision (84-prompt regression corpus):**

| Metric | `qwen3:4b-instruct-2507` | `phi4-mini` |
|--------|--------------------------|-------------|
| Quality | **98/100** | 96/100 |
| Issues | **10/84 (12%)** | 23/84 (27%) |
| Avg warm latency | **565ms** | 852ms |
| p95 warm latency | **1059ms** | 1811ms |
| Verbose responses | **0** | 8 |

`phi4-mini` refused 27% of prompts at scale (anything resembling real-time data). `qwen3:4b-instruct` wins on every dimension: faster, fewer refusals, never verbose, same 2.5GB disk footprint.

**Key learnings:**
- Must use the `-instruct-2507` variant. Default `qwen3:4b` is the thinking variant and leaks internal reasoning into output ([ollama/ollama#12917](https://github.com/ollama/ollama/issues/12917)).
- Single-model is the right call for Pi 5 8GB — dual-model leaves ~400MB for OS + Python + frontend.
- Refusals on real-time data prompts are acceptable since those always route to real skills in production; the LLM fallback only fires when skills fail.
- Reproducible via `scripts/bench_llm_models.py` with `--corpus tests/fixtures/regression_prompts.json`.

### VI. Pre-Synthesis Formatter (Caveman Compression)
Token-efficient compression for Pi 5's limited context window:
- Strip non-functional stop-words while preserving negatives, logic words, quantities.
- Strip HTML, citations, redundant metadata from skill output.
- Synthesis LLM outputs natural language from compressed input.

---

## 6. Memory System

The memory system is one SQLite file (`data/lokidoki.db`), one gate-chain writer (`MemoryStore`), and one lazy per-tier reader. The seven tiers described below are policies and views over that shared storage, not separate databases — they model how information flows from volatile per-turn state to durable long-term knowledge, each with distinct write triggers, decay policies, and retrieval strategies.

### 6.1 Tier Descriptions

#### Tier 1 — Working Memory
Per-turn volatile state: the spaCy parse tree, extracted entities, resolved pronouns, in-flight clarification state. Lives entirely in-memory as Python objects on the pipeline context dict. Cleared at the end of every turn. No persistence, no retrieval — downstream pipeline stages read it by direct reference.

#### Tier 2 — Session Memory
The rolling conversation window. Stores the last N messages in the `messages` table and a `session_state` JSON blob on the `sessions` row (last-seen map for entity tracking, unresolved questions, turn counter). Cleared when the session closes. Retrieved via `need_session_context` — the pipeline reads the last few messages to give the synthesis LLM conversational continuity.

#### Tier 3 — Episodic Memory
Compact narrative summaries with timestamps and emotional tone — *"On 2026-04-09, user was excited about planning a Japan trip."* Written by an out-of-band summarization job at session close (triggered when the session had 20+ turns). Stored in the `episodes` table with FTS5 full-text index and optional sqlite-vec embeddings for hybrid retrieval. Decays with a **90-day half-life**; episodes older than 6 months roll into period summaries. Retrieved via `need_episode` (max 2 entries, ranked by BM25 + temporal proximity, subject to a relevance-score floor).

#### Tier 4 — Semantic-Self (User Facts)
Structured `(subject, predicate, value)` triples about the **user and owned entities** — identity, preferences, biographical facts. Examples: *"name: Jesse"*, *"likes: dark roast coffee"*, *"lives_in: Brooklyn"*. Subject must be `self`. Stored in the `facts` table with FTS5 and sqlite-vec embeddings for hybrid RRF (reciprocal rank fusion) retrieval. Decays with a **180-day half-life**; identity-class categories (`identity`, `relationship`, `biographical`) are **exempt from decay** — your name doesn't become less true over time.

Written via the full gate chain (Layer 1-3); promoted from Tier 3 by 3+ observations OR immediately for **immediate-durable predicates** (name, allergy, dietary restriction, accessibility need, privacy boundary, hard dislike). Retrieved via `need_preference` (top-3 RRF results, subject to relevance-score floor).

#### Tier 5 — Social Memory (People & Relationships)
People, relationships, interaction history, importance scores, ambiguity groups, and per-person sentiment. Subject must be another person in the user's life, not the user themselves. Stored across three tables: `people` (name, aliases, handle, provisional flag, owner), `relationships` (person-to-person links with type and direction), and `ambiguity_groups` (for unresolved multi-candidate references).

**Provisional handles**: Unnamed recurring people — *"my boss"*, *"my therapist"* — are tracked with `name=NULL`, a `handle` field (e.g., `"boss"`), and `provisional=true`. When the user later supplies a name (*"my boss Sarah"*), the provisional row is merged into a full person record. Unmerged provisionals after 90 days get a confidence drop; after 180 days they're flagged for review.

People rows themselves **never decay**. Per-fact decay follows Tier 4 rules. Retrieved via `need_social` (graph traversal + FTS5 over name/aliases/handle, subject to relevance-score floor).

#### Tier 6 — Affective Memory (Emotional State)
Sentiment trajectory and ongoing concerns over a rolling 1-2 week window. Per-user, per-turn decomposer emits a sentiment observation (not an assertion — no gating needed). Stored in the `affect_window` table and a `sentiment` column on `messages`.

**Character-overlaid**: This is the **only tier scoped by `character_id`**. The user's mood while chatting with Loki (playful) is distinct from their mood with Kingston (supportive). Tiers 4-5 are character-agnostic — the user is the same person regardless of persona — but emotional context tracks per-persona interactions. Aggregates older than 30 days are dropped. Retrieved always-on at session start, loaded once into the request context.

#### Tier 7a — Procedural: Prompt-Safe Style
Learned user preferences that shape synthesis output: *"prefers brief answers"*, *"likes first-name address"*, *"prefers casual tone"*, *"prefers metric units"*, *"asks about weather around 7am"* (time-shape routines). Stored in `user_profile.style` JSON column and derived from the `behavior_events` log by deterministic aggregation (no LLM). Overwritten nightly or per-N-sessions; raw events older than 30 days are dropped. Injected into the synthesis prompt as `{user_style}` and `{recent_routines}` slots. **Always-on at session start.**

#### Tier 7b — Procedural: Internal Telemetry
UX-only behavioral signals: *"dismisses confirmations"*, *"retries failed voice quickly"*, *"abandons long answers"*. Same storage pattern as 7a (`user_profile.telemetry` JSON + `behavior_events`). Same aggregation schedule. Critical distinction: **7b is NEVER injected into synthesis prompts and NEVER surfaced to the user**. It drives UX-code paths only (e.g., auto-dismissing confirmations for users who always dismiss them).

### 6.2 Write Path — Three Defense Layers

All memory writes pass through three independent layers. Layer 1 is the primary defense; promotion via recurrence is the secondary. Together they prevent the "president bug" (storing public-figure trivia as personal facts).

#### Layer 1 — Structural Gate Chain (Python, deterministic)

Five gates in sequence; any denial blocks the write:

1. **Gate 1 — Clause shape (parse tree)**: Block interrogatives (*"who is...?"*), info-requests, hypotheticals. Allow declaratives (*"I like pizza"*), fragments (*"dark roast coffee"*), self-statements, exclamatives. Hedged statements (*"I think I might..."*) pass but with confidence dropped one tier.

2. **Gate 2 — Subject identity (resolver)**: Subject must be `self` (literal or resolved), a resolved person above the confidence threshold with no ambiguity, or already present in the graph. Deny strangers, public figures, hypotheticals, unresolved pronoun references.

3. **Gate 3 — Predicate validity (closed enum)**: Tier-specific whitelist of allowed predicates. Coerces LLM free-text into the canonical predicate or rejects if no match. This makes dedup and contradiction detection tractable. Examples: `name`, `age`, `lives_in`, `likes`, `has_allergy`, `is_relation`.

4. **Gate 4 — Schema validation (Pydantic)**: Strict validation, no repair loop. Malformed candidates go to the regression corpus for analysis, not into a retry loop.

5. **Gate 5 — Intent context**: Deny on `greeting`, `joke`, `command_without_assertion`, `info_request`, `clarification_request`. Allow on `assertive_chat`, `self_disclosure`, `correction`, `command_with_assertion`, `explicit_remember`.

**Explicit memory commands** (*"remember that..."*, *"don't forget..."*): Intent `explicit_remember` bypasses Gate 1 (clause shape) but still passes Gates 2-4. Writes directly to Tier 4/5 because user intent to store is unambiguous.

#### Layer 2 — Tier Classifier

Picks the destination tier (`session | episodic | social | semantic | emotional | procedural`). Cannot deny — Layer 1 already approved. Can only route.

#### Layer 3 — Promotion via Recurrence

- **Immediate-durable predicates** (bypass promotion, write on first observation): `is_named`, `has_pronoun`, `has_allergy`, `has_dietary_restriction`, `has_accessibility_need`, `has_privacy_boundary`, `hard_dislike` (Tier 4); `is_relation` (Tier 5).
- **Triggered consolidation**: Soft preference repeated 3+ times in a session OR within 24 hours triggers immediate consolidation (same logic as the nightly job). Candidate must still pass all gates.
- **Nightly reflect job**: Claims appearing in 3+ separate session-close summarizations promote from episodic (Tier 3) to semantic/social (Tier 4/5). Behavior patterns across 10+ sessions promote to procedural (Tier 7a). Sentiment trends across 3+ days promote to affective (Tier 6).

### 6.3 Read Path — Lazy, Per-Tier Injection

The decomposer emits boolean `need_*` fields. Each field triggers retrieval from its corresponding tier. Retrieval is lazy — tiers that aren't needed are never queried.

| Signal | Tier | Budget | Threshold |
|--------|------|--------|-----------|
| `need_session_context` | 2 Session | 300 chars | Always injected |
| `need_episode` | 3 Episodic | 400 chars (max 2 entries) | Relevance floor |
| `need_preference` | 4 Semantic-self | 250 chars (top-3 RRF) | Relevance floor |
| `need_social` | 5 Social | 400 chars | Relevance floor |
| `need_emotional_context` | 6 Affective | 120 chars | Always-on at session start |
| `need_routine` | 7a Procedural | 200 chars `{user_style}` + 150 chars `{recent_routines}` | Always-on at session start |

**Relevance floors**: Ranked-retrieval tiers (3, 4, 5) have explicit score thresholds. Results below the floor are not injected even if the `need_*` signal is true. This prevents low-confidence or tangential memories from polluting synthesis.

### 6.4 Confidence Model

Every fact stores `confidence` in `[0.05, 0.99]`, `observation_count`, and `last_observed_at`:

- **Stored confidence**: Long-running exponential moving average (EMA). `update_confidence()` nudges toward 1.0 on each re-observation, toward 0.0 on each contradiction (weight 0.2 normally, 0.35 for explicit revisions).
- **Effective confidence**: Stored value decayed by recency: `effective = stored * 0.5 ^ (age_days / 180)`. Identity-class categories (`identity`, `relationship`, `biographical`) **skip decay entirely** — your brother stays your brother. The API returns both values; the UI renders effective and tooltips raw.

### 6.5 Belief Revision (Contradiction Handling)

A curated `SINGLE_VALUE_PREDICATES` set covers predicates where only one value can be true at a time (`name`, `age`, `birthday`, `lives_in`, `married_to`, ...).

- **Multi-value predicates** (`likes`, `visited`, `owns`): Both rows coexist freely.
- **Single-value predicates**: The loser's confidence is bumped down. Below `0.15` it flips to `status='rejected'` — excluded from retrieval but kept for audit.
- **Explicit negation**: When the decomposer flags `negates_previous=true` (*"no, my brother's name is Art, not Luke"*), every conflicting active row is immediately marked `status='superseded'`.

### 6.6 Person Disambiguation

The `people` table allows multiple people with the same name (brother-Luke, dog-Luke, celebrity Luke Lange). When a fact references a person, the orchestrator scores every name match by:
1. **Relationship hint**: A relation word in front of the name (*"my brother Luke"*) strongly favors the candidate with that relationship row.
2. **Recent co-occurrence**: Facts about the candidate observed earlier in the same session add weight.
3. **Recency tiebreaker**: More recently created people slightly preferred.

If the top candidate's score margin clears the disambiguation threshold, the fact binds directly. Otherwise it's written with `status='ambiguous'` and tied to an `ambiguity_groups` row listing every viable candidate. The Memory UI surfaces these with a "Who is this?" picker.

### 6.7 Fact Lifecycle States

`facts.status` is one of:
- **`active`** — visible everywhere, eligible for retrieval.
- **`ambiguous`** — written but waiting for the user to pick a person.
- **`pending`** — admin staging tier (manual moderation).
- **`rejected`** — soft-deleted; hidden from retrieval, recoverable.
- **`superseded`** — replaced by an explicit belief revision.

---

## 7. Character System

Modular characters (visual, personality, voice, wake word) selectable by users.

### Components
- **Visual Identity (DiceBear)**: Styles `avataaars`, `bottts`, `toon-head`; seed-based reproducibility; basic viseme-synced animation.
- **Voice (Piper TTS)**: Multiple ONNX voices; custom phonetic spelling per voice locale.
- **Personality**: `behavior_prompt` injected **only into synthesis** (not decomposer/pipeline).
- **Wake Word (OpenWakeWord)**: Per-character `.tflite` model assignment.

### Data Model
```
characters: id, name, phonetic_name, description, behavior_prompt,
            avatar_style, avatar_seed, avatar_config (JSON),
            voice_id (FK->voices), wakeword_id (FK->wakewords),
            source (builtin|admin|user)
```

### Builtin Characters
- **Loki** (bottts, green) — friendly, warm, playful default.
- **Kingston** (toon-head) — cartoon companion, soft encouraging tone.
- **Luis** (avataaars) — human-style assistant, plain approachable.

Builtins are idempotent-seeded, editable in place, and reset-to-default capable.

---

## 8. Audio & Speech

### STT (Faster-Whisper)
CPU-bound on Pi 5. Processes audio in chunks for immediate text feedback.

### TTS (Piper)
CPU-only, real-time streaming:
- **Sentence-buffered synthesis**: Tokens collected until sentence end-marker, then sent to Piper.
- **Overlapped audio**: First sentence plays while LLM streams the next.
- **Latency target**: Time-to-Speech under 2.5s.

### Speech Naturalization (planned)
Two-phase processing before Piper synthesis:

**Phase S1 — Text Normalization** (`text_normalizer.py`):
- Numbers: cardinals, ordinals, currency, percentages, phone-style.
- Dates/times: MM/DD/YYYY, ISO, relative, ranges.
- URLs: strip or replace with "link". Email: "user at example dot com".
- Abbreviations: titles, common, units (curated whitelist).
- Symbols: & -> and, % -> percent, @ -> at, # -> number.
- Dependency: `num2words` (pure Python, 163 KB).

**Phase S2 — Prosody Control** (`prosody_planner.py`):
- `SpeechSegment(text, length_scale, post_silence_s)` fed to Piper segment-by-segment.
- Deterministic rules: inter-sentence 0.4s, after questions 0.6s, new topic 0.7s.
- `length_scale` range: 0.85-1.15.

---

## 9. Skills Architecture

### Registry Model (Three Layers)

1. **Capability Registry**: User-facing routing contract. One entry per capability (`get_weather`, `tell_joke`). Owns: name, aliases, description, routing examples, parameter schema, `max_chunk_budget_ms`.

2. **Skill Registry**: Discovered standalone skills via `manifest.json`. One entry per provider (`weather_openmeteo`, `jokes`). Owns: `skill_id`, mechanisms, `requires_internet`, `config_schema`.

3. **Runtime Registry**: Executable subset for current profile/user. Built from capability + skill registries + enable/disable state + platform availability.

### Skill Contracts

Every skill follows the common `BaseSkill` execution interface and returns normalized `AdapterResult`:
- `output_text`, `success`, `error_kind`, `mechanism_used`, `data`, `sources`
- `error_kind` taxonomy: `invalid_params`, `no_data`, `offline`, `provider_down`, `rate_limited`, `timeout`, `internal_error`

### Domain Contracts (Capability Families)

Skills only satisfy the capability-family contracts they claim:
- **Weather**: `get_weather`, `get_forecast`
- **Web search**: `search_web` (optional: `search_news`)
- **Joke**: `tell_joke`
- **Movie showtimes**: `get_showtimes`
- **Movie catalog**: `get_movie_detail`, `search_movies`
- **TV detail**: `get_tv_detail` (optional: `get_episodes`)
- **Smart-home**: `control_device`, `get_device_status`

### Naming Conventions

**Capability/function names**: `snake_case`, verb-first, domain-stable.
- Approved verbs: `get_*`, `search_*`, `lookup_*`, `list_*`, `tell_*`, `create_*`, `update_*`, `delete_*`, `set_*`, `control_*`, `send_*`, `play_*`, `convert_*`, `calculate_*`, `summarize_*`, `translate_*`

**Skill IDs**: `<domain>_<provider>` for provider-specific skills (e.g., `weather_openmeteo`), generic name for single-provider skills (e.g., `jokes`, `calculator`).

### Production Skills

| Capability | Skill Backend | Status |
|------------|--------------|--------|
| `get_weather` | `weather_openmeteo` (Open-Meteo API) | Production |
| `knowledge_query` | `knowledge` (Wikipedia API) | Production |
| `get_movie_showtimes` | `movies_fandango` (Fandango scraper) | Production |
| `lookup_movie` / `search_movies` | `movies_tmdb` (TMDB API, key required) + `movies_wiki` (Wikipedia) | Production |
| `control_device` / `get_device_state` | `smarthome_mock` (JSON mock) | Production (mock) |
| `lookup_definition` | `dictionary` (dictionaryapi.dev) | Production |
| `get_news_headlines` | `news` (Google News RSS) | Production |
| `find_recipe` | `recipes` (TheMealDB) | Production |
| `tell_joke` | `jokes` (icanhazdadjoke) | Production |
| `lookup_tv_show` | `tvshows` (TVMaze) | Production |
| `convert_units` | `unit_conversion` (offline) | Production |
| `calculate_math` | `calculator` (offline) | Production |
| `get_time_in_location` | Built-in (stdlib zoneinfo) | Production |
| `search_web` | `search` (DuckDuckGo) | Production |
| `lookup_person_birthday` | `people_lookup` (local graph) | Production |

**LLM-backed skills** (6): `generate_email`, `code_assistance`, `summarize_text`, `create_plan`, `weigh_options`, `emotional_support` — dispatched through Ollama, degrade to deterministic stub when disabled.

**Offline KB adapters** (8): `find_products`, `get_streaming`, `search_flights`, `search_hotels`, `get_visa_info`, `get_transit`, `detect_presence`, `send_text_message` — curated in-process catalogs.

### Config Injection

Every skill receives merged config at execution time:
- Global defaults -> user overrides -> delivered as merged per-skill config.
- Skills read `parameters` (typed extraction from pipeline) + merged config. They do **not** reparse user text.

---

## 10. Source Citation

1. Skills include `source_metadata` (URL + Title) in output.
2. Synthesis LLM appends `[src:N]` markers.
3. Frontend renders Lucide chain-anchor icons with tooltips and clickable links.

---

## 11. Prompt Hierarchy

Prompts assembled in priority order:
1. **Bot Persona (Tier 3)**: Character behavior prompt.
2. **User Preference (Tier 2)**: Custom behavior prompt.
3. **Admin Global (Tier 1 — Highest)**: Parental controls, safety rules.

Admin Global placed last in system instruction block (LLMs weigh recent instructions heaviest). Explicit override: "Admin > User > Persona."

---

## 12. Testing & Quality

- **TDD**: Failing test first before new core logic.
- **Unit Tests**: Core logic, parsing, skill selection. Run on `git commit`.
- **Integration Tests**: End-to-end orchestration and API. Run on `git push`.
- **Current count**: ~1400 tests passing.
- **Pre-commit hooks**: `gitleaks` for secret detection.

---

## 13. Remaining Work

### Code Quality Backlog
- Broad `except Exception` in auth/passwords.py, auth/tokens.py — replace with specific exceptions.
- Admin routes reload entire user memory after each fact op (N+1 on bulk actions).
- Embeddings backfill runs synchronously in `MemoryProvider.initialize()` — move to background task.
- Coarse `asyncio.Lock` on all memory writes — consider per-user locks.
- Missing unit tests for admin routes and spaCy helpers.

### Feature Port Backlog (from legacy project)

**Tier 1 — Critical:**
| Feature | Status |
|---------|--------|
| Piper TTS voice catalog + installer | Blocked on Character System Phase 2 |
| OpenWakeWord wake-word detection | Blocked on Character System Phase 2 |
| Faster-Whisper full STT streaming | Not started |
| Push-to-talk voice turn workflow | Not started |
| Face recognition (ArcFace + InsightFace) | Not started |
| Ambient context assembly | Not started |
| Memory disambiguation UI | Not started |

**Tier 2 — Refinements:** Decontextualize-query + rerank, tiered prompt compilation, care profiles, provider manager, motion-gated detection.

**Tier 3 — UI patterns:** Memory management panel, person registration, live camera preview, audio waveform visualizer, browser-side VAD, project editor, live execution timeline.
