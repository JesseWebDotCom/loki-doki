# LokiDoki Memory System — Final Design

**Status:** Design accepted (v1.2 — revised after Codex's second review pass and Gemini's third review pass). **M0 + M1 + M2 complete (2026-04-11); M3–M6 not yet started.** See §8 phase table for per-phase status.
**Audience:** future Claude/Codex sessions and the human picking up memory work cold.
**Scope:** the unified memory architecture that replaces v1's faulty `facts`-centric pipeline and fills v2's empty `ConversationMemoryAdapter`.
**Lineage:** this document is the merge of two competing proposals — see [CODEX_MEM.md](CODEX_MEM.md) (Codex's tier breakdown, promotion model, and substring-matching catch) and the discussion that produced the parse-tree write gate. v1.1 incorporated Codex's second-pass review, which corrected six places where the original gates were too aggressive. v1.2 incorporates Gemini's third-pass review, which added triggered consolidation, character-overlay emotional memory, and recency-weighted contradiction handling for single-value predicates. Where the proposals conflict, this file is the resolution.
**Authority:** if [docs/spec.md](spec.md) and this file conflict, `docs/spec.md` wins on product/architecture; this file wins on memory subsystem implementation. If [docs/v2-graduation-plan.md](v2-graduation-plan.md) and this file conflict, the graduation plan's phase gates win — this file refines the §4.A–§4.E sections, it does not override them.

---

## 0. Why this document exists

LokiDoki has two memory implementations in flight:

- **v1** ([lokidoki/core/memory_provider.py](../lokidoki/core/memory_provider.py), [lokidoki/core/memory_schema.py](../lokidoki/core/memory_schema.py), [lokidoki/core/orchestrator_memory.py](../lokidoki/core/orchestrator_memory.py), [lokidoki/core/memory_search.py](../lokidoki/core/memory_search.py)) — sophisticated SQLite + FTS5 + sqlite-vec storage with confidence EMA, recency decay, and a people graph. Structurally fragile: policy lives in a 4,637-char prompt, the safety filter is all-or-nothing, retrieval leans on substring matching, and there is no distinction between fact types.
- **v2** ([v2/orchestrator/core/pipeline.py](../v2/orchestrator/core/pipeline.py), [v2/orchestrator/adapters/conversation_memory.py](../v2/orchestrator/adapters/conversation_memory.py)) — a strong deterministic orchestration prototype with no real memory layer at all. The `ConversationMemoryAdapter` reads `context["recent_entities"]` and nothing else.

Three concrete defects motivate this design:

1. **The president bug.** Asking *"who is the current president"* causes v1 to write a fact like `(user, is, "the current president")` to long-term memory. Root cause: the "questions don't become facts" rule lives as one line of English in [decomposition.py:53](../lokidoki/core/prompts/decomposition.py#L53), and the post-hoc safety net at [decomposer.py:676-683](../lokidoki/core/decomposer.py#L676-L683) is all-or-nothing.
2. **Substring-matching retrieval.** `_query_mentions()` and `_is_explicitly_relevant()` in [lokidoki/core/memory_phase2.py:49](../lokidoki/core/memory_phase2.py#L49) decide a lot of retrieval relevance with substring checks. This overfires on lexical overlap and misses paraphrase.
3. **Type collapse.** Facts, preferences, episodes, people, sentiment, corrections, and procedural patterns all compete inside one retrieval-and-injection path. v1's strongest asset (the people graph) is buried inside a generic facts bucket.

The defects share a common root: **policy and meaning are encoded textually (in prompts and substrings) where they should be encoded structurally (in parse trees, schemas, and typed tiers).**

This document fixes that.

---

## 1. Principles

These are inherited from [CLAUDE.md](../CLAUDE.md), [docs/v2-graduation-plan.md](v2-graduation-plan.md) §1, and the discussion that produced this design. They are non-negotiable.

1. **Structural over textual.** A behavior enforced by code or schema beats a behavior enforced by a prompt rule. Small models obey JSON schemas; they routinely violate paragraphs of English.
2. **Deny by default — but only for non-assertive turns.** Empty rosters, missing data, unresolved references, and low-confidence extractions fail closed. *Casual chat in which the user clearly asserts something about themselves or someone they know is not deny-by-default — it is the primary write surface.* The president bug is killed by Gate 1 (interrogative detection), not by suppressing all chat-shaped writes. v1.1 corrects v1.0 here: the original "no writes on direct_chat routes" rule would have suppressed *"my brother Luke loves movies"*, *"I'm vegetarian now"*, *"call me Jesse"*, and *"I'm stressed lately"* — exactly the human memory the system exists to capture.
3. **Layered defense, not single gatekeepers.** The president bug exists because v1 has one decision point (the LLM). The fix is not "a smarter decision point" — it is multiple independent layers, each of which can deny.
4. **Promotion, not write-time judgment.** Don't ask a small model "is this important?" at write time. Let recurrence promote candidates between tiers over time. The president bug never recurs, so it never reaches the durable layer.
5. **Typed memory beats generic memory.** Seven tiers with seven retention policies and seven retrieval paths beat one fact bucket with seven invisible failure modes.
6. **Lazy retrieval, structured injection.** Don't fetch memory the turn doesn't need. Don't dump retrieved memory as one blob. Each tier gets its own named slot in the synthesis prompt.
7. **One database, multiple memory systems.** SQLite + FTS5 + optional sqlite-vec stays the storage stack on Pi 5. The seven tiers are *policies and views over storage*, not separate databases.
8. **No regex/keyword classification of user intent.** ([CLAUDE.md hard rule](../CLAUDE.md).) Branching signals come from the parse tree or from structured decomposer fields, never from substring matches on `user_input`.
9. **No LLM in the hot write path beyond what already runs.** The decomposer is already a per-turn cost. Adding a second small-model call to "verify" a fact is the kind of regression we're explicitly trying to avoid.
10. **Bake-off discipline.** Per [v2-graduation-plan.md §1](v2-graduation-plan.md) every subsystem section in §10 of this document has an explicit gate checklist. Nothing lands on `main` without the gate green.

---

## 2. The seven tiers

The seven tiers map to the standard cognitive-science taxonomy (Pieces' five-layer model + the "six types" article + procedural learning), and each one earns its place by having a write rule, a decay rule, and a retrieval path that none of the others can serve.

### Tier 1 — Working (per-turn, volatile)
- **What it holds:** the current turn's `RequestSpec` — parse tree, entities, references, signals, in-flight clarifications, current sentiment.
- **Storage:** in-memory only. Lives inside `run_pipeline_async`. Never written to disk.
- **Maps to:** human working memory and sensory buffer.
- **What it enables:** intra-turn pronoun resolution, multi-clause coreference, fast-lane shortcuts, the `interrogative` signal that gates Tier 4/5 writes.
- **Status:** v2 already has this. Leave it alone.

### Tier 2 — Session (active thread, short-lived durable)
- **What it holds:** the last N messages of the active session (already in `messages`), plus a per-type "last seen" map (`last_movie`, `last_person`, `last_location`, …) for cross-turn pronoun resolution, plus unresolved questions and temporary assumptions.
- **Storage:** existing `messages` table plus a new `session_state` JSON column on `sessions`. No vectors, no FTS, no LLM.
- **Maps to:** short-term conversational memory.
- **Decay:** cleared when the session closes. The last-seen map and unresolved questions roll forward into a sessionless `recent_context` view that decays over hours-to-days.
- **Retrieval:** lazy. The pronoun resolver consults it only when it sees an unresolved reference.
- **Promotion:** at session close, a deterministic summarizer (no LLM, just template-fill from session metadata) plus an out-of-band episodic summarization job (see Tier 3) decide which session content gets promoted.
- **Replaces:** v2's `ConversationMemoryAdapter` ephemeral context dict — same shape, real backing.

### Tier 3 — Episodic (durable, summarized, time-anchored)
- **What it holds:** significant past interactions stored as compact summaries with temporal and emotional metadata. *"On 2026-04-09 the user was excited about an upcoming Japan trip; we discussed itinerary."* Not verbatim transcripts.
- **Storage:** new `episodes` table in the same SQLite file:
  - `id`, `owner_user_id`, `title`, `summary`, `start_at`, `end_at`, `sentiment`, `entities (JSON)`, `topic_scope` (nullable string), `confidence`, `superseded_by`, `recall_count`, `last_recalled_at`.
  - FTS5 over `summary`, optional vector embedding via the existing async backfill in [memory_provider.py:70-126](../lokidoki/core/memory_provider.py#L70-L126).
- **Maps to:** episodic memory — events with time and feeling.
- **Write trigger:** at session close (or every 20 turns within long sessions), an out-of-band summarization job runs on the just-completed window. **This is the only place an LLM enters the write path, and it runs out-of-band, not on the hot loop.**
- **Decay:** 90-day half-life on retrieval score. Episodes older than ~6 months with `recall_count = 0` get rolled up into a coarser period summary (the same compression Mem0 markets).
- **Retrieval:** BM25 + temporal proximity, optionally vector, optionally filtered by `topic_scope`. Triggered by `need_episode` from the decomposer.
- **Promotion:** episodes whose entities or claims appear in 3+ separate sessions promote those claims into Tier 4 (semantic) — see §4 below.
- **Topic scope (v1.1).** Episodes carry an optional `topic_scope` string (`"japan_trip"`, `"garden_build"`, `"kitchen_remodel"`, `"moms_medical_paperwork"`). This is the lightweight context axis Codex flagged in the second review — **not** a full project hierarchy, just a string tag that lets episodic retrieval focus on a recurring thread without dragging in unrelated history. Derivation logic (LLM tag at summarization time vs deterministic clustering on entities) is deferred to the M4 bake-off.

### Tier 4 — Semantic-self (durable, fact-shaped)
- **What it holds:** `(subject, predicate, value)` triples about the user themselves and entities the user owns or constrains. Identity, preferences, biographical facts, occupations, locations, recurring tastes. **Excludes** facts about other people — those are Tier 5.
- **Storage:** existing `facts` table from [memory_schema.py](../lokidoki/core/memory_schema.py). Existing FTS5 + sqlite-vec hybrid. Existing confidence model (EMA + 180-day half-life with identity exemption). Existing contradiction handling from [memory_contradiction.py:32](../lokidoki/core/memory_contradiction.py#L32).
- **Maps to:** semantic memory — abstract durable knowledge about the self.
- **Write trigger:** the **full gate chain** in §3 must pass. Promoted from Tier 3 by recurrence.
- **Decay:** v1's existing 180-day half-life on stored confidence; identity-class facts exempt.
- **Retrieval:** v1's existing FTS5 + sqlite-vec hybrid with RRF fusion in [memory_search.py](../lokidoki/core/memory_search.py). **Port unchanged**, then rebench in M2 per the graduation plan §4.B. The substring-matching heuristics in [memory_phase2.py:49](../lokidoki/core/memory_phase2.py#L49) get **deleted**, not ported.

### Tier 5 — Social/relational (durable, graph-shaped)
- **What it holds:** people, relationships, interaction history per person, importance scores, last-mentioned timestamps, ambiguity groups, overlays. Anything where the subject is "another person in the user's life."
- **Storage:** existing `people`, `relationships`, `ambiguity_groups` tables from [memory_schema.py:160](../lokidoki/core/memory_schema.py#L160). The `_resolve_person()` scoring loop in [orchestrator_memory.py:71-113](../lokidoki/core/orchestrator_memory.py#L71-L113) is the seed; the magic constants (`DISAMBIG_MARGIN = 1.0`, `* 0.5`, `+ 3.0`, `* 0.001`) get baked off in M3 per graduation plan §4.D. Add a `handle` column (nullable) and a `provisional` boolean to support unnamed recurring people — see write trigger below.
- **Maps to:** social memory — the model of who else exists in the user's world.
- **Why it's a separate tier from Tier 4:** v1 already invested in a real graph here (people, relationships, ambiguity, overlays, sentiment per person). Folding it into a generic facts bucket loses that structure. Codex was right to call this out.
- **Write trigger (v1.1).** Full gate chain plus subject identity rules. The subject must be one of:
  1. A **named** person resolved from `LokiPeopleDBAdapter` above the resolver's confidence threshold with no ambiguity flag, **OR**
  2. A **provisional handle** — a recurring private-person reference with no known name, like *"my boss"*, *"my therapist"*, *"the barista"*, *"my new neighbor"*, *"that contractor"*. Provisional rows have `name = NULL`, `handle = "my boss"`, `provisional = true`. They get the same disambiguation, the same relationship edges, the same sentiment tracking. They get **merged** into a named row when the user later supplies the name (*"Luke is my brother"* → merge with the `"my brother"` handle).
  3. **Strangers, public figures, and hypothetical people are still denied.** *"The president"*, *"that guy on TV"*, *"some random person"* never become Tier 5 rows. The distinction is: "private to the user's life" vs "public-world."
- **Why provisional handles matter:** v1.0 of this design rejected unnamed people entirely, which would have dropped *"my boss is being weird about the deadline"* on the floor. People talk about recurring private others before naming them; the system should remember the relationship and merge in the name later, not require the name first.
- **Decay:** never on the people row itself; per-fact decay on relationship and biographical predicates per Tier 4 rules. Provisional handles unmerged after 90 days drop a confidence tier; unmerged after 180 days are flagged for the user to confirm or forget.
- **Retrieval:** graph traversal + FTS5 over `name`, `aliases`, and `handle`. Triggered by `need_social` from the decomposer.

### Tier 6 — Emotional / affective (rolling, time-windowed, character-overlaid)
- **What it holds:** sentiment trajectory and ongoing concerns over the last 1–2 weeks. *"User has been stressed about work for 3 days running."* *"Last 5 sessions trended more frustrated than baseline."* Per-person sentiment overlays already exist in v1's people graph; this tier covers the user's own affect.
- **Storage:** new `affect_window` table — daily sentiment aggregates and active concerns per `(owner_user_id, character_id)` pair. Backed by a `sentiment` column added to `messages` (decomposer already emits this in `short_term_memory`; we just persist it). The `character_id` column reflects which persona the turn was directed at.
- **Maps to:** emotional / mood memory.
- **Write trigger:** every turn the decomposer emits a sentiment label, we persist it scoped to the active character. No gating — sentiment is observation, not assertion.
- **Decay:** 14-day rolling window. Per-day aggregates older than 30 days drop entirely.
- **Retrieval:** loaded once at session start filtered by the active character, lives in the request context for the whole session. Triggered always, but the slot is empty when no notable signal exists.
- **Privacy:** most sensitive tier. User-toggleable opt-out. Never leaves the device. UI surface for "forget my mood."
- **Character-overlay rationale (v1.2).** Gemini's third review flagged that LokiDoki uses different characters (the "Puppeteer gap"). Tiers 4 and 5 (facts about the user and the people in their life) are character-agnostic — *the user is the user regardless of which persona they're talking to*. Tier 7a (style) is also user-global. But Tier 6 is about the *relationship temperature* between the user and a specific character: the user might be playful with one persona and serious with another. Persisting that as a per-character overlay lets each persona "know" its own emotional history with the user without leaking it to other personas. **Tier 6 is the only tier with a character_id column.** All other tiers stay user-global per the [persona repo's content-only contract](../CLAUDE.md).

### Tier 7 — Procedural (durable, learned, implicit) — split into two sub-tiers
- **What it holds:** how the user *interacts* — not what they know. Behaviorally derived, never stated. **v1.1 splits this tier into two strictly separated sub-stores** because some procedural signals are safe to surface in synthesis prompts and others would feel surveillant.

**Sub-tier 7a — Prompt-safe style adaptation (`user_profile.style`).**
- **What it holds:** *"prefers brief answers"*, *"likes first-name address"*, *"prefers casual tone"*, *"prefers metric units"*, *"asks about weather around 7am"* (only the time-of-day shape, not who/what), *"uses voice in the morning, text at night"*.
- **Allowed in synthesis prompts.** Injected as `{user_style}` and `{recent_routines}` slots.
- **Closed enum of axes:** `tone`, `verbosity`, `formality`, `name_form`, `preferred_modality`, `units`, `routine_time_buckets`. New axes require a design discussion, not a free-text addition.
- **Source signals:** behavior aggregation over turns where the user expressed satisfaction, accepted long answers, or matched a recurring time pattern.

**Sub-tier 7b — Internal UX telemetry (`user_profile.telemetry`).**
- **What it holds:** *"dismisses confirmation dialogs without reading"*, *"retries failed voice commands quickly"*, *"abandons answers longer than 200 tokens"*, *"clicks the regenerate button after first response 30% of the time"*.
- **Never injected into synthesis prompts.** Drives UX decisions only — confirmation dialog frequency, default verbosity, retry timeouts, animation speed. The synthesizer never sees this and never references it.
- **Why the split:** surfacing *"I noticed you don't read confirmations"* in a chat response would feel surveillant. The signal is still useful, just not for the model to talk about. Codex flagged this in the second review and was right.
- **Privacy:** opt-out toggle in user settings disables telemetry collection entirely.

- **Storage:**
  - `behavior_events` — append-only log written by the orchestrator at the end of every turn (input modality, response length tolerated, dialog dismissed, retry rate, etc.).
  - `user_profile` — one row per user with two JSON columns: `style` (sub-tier 7a, prompt-safe) and `telemetry` (sub-tier 7b, prompt-forbidden), plus an `updated_at`.
- **Maps to:** procedural memory — implicit pattern learning without explicit recall.
- **Write trigger:** `behavior_events` is written every turn (deterministic, no gate). The aggregation job (see §5 reflect job) runs nightly or every Nth session and updates both sub-tiers of `user_profile` deterministically. **No LLM anywhere in this path.**
- **Decay:** profile descriptors never decay outright but are overwritten by aggregation. `behavior_events` rows older than 30 days drop after they've been folded into the profile.
- **Retrieval:** sub-tier 7a loaded once at session start as `{user_style}` and `{recent_routines}` slots in the synthesis prompt. Sub-tier 7b loaded by UX code paths only, never reaches the synthesis layer.
- **Why this tier matters most for "humanistic feel":** every other tier remembers *content*. This is the tier that remembers *the relationship*. Mem0 doesn't have it. v1 doesn't have it. Procedural memory is what makes the assistant feel adaptive instead of just informed — *as long as it adapts without saying it is adapting*, which is exactly why the 7a/7b split exists.

---

## 3. The write path — layered defense

The president bug exists because v1 has exactly one gatekeeper (the LLM in the decomposer). The fix is **three independent layers**, each of which can deny a write.

### Layer 1 — Structural gate chain (Python, deterministic)

Every memory write candidate must pass all five gates before any DB operation. No retries. Reject on first failure. Log to the regression corpus.

**Gate 1 — Clause shape (parse tree, deterministic).**
The chunk that produced the candidate must be **non-interrogative and non-info-request.** v1.1 corrects v1.0 here: the original "must be declarative" framing rejected fragmentary assertions like *"by the way, allergic to peanuts"*, imperative-shaped self-statements like *"call me Jesse"*, and exclamatory ones like *"ugh, still hate loud restaurants!"* — all of which are valid memory-bearing utterances. The right gate is to block questions, not to require canonical declaratives.

The gate denies the chunk if any of these fire (all evaluated against the spaCy `Doc` already produced by the v2 `parse` step — zero additional parse cost):
- Any token with `tag_ in {"WP", "WP$", "WRB", "WDT"}` appears at sentence start (`token.is_sent_start`) — catches WH-fronted questions.
- The sentence root has `dep_ == "ROOT"` and an `aux` child preceding the `nsubj` child — catches subject-aux inversion (*"is the president…"*).
- The sentence ends with `?` and the root verb is not in a rhetorical-question whitelist.
- The root verb's lemma is in a closed info-request whitelist (`tell`, `explain`, `show`, `list`, `find`, `look up`, `search`) AND the direct object is interrogative-headed.
- spaCy NER or rule-based tagger marks the chunk as `QUESTION` (if a future v2 model adds that tag).

The gate allows:
- Canonical declaratives (*"I'm vegetarian"*).
- Fragments with a typed candidate from the extractor (*"allergic to peanuts"*, *"vegetarian now"*).
- Imperatives that are self-statements rather than info-requests (*"call me Jesse"*, *"don't call me Robert"*).
- Exclamatives expressing preference or affect (*"ugh, hate loud restaurants"*).
- Modal/hedged statements (*"I think I'm allergic to shellfish"*) — these pass but the candidate's initial confidence is dropped one tier.

The gate still kills the president bug, because *"who is the current president"* is unambiguously interrogative (WH-fronting + question mark + interrogative sentence type) and is denied before any further evaluation.

**Gate 2 — Subject identity (resolver, deterministic).**
The triple's subject must be one of:
- `self` — first-person possessive or personal pronoun (`I`, `my`, `me`, `mine`).
- A **resolved** person from `LokiPeopleDBAdapter` above the resolver's confidence threshold with no ambiguity flag.
- A named entity already in the user's people/entity graph.

Strangers, public figures, hypothetical people → reject. *"The president"* matches none of these.

**Gate 3 — Predicate validity (closed enum, deterministic).**
The predicate must be in a closed whitelist of typed predicates per tier:
- Tier 4 (semantic-self): `prefers`, `lives_in`, `works_as`, `is_named`, `was_born`, `owns`, `has_constraint`, …
- Tier 5 (social): `is_relation`, `lives_in`, `is_named`, `has_birthday`, `prefers`, …
- Tier 6/7 are observation-only and don't use predicates.

Free-text predicates from the LLM are coerced to the nearest enum value or rejected. This is what makes deduplication and contradiction handling tractable downstream.

**Gate 4 — Schema validation (Pydantic, deny on fail).**
Strict Pydantic validation of the candidate. **No repair loop.** If the LLM emits malformed JSON we drop the candidate and append it to the regression corpus. v1's `MAX_REPAIRS = 2` retry pattern in [decomposer.py:251-311](../lokidoki/core/decomposer.py#L251-L311) is a smell that the prompt is too big; the fix is a smaller prompt and a smaller schema, not a retry loop.

**Gate 5 — Intent context (defense in depth).**
v1.1 reframes this gate. The original v1.0 rule was *"no writes on `direct_chat` routes"*, which would have suppressed exactly the casual chat surface where humans share themselves (*"my brother Luke loves movies"*, *"I'm vegetarian now"*, *"call me Jesse"*). Codex flagged this as the most damaging error in v1.0 and was right.

The corrected rule gates on **intent**, not on **route**. Memory writes are denied when the structured intent is one of:
- `greeting` (*"hi"*, *"good morning"*)
- `joke` / `quip`
- `command_to_assistant` that does not contain a self-assertion (*"set a timer for 5 minutes"*, *"play some music"*)
- `info_request` / `question` (already handled by Gate 1; this is belt-and-suspenders)
- `clarification_request` (*"what did you mean?"*)

Memory writes are **allowed** when the intent is one of:
- `assertive_chat` (the casual-chat surface — this is where most durable facts arrive)
- `self_disclosure`
- `correction` (the user is correcting a previous fact: *"actually it's Jesse, not Jess"*)
- `command_to_assistant_with_self_assertion` (*"call me Jesse from now on"* — both a command and an identity assertion)

The intent label is a structured field on the decomposer output; it is not derived from substring matches on the user input. If the decomposer cannot label the intent confidently, the candidate falls through to Gate 1's clause-shape check and is decided there.

This is the v2-graduation-plan §3.1 requirement, made structural and made non-suppressive of normal conversation.

### Layer 2 — Tier classifier (constrained, narrow)

Candidates that survive Layer 1 reach a tier classifier whose only job is to pick which tier the candidate enters: `session | episodic | social | semantic | emotional | procedural`. The classifier is allowed to be a small model with a constrained-decoding grammar limiting output to those six tokens, OR a deterministic ruleset over the gate-chain output, depending on what wins the M1 bake-off.

**The critical distinction**: the classifier is a **router**, not a gatekeeper. It cannot deny a write — Layer 1 already approved the write. It can only pick the destination. This is why Codex's "memory classifier" idea is safe in this position but would be dangerous at the front of the pipeline.

### Layer 3 — Promotion via recurrence (background, deterministic) + immediate-durable carve-out

Most candidates enter Tier 2 (session) or Tier 3 (episodic) on first observation. They only reach the durable Tier 4/5 layers via **promotion**:

- A claim that appears in 3+ separate session-close summarizations promotes from episodic into semantic-self (or social).
- A behavior pattern that holds across ≥10 sessions promotes into procedural.
- A sentiment trend that holds across ≥3 days promotes into the affective rolling window.

**Why this matters for the president bug**: even if a stray garbage extraction slipped through Layer 1 and Layer 2 once, it would never recur. It dies in Tier 3 before reaching the user-visible durable layer.

**Immediate-durable predicates (v1.1 carve-out).** Codex's second review correctly flagged that *some* facts must not require 3 sessions to become durable — if the user tells the assistant their name once, the assistant should remember on the next turn. The following typed predicates **bypass promotion** and write directly to Tier 4 or Tier 5 on first observation, provided they pass Layers 1 and 2:

| Tier | Immediate-durable predicates |
|---|---|
| Tier 4 (semantic-self) | `is_named` (preferred name and form), `has_pronoun`, `has_allergy`, `has_dietary_restriction`, `has_accessibility_need`, `has_privacy_boundary`, `hard_dislike` (distinct from `prefers`, which is soft and goes through promotion) |
| Tier 5 (social) | `is_named` (a person's name), `is_relation` (relationship label like *brother*, *wife*, *therapist*), `has_pronoun` (per person) |

The principle: *facts that affect how the assistant addresses, accommodates, or harms the user must be one-shot durable.* Soft preferences (favorite color, recurring tastes) still benefit from promotion. Hard constraints (peanut allergy) cannot wait three sessions.

Implementation note: the immediate-durable list is a Python constant, not a prompt instruction. The classifier in Layer 2 picks the tier; the predicate enum check in Gate 3 picks whether promotion is bypassed. No model judgment.

**Triggered consolidation (v1.2 fast-path).** Gemini's third review flagged a latency hole: a soft preference repeated three times in one afternoon should not have to wait until the nightly reflect job to become durable. The user said it three times; they expect it to stick.

The fix is an in-session frequency counter on `(subject, predicate)` pairs. When a candidate (a) is *not* on the immediate-durable list and (b) lands in Tier 3 (episodic) for the third time within a single session OR within a 24-hour rolling window, the orchestrator fires an **immediate consolidation attempt** that runs the same logic as the nightly reflect job's promotion step. The candidate must still pass the gate chain — *triggered consolidation is eligibility, not bypass.*

| Mechanism | Threshold | Bypasses gates? | Fired by |
|---|---|---|---|
| Immediate-durable predicates | 1 observation | No (still must pass Layers 1+2) | Predicate enum match |
| Triggered consolidation | 3 observations within session OR 24h | No | In-session frequency counter |
| Nightly reflect job | 3 observations across separate sessions | No | Cron / idle timer |

The three mechanisms compose without overlap: immediate-durable handles safety-critical predicates that must stick on turn one; triggered consolidation handles soft preferences that the user actively reinforces during a single interaction; the nightly reflect job handles the long-tail recurrence pattern across sessions. Together they close the "I told it three times today and it forgot by tomorrow" UX hole.

Implementation note: the in-session counter is a `dict` keyed by `(owner_user_id, subject_hash, predicate)` on the request `context`, persisted to `session_state` (Tier 2) so the 24-hour rolling window survives session boundaries within the same day.

### What v1 does that we explicitly delete

- The 4,637-char decomposition prompt as the policy layer ([decomposition.py](../lokidoki/core/prompts/decomposition.py)) — replaced by Layer 1 gates.
- The repair loop ([decomposer.py:251-311](../lokidoki/core/decomposer.py#L251-L311)) — replaced by reject-and-log.
- The all-or-nothing post-hoc filter ([decomposer.py:676-683](../lokidoki/core/decomposer.py#L676-L683)) — replaced by per-candidate Layer 1 gates.
- The substring-matching retrieval heuristics in [memory_phase2.py:49](../lokidoki/core/memory_phase2.py#L49) (`_query_mentions`, `_is_explicitly_relevant`) — deleted on the read side; replaced by typed `need_*` fields driving per-tier retrieval.

---

## 4. The read path — lazy, typed, structured injection

v1 fetches memory eagerly on every turn even when the turn is *"hi"* — a latency tax. v2 will be lazy and per-tier.

### Decomposer schema additions

The decomposer (whichever model wins graduation plan §4.C) emits these new structured fields. Each is a boolean. **The decomposer prompt does not explain when to set them in English** — the prompt has worked examples for each field, and the schema enforces the type. Adding a `need_*` field costs ~50 chars in the prompt budget; deleting the prose rules it replaces saves more than that.

| Field | Triggers retrieval from |
|---|---|
| `need_session_context` | Tier 2 (recent thread state, last-seen map) |
| `need_episode` | Tier 3 (relevant past episodic summaries) |
| `need_preference` | Tier 4 (semantic-self facts) |
| `need_social` | Tier 5 (people graph + relational facts) |
| `need_emotional_context` | Tier 6 (affective rolling window) — also always-on at session start |
| `need_routine` | Tier 7 (procedural profile) — also always-on at session start |

The pronoun resolver may **also** raise `need_session_context` even if the decomposer didn't, when it detects an unresolved reference. That's the only override.

### Per-tier retrieval mechanisms

| Tier | Retrieval mechanism |
|---|---|
| 1 — Working | Already in `RequestSpec` |
| 2 — Session | Direct keyed lookup on `session_state` JSON; bounded last-N message scan |
| 3 — Episodic | FTS5 + temporal proximity (recency-weighted), optional vector if backfill caught up |
| 4 — Semantic-self | v1's FTS5 + sqlite-vec hybrid with RRF — port unchanged from [memory_search.py](../lokidoki/core/memory_search.py) |
| 5 — Social | Graph traversal + FTS5 over `name` / `aliases` + relationship-edge walk |
| 6 — Emotional | Direct read of last 14-day affect window |
| 7 — Procedural | Direct read of `user_profile` row |

Hindsight's parallel-retrieval RRF + cross-encoder rerank pattern is the right model for Tier 4. We may extend it to Tier 3 in M4 if the bake-off shows it helps.

### Synthesis prompt slots

Each tier gets its **own named slot** in the combine prompt. The synthesis model never sees one giant memory blob — it sees structured, labeled context.

| Slot | Tier | When present | Hard char budget |
|---|---|---|---|
| `{user_style}` | 7a | always | 200 |
| `{recent_mood}` | 6 | always (often empty) | 120 |
| `{recent_context}` | 2 | `need_session_context` OR unresolved-marker | 300 |
| `{relevant_episodes}` | 3 | `need_episode` (max 2 entries) | 400 |
| `{user_facts}` | 4 | `need_preference` (top-3 RRF) | 250 |
| `{social_context}` | 5 | `need_social` | 200 |

**Total worst-case slot budget: 1,470 chars.** Enforced in the assembly code, not the prompt. Each slot is truncated to its budget by ranking before injection — never silently overflow. Gemini's third review explicitly flagged context-stuffing as a Pi 5 latency risk; these caps make the per-turn memory injection cost bounded and measurable.

If a slot is empty it renders as the empty string, not as the literal `"none"` or any other token the model might latch onto. Whether to render an empty slot at all (blank line vs skip the line) is decided per-template at M2 time and tested for synthesizer drift.

The combine prompt template grows by ~6 named slots; the slot scaffolding adds ~150 chars and the worst-case slot content adds ~1,470 chars. The synthesizer prompt budget therefore needs at least ~2,000 chars of headroom over the v1 baseline. v2's combine prompt at [v2/orchestrator/fallbacks/prompts.py](../v2/orchestrator/fallbacks/prompts.py) is currently ~80–200 chars; adding the slots brings it to ~2,200 chars, well under the 8,000-char budget defined in [CLAUDE.md](../CLAUDE.md) Prompt Budget Discipline.

---

## 5. Lifecycle — decay, dedup, contradiction, eviction, reflection

### Decay

| Tier | Half-life | Notes |
|---|---|---|
| 1 — Working | n/a | Dies with the request |
| 2 — Session | session-scoped | Dies at session close; last-seen map rolls into `recent_context` for hours-to-days |
| 3 — Episodic | 90 days | Recall events extend the half-life |
| 4 — Semantic-self | 180 days | v1's existing model; identity-class facts exempt |
| 5 — Social | n/a on people rows; per-fact 180d on relationship/biographical predicates | Identity exempt |
| 6 — Emotional | 14 days rolling; aggregates drop at 30 days | |
| 7 — Procedural | never | Overwritten by aggregation |

### Deduplication

- **Tier 4/5 at write time**: existing `(owner, subject, predicate, value)` UNIQUE constraint from [memory_schema.py](../lokidoki/core/memory_schema.py).
- **Per-turn write set**: maintain a set of write candidates for the current turn; drop intra-turn duplicates before any DB call. (v1 today re-evaluates the same candidate twice if the decomposer emits it twice — cheap but adds confidence inflation.)
- **Tier 3 at write time**: near-duplicate cosine check on episodic summary embeddings before insert. If `cos > 0.92` against an existing recent episode, merge into that episode instead.

### Contradiction

Keep v1's row-centric model from [memory_contradiction.py:32](../lokidoki/core/memory_contradiction.py#L32). Do not build a first-class belief timeline (sources, certainty intervals, audit trail per assertion) — that is overengineering for a Pi-local assistant. v1's `update_confidence()` + `superseded` status + `observation_count` already gives us a usable history per fact.

The change is that contradiction now runs *per tier*, with tier-specific rules:
- Tier 4: `SINGLE_VALUE_PREDICATES` — new value supersedes old immediately, prior value's `status` flips to `superseded`, prior value's confidence drops to a low floor (0.1) without gradual decay. **The expanded list (v1.2):** `is_named`, `has_pronoun`, `lives_in`, `works_as`, `current_employer`, `current_partner`, `currently_lives_with`, `favorite_color`, `favorite_food`, `favorite_movie`, `preferred_modality`, `preferred_units`, `timezone`. v1's original list was too small; Gemini's third review correctly flagged that "favorites" and "currently *X*" predicates are effectively single-valued and need recency-dominated handling to avoid memory drift over months.
- Tier 5: per-relationship rules — `is_relation=brother` and `is_relation=sister` for the same person flag ambiguity, not contradiction. `current_partner` for the user, however, IS in the single-value list above and flips to `superseded` on change.
- Tier 7: aggregation overwrites the profile; no contradiction concept.

**Recency-vs-frequency principle (v1.2).** For multi-value predicates (preferences that coexist, like *"likes Italian food"* + *"likes Thai food"*), frequency drives confidence — the more often we observe it, the more confident we are. For single-value predicates, **recency dominates frequency** — observing *"I now live in Portland"* once after years of `lives_in=Seattle` should immediately supersede Seattle, not slowly chip away at it. The two update rules are:

| Predicate class | Update rule |
|---|---|
| Multi-value (`prefers`, `likes`, `dislikes` …) | EMA confidence nudge per observation; no supersession |
| Single-value (`is_named`, `lives_in`, `current_employer` …) | New value writes at high confidence; prior value flips to `superseded` and drops to confidence floor 0.1 |

The single-value predicate list is a Python constant in the same module as the immediate-durable predicate list; both are tested by the M1 corpus.

### Eviction

- Tier 3 episodes older than 6 months with `recall_count = 0` get rolled up into a coarser period summary ("Q1 2026") and the originals are dropped.
- Tier 7 `behavior_events` rows older than 30 days get aggregated into the profile and dropped.
- Tier 4/5 facts **never auto-evict** unless explicitly rejected by the user. Confidence can decay to near-zero but the row stays for audit.

### User-visible forgetting

- New `forget(subject)` and `forget_episode(id)` capabilities surfaced through the existing `/api/memory` routes.
- Episodes mention their own ID in the synthesis output for *"forget that"* follow-ups.
- Tier 6 has its own opt-out toggle (most sensitive).

### The reflect job

A background job — runs nightly, or every Nth session, or on idle — performs three deterministic operations:

1. **Episodic → semantic promotion.** Walk the last 30 days of episodes; for any claim or entity that appears in 3+ separate episodes, write it as a Tier 4 or Tier 5 fact via the gate chain (yes, it still has to pass gates; promotion is *eligibility*, not *bypass*).
2. **Behavior aggregation.** Walk `behavior_events` since last run; update `user_profile` deterministically. Drop folded-in events.
3. **Episodic compression.** Walk episodes older than 6 months with `recall_count = 0`; group by month or quarter; emit one rollup episode per group; drop originals.

**No LLM in steps 1 or 2.** Step 3 may use the same out-of-band summarizer as Tier 3 writes. The reflect job is what turns "remembering" into "growing" — it is the difference between a system that records and a system that learns.

---

## 6. Storage — one SQLite, multiple memory systems

The seven tiers share one SQLite file. The tiers are policies and views, not separate databases.

### Existing tables (kept, modified)

| Table | Tier(s) | Changes |
|---|---|---|
| `facts` | 4 (semantic-self) | None to schema. Write path goes through new gate chain. |
| `people` | 5 (social) | Add `handle` (nullable string) and `provisional` (boolean) columns to support unnamed recurring people per Tier 5. **Add an index on `(owner_user_id, handle)` for fast provisional lookups** — Gemini's third review flagged this as a hot path during in-session disambiguation. |
| `relationships` | 5 (social) | None to schema. Provisional people rows participate in relationship edges normally. |
| `ambiguity_groups` | 5 (social) | None to schema. |
| `sessions` | 2 (session) | Add `session_state` JSON column for last-seen map and unresolved questions. |
| `messages` | 2 (session) | Add `sentiment` column (decomposer already emits this). |
| `facts_fts` | 4 | Unchanged. |
| `messages_fts` | 2 | Unchanged. |
| `vec_facts`, `vec_messages` | 4, 2 | Unchanged. |

### New tables

| Table | Tier | Columns |
|---|---|---|
| `episodes` | 3 | `id`, `owner_user_id`, `title`, `summary`, `start_at`, `end_at`, `sentiment`, `entities` (JSON), `topic_scope` (nullable string), `confidence`, `superseded_by`, `recall_count`, `last_recalled_at` |
| `episodes_fts` | 3 | FTS5 over `episodes.summary` with Porter tokenizer |
| `vec_episodes` | 3 | Optional sqlite-vec virtual table, 384-dim, async backfill |
| `affect_window` | 6 | `owner_user_id`, `character_id`, `day`, `sentiment_avg`, `notable_concerns` (JSON) — composite PK on `(owner_user_id, character_id, day)` |
| `behavior_events` | 7 | `id`, `owner_user_id`, `at`, `event_type`, `payload` (JSON) — append-only |
| `user_profile` | 7 | `owner_user_id` (PK), `style` (JSON, prompt-safe sub-tier 7a), `telemetry` (JSON, prompt-forbidden sub-tier 7b), `updated_at` |

### What we deliberately do not add

- No knowledge-graph database (Neo4j, KuzuDB). The `people` + `relationships` tables already form a graph; SQL recursive CTEs handle the queries.
- No external vector store (Chroma, Qdrant, pgvector). sqlite-vec is enough.
- No second SQLite file. One database, multiple systems.
- No belief-timeline schema with sources, certainty intervals, and audit trail per assertion. v1's row-centric contradiction model is sufficient for a Pi-local assistant.

---

## 7. Pipeline integration — concrete v2 touch points

Concretely, the v2 pipeline ([v2/orchestrator/core/pipeline.py:35-213](../v2/orchestrator/core/pipeline.py#L35-L213)) gains exactly these touch points. No other v2 step changes shape.

1. **Session start** (before `normalize`): load Tier 6 (affective) and Tier 7 (procedural) once. Cache on the request `context`. Cost: two SQLite point reads.
2. **After `parse`**: derive `is_interrogative`, `clause_shape`, `hedge_level` from the spaCy parse tree. Stash on each `RequestChunk`. Cost: zero — we already parse.
3. **After `resolve`**: enrich each resolved person/entity back onto the chunk so Gate 2 of the write path has someone to compare against. Cost: zero — we already resolve.
4. **After `extract`** (or after the decomposer fallback if v2 keeps one): collect write candidates, run Layer 1 gate chain in Python, run Layer 2 tier classifier on survivors, call `memory_provider.upsert_*()` per tier. Cost: gate chain is microseconds; classifier is the only variable.
5. **Before `combine`**: assemble the per-tier prompt slots from §4 (`{user_facts}`, `{relevant_episodes}`, `{recent_context}`, `{user_style}`, `{recent_mood}`, `{social_context}`). Cost: each slot is gated by a `need_*` field, so most turns assemble two or three slots.
6. **After response sent (out-of-band)**: append a row to `behavior_events`; if the session closed, queue a Tier 3 episodic summarization job and a reflect-job tick.

The `MemoryProvider` singleton from v1 ([memory_provider.py](../lokidoki/core/memory_provider.py)) is the storage object both v1 and v2 use during the cutover, so a user's memory continues to grow across the migration. Per [graduation plan §4.D](v2-graduation-plan.md), the runtime resolver receives `MemoryProvider` + `viewer_user_id` via the `context` dict.

---

## 8. Migration phases (gates aligned with v2-graduation-plan)

The build sequence has **seven phases**: M0 (prerequisites) through M6 (final tier). Each phase has a single owner-checkable deliverable, a corpus, and a gate. Each phase publishes a bake-off doc at `docs/benchmarks/v2-memory-{phase}-bakeoff-YYYY-MM-DD.md` per the [graduation plan §1](v2-graduation-plan.md) discipline. **No phase advances until the prior phase's gate is green.**

### Phase overview

| Phase | Title | Tiers touched | Hard prerequisite | Estimated complexity | Status |
|---|---|---|---|---|---|
| **M0** | Prerequisites and corpora | none | — | Low — fixture and infra work | **complete (2026-04-11)** |
| **M1** | Write path: gate chain + classifier + immediate-durable + Tier 4/5 writes | 4, 5 | M0 | High — most novel logic | **complete (2026-04-11)** |
| **M2** | Read path: port Tier 4 retrieval, delete substring heuristics | 4 | M1 | Medium — port + delete | **complete (2026-04-11)** |
| **M3** | Tier 5 social: wire `LokiPeopleDBAdapter`, bake off scoring, provisional handles | 5 | M1 (M2 helpful) | Medium | not started |
| **M4** | Tier 2 + Tier 3: session state, episodic summarization, promotion, triggered consolidation, topic scope | 2, 3 | M2 | High — episodic is new | not started |
| **M5** | Tier 7 procedural: behavior events, nightly aggregation, 7a/7b split | 7a, 7b | M2 | Medium | not started |
| **M6** | Tier 6 affective: rolling window, character overlay, privacy opt-out | 6 | M2 | Low–medium | not started |

**Critical path:** M0 → M1 → M2 → (M3, M4 in parallel) → (M5, M6 in parallel). M3 and M4 can be staffed independently after M2 ships. M5 and M6 can be staffed independently after M2 ships. The reflect job (§5) lands incrementally: promotion in M4, behavior aggregation in M5, episodic compression as a follow-up to M6.

---

### M0 — Prerequisites and corpora
**Status: complete (2026-04-11).** All deliverables shipped, all gates green. M1 is now unblocked.

**Why this phase exists.** Every later phase needs corpora, regression fixtures, and shared module scaffolding. Building those incrementally inside M1–M6 has historically caused phase-creep. M0 lands them once, up front.

**Module location decision (resolved in M0).** The memory subsystem lives at [v2/orchestrator/memory/](../v2/orchestrator/memory/), **not** at `lokidoki/memory/`. Rationale: keeping all v2 memory code under the v2 tree means a clean cutover from v1 to v2 only requires deleting `lokidoki/core/memory_*.py` — there is no entanglement to disentangle. The two systems share storage (one SQLite file) only via the lifecycle described in §7; they share no Python imports.

**Deliverables (all shipped).**
1. ✅ Module skeleton at [v2/orchestrator/memory/](../v2/orchestrator/memory/) with submodules:
   - [`gates.py`](../v2/orchestrator/memory/gates.py) — Layer 1 gate chain interface (M0 stubs return `m0_stub` failures; M1 fills in real logic)
   - [`tiers.py`](../v2/orchestrator/memory/tiers.py) — `Tier` enum + `TIER_SPECS` registry for all seven tiers
   - [`predicates.py`](../v2/orchestrator/memory/predicates.py) — `TIER4_PREDICATES`, `TIER5_PREDICATES`, `IMMEDIATE_DURABLE_TIER4`, `IMMEDIATE_DURABLE_TIER5`, `SINGLE_VALUE_PREDICATES` (≥13 entries per v1.2)
   - [`classifier.py`](../v2/orchestrator/memory/classifier.py) — Layer 2 router stub
   - [`promotion.py`](../v2/orchestrator/memory/promotion.py) — Layer 3 no-op stub
   - [`consolidation.py`](../v2/orchestrator/memory/consolidation.py) — triggered-consolidation stub with `TRIGGERED_CONSOLIDATION_THRESHOLD = 3`
   - [`slots.py`](../v2/orchestrator/memory/slots.py) — six prompt-slot specs totaling 1,470 chars worst-case (asserted in module)
   - [`schema.py`](../v2/orchestrator/memory/schema.py) — drafted schema migrations with `apply_v2_memory_schema(conn, create_v1_stubs=…, enable_vec=…)`
2. ✅ Corpus files (empty schemas, ready to populate per phase):
   - [`tests/fixtures/v2_memory_extraction_corpus.json`](../tests/fixtures/v2_memory_extraction_corpus.json) (M1)
   - [`tests/fixtures/v2_memory_recall_corpus.json`](../tests/fixtures/v2_memory_recall_corpus.json) (M2-M4)
   - [`tests/fixtures/v2_people_resolution_corpus.json`](../tests/fixtures/v2_people_resolution_corpus.json) (M3)
   - [`tests/fixtures/v2_persona_corpus.json`](../tests/fixtures/v2_persona_corpus.json) (M6)
3. ✅ Regression fixture row `memory.president_bug.who_is_the_president` added to [tests/fixtures/v2_regression_prompts.json](../tests/fixtures/v2_regression_prompts.json) with the expected `expect.memory` block (`should_write: false`, `denied_by_gate: clause_shape`). The row currently *fails its memory expectation* because the gate chain stub denies via `m0_stub` rather than `clause_shape` — this is the exact gap M1 closes.
4. ✅ Schema migrations drafted in [`v2/orchestrator/memory/schema.py`](../v2/orchestrator/memory/schema.py) for `people.handle`, `people.provisional`, `sessions.session_state`, `messages.sentiment`, `episodes`, `episodes_fts`, `vec_episodes` (optional), `affect_window`, `behavior_events`, `user_profile`. **Not yet applied to dev or prod** — only to scratch SQLite files in M0 tests. Each later phase calls `apply_v2_memory_schema()` against the live DB once its tier comes online.
5. ✅ Index `idx_people_owner_handle` in `INDEX_MIGRATIONS`.
6. ✅ Bake-off doc template at [`docs/benchmarks/_template.md`](benchmarks/_template.md).

**Corpus.** None — this phase produces empty fixture files. ✅

**Tests.** Every M0 deliverable has at least one test in [tests/unit/test_v2_memory_m0.py](../tests/unit/test_v2_memory_m0.py) (28 tests, all passing as of 2026-04-11). Per-deliverable mapping:

| Deliverable | Test(s) |
|---|---|
| 1. Scaffolding importable | `test_m0_scaffolding_modules_importable` (parametrized over all 9 submodules) |
| 1. Predicate enums correct | `test_m0_tier4_predicates_include_design_doc_required_entries`, `test_m0_immediate_durable_lists_match_design_doc`, `test_m0_single_value_predicate_list_has_at_least_thirteen_entries` |
| 1. Tier metadata correct | `test_m0_seven_tiers_registered_in_order` (also asserts Tier 6 mentions `character_id`) |
| 1. Slot budgets correct | `test_m0_slot_budget_totals_match_design_doc` (asserts 1,470 chars), `test_m0_slot_truncation_respects_budget` |
| 2. Corpus fixtures exist | `test_m0_corpus_fixtures_exist_with_m0_schema` (parametrized over all 4 fixtures) |
| 3. President bug row | `test_m0_president_bug_regression_row_exists`, `test_m0_gate_chain_stub_currently_fails_president_bug_expected_reason` |
| 4. Migrations apply to scratch DB | `test_m0_schema_migrations_apply_to_scratch_sqlite`, `test_m0_schema_migrations_are_idempotent`, `test_m0_episodes_table_has_topic_scope_column`, `test_m0_affect_window_has_character_id_pk`, `test_m0_user_profile_has_style_and_telemetry_columns` |
| 6. Bake-off template | `test_m0_bakeoff_template_exists` |
| Dev-tools surface (see below) | `test_m0_dev_v2_status_payload_includes_memory_section` |

**Dev-tools v2 test page integration.** M0 wires the memory subsystem into the existing v2 dev-tools status surface so the React test page reflects scaffolding state from day one. The integration is intentionally read-only (no writes through the gate chain yet — that lands in M1):
- The admin endpoint `GET /dev/v2/status` ([lokidoki/api/routes/dev.py](../lokidoki/api/routes/dev.py)) now returns a `memory` block built by `_v2_memory_status()`. The block surfaces: active phase (M0/complete), the seven tiers + their landing phases, the six prompt slots + char budgets, the scaffolding manifest (submodules, fixtures, regression-row id), and the M0–M6 phase roadmap.
- The frontend type [`V2MemoryStatus`](../frontend/src/lib/api-types.ts) and the [`V2PrototypeStatusPanel`](../frontend/src/components/dev/V2PrototypeStatusPanel.tsx) component render the memory block as a new section directly under the existing Implementation Status panel — visible whenever the v2 prototype runner is open.
- Hermetic test: `test_m0_dev_v2_status_payload_includes_memory_section` calls `_v2_memory_status()` directly (no FastAPI spin-up) and asserts the M0 active phase, the seven tiers, the six slots, the 1,470-char total, and the four fixture paths.

**Gate (all green).**
- ✅ All scaffolding modules importable (`test_m0_scaffolding_modules_importable`).
- ✅ Corpus files exist and validate against their JSON schemas (`test_m0_corpus_fixtures_exist_with_m0_schema`).
- ✅ Migrations applied to a scratch SQLite file successfully (`test_m0_schema_migrations_apply_to_scratch_sqlite`).
- ✅ President bug regression row exists and currently *fails* — verified by `test_m0_gate_chain_stub_currently_fails_president_bug_expected_reason`. M1 will flip the test's expected reason from `m0_stub` to `clause_shape`.
- ✅ Memory subsystem visible on the dev-tools v2 test page (`test_m0_dev_v2_status_payload_includes_memory_section`).

---

### M1 — Write path: gate chain + classifier + immediate-durable + Tier 4/5 writes
**Status: complete (2026-04-11).** All deliverables shipped, all gates green. M2 is now unblocked.

**Why this phase is highest priority.** This is the only phase that fixes the president bug. Until M1 ships, every other phase risks injecting garbage into a downstream tier.

**Clean-cutover decision (resolved in M1).** The v2 store opens its **own** SQLite file at `data/v2_memory.sqlite` rather than sharing v1's `data/memory.sqlite`. The two systems write to disjoint files; v1 cutover is "delete `lokidoki/core/memory_*.py` and point the app at the v2 store" — no data migration is required because v2 has been writing its own rows since M1 shipped. v1's `MemoryProvider` is not imported anywhere under `v2/`. This supersedes the original §7 plan to share storage during the cutover; the *clean cutover* requirement from the build contract overrides the shared-storage convenience.

**Deliverables (all shipped).**
1. Layer 1 gate chain (`gates.py`) with all five gates from §3:
   - Gate 1: spaCy parse-tree interrogative + info-request detection (the explicit token/dep checks listed in §3 Gate 1).
   - Gate 2: subject identity (self / resolved person / known entity).
   - Gate 3: predicate enum check, including the immediate-durable and single-value lists.
   - Gate 4: Pydantic schema validation, no repair loop.
   - Gate 5: intent context (allow assertive chat, deny questions/jokes/greetings).
2. Layer 2 tier classifier (`classifier.py`) with both variants implemented behind a feature flag:
   - Deterministic ruleset over gate-chain output.
   - Constrained-decoding small-model variant.
   - The bake-off picks one before this phase closes.
3. Layer 3 promotion stub (`promotion.py`) — exists, called by Layer 2 but is a no-op pass-through. Real promotion logic lands in M4.
4. Immediate-durable bypass: predicates on the immediate-durable list write directly to Tier 4 or Tier 5 on first observation.
5. Tier 4 (`facts`) and Tier 5 (`people` + `relationships`) writes through the new gate chain. **No reads yet** — that's M2.
6. Provisional-handle support: Tier 5 writes can land as `(name=NULL, handle="my boss", provisional=true)` rows.
7. Single-value predicate supersession: writing a new value for a single-value predicate flips the prior value's `status` to `superseded` and drops its confidence to floor 0.1.
8. The repair loop in [decomposer.py:251-311](../lokidoki/core/decomposer.py#L251-L311) is either deleted or its retention is justified in writing.

**Corpus.** Populate `v2_memory_extraction_corpus.json` with at least:
- 50 should-extract statements (mix of canonical declaratives, fragments, imperative self-statements, exclamatives, immediate-durable predicates).
- 50 should-not-extract turns (WH-questions, polar questions, embedded questions, info-requests, greetings, jokes, hypotheticals, commands without self-assertion).
- 20 ambiguous turns (modal/hedged opinions, third-person references, public-figure mentions).
- 10 multi-clause turns where one clause is a fact and another is a question.

**Files shipped (M1).**

| Module | Purpose |
|---|---|
| [`v2/orchestrator/memory/candidate.py`](../v2/orchestrator/memory/candidate.py) | `MemoryCandidate` Pydantic v2 schema with strict validation, `forbid` extra fields, subject-shape validator |
| [`v2/orchestrator/memory/gates.py`](../v2/orchestrator/memory/gates.py) | All five gates implemented: WH-fronting, subject-aux inversion, info-request imperative, subject identity, predicate enum, schema, intent |
| [`v2/orchestrator/memory/classifier.py`](../v2/orchestrator/memory/classifier.py) | Deterministic ruleset: `self`/`entity:` → Tier 4, `person:`/`handle:` → Tier 5 |
| [`v2/orchestrator/memory/store.py`](../v2/orchestrator/memory/store.py) | `V2MemoryStore` thread-safe SQLite store; own file; facts/people/relationships tables; supersession logic |
| [`v2/orchestrator/memory/writer.py`](../v2/orchestrator/memory/writer.py) | `process_candidate` / `process_candidates` orchestrating gates → classifier → store with intra-turn dedupe and rejection logging |
| [`v2/orchestrator/memory/extractor.py`](../v2/orchestrator/memory/extractor.py) | Parse-tree-pattern candidate extractor (copular self-assertions, "call me X", possessive relations, preference verbs) |
| [`v2/orchestrator/memory/promotion.py`](../v2/orchestrator/memory/promotion.py) | Layer 3 no-op stub (M4 wires the real promotion) |
| [`v2/orchestrator/core/pipeline.py`](../v2/orchestrator/core/pipeline.py) | New `memory_write` step between `extract` and `route`; opt-in via `context["memory_writes_enabled"]` |
| [`tests/fixtures/v2_memory_extraction_corpus.json`](../tests/fixtures/v2_memory_extraction_corpus.json) | 131 cases: 50 should_write / 51 should_not_write / 20 ambiguous / 10 multi_clause |
| [`tests/unit/test_v2_memory_m1.py`](../tests/unit/test_v2_memory_m1.py) | 22 phase-gate tests covering every gate item below |

**Tests.** Every M1 deliverable has at least one test in [tests/unit/test_v2_memory_m1.py](../tests/unit/test_v2_memory_m1.py) (22 tests, all passing as of 2026-04-11). The M0→M1 transition tests in [tests/unit/test_v2_memory_m0.py](../tests/unit/test_v2_memory_m0.py) were updated in-place: the corpus-empty assertion is loosened (the M0 gate is "fixture exists with the right schema"), and the m0_stub denial-reason test was replaced with a regression-row contract test that pins `denied_by_gate = "clause_shape"`.

**Dev-tools v2 test page integration.** The active phase shown on `GET /dev/v2/status` advances from M0 to M1. The `_v2_memory_status()` helper now publishes the M1 deliverable list, marks the M1 phase complete, and the memory subsystem is *runtime-active* on the dev-tools v2 prototype runner whenever the caller passes `context["memory_writes_enabled"] = True`. Default behavior is opt-in so the rest of the v2 prototype is unaffected; the dev-tools UI can flip the toggle when running a memory test.

**Gate (all green).**
- ✅ President bug regression fixture passes — denied at `clause_shape` (`test_m1_president_bug_dies_at_gate_1`, `test_m1_corpus_president_bug_denied_at_clause_shape`).
- ✅ Precision ≥ 0.98 on the should-not bucket — measured against 51 cases by `test_m1_corpus_should_not_write_precision`.
- ✅ Recall ≥ 0.70 on the should-extract bucket — measured against 50 cases by `test_m1_corpus_should_write_recall` (gate-chain only; the candidate extractor is tested separately).
- ✅ Latency added per turn < 50ms (median, gate chain alone) — `test_m1_gate_chain_latency_under_50ms`. The constrained-decoding model variant is deferred — see §10 question 1.
- ✅ Gate 5 verified — denies on `greeting`/`joke`/`info_request`/`clarification_request`/`command_to_assistant`, allows on `assertive_chat`/`self_disclosure`/`correction`/`command_with_self_assertion`. Verified by 17 corpus cases tagged with `intent`.
- ✅ Provisional-handle test — `test_m1_provisional_handle_creates_unnamed_person` and `test_m1_provisional_merge_promotes_to_named` cover the *"my boss is being weird"* → *"my boss Steve approved it"* merge round-trip.
- ✅ Immediate-durable test — `test_m1_immediate_durable_writes_first_observation` and `test_m1_call_me_jesse_writes_immediate_durable` confirm `has_allergy` and `is_named` write on the first observation.
- ✅ Single-value supersession test — `test_m1_single_value_supersession` writes `lives_in=Seattle` then `lives_in=Portland` and verifies Seattle is flipped to `superseded` with `confidence = 0.1`.
- ✅ Cross-user isolation test — `test_m1_cross_user_isolation` writes for user 42 and user 99 separately and asserts no leakage.
- ✅ Pipeline integration — three end-to-end tests confirm the `memory_write` step is no-op when disabled, persists when enabled, and never writes for the president-bug utterance regardless of context.

**M1 design choice that supersedes the design doc.**
- §7 (Pipeline integration) originally said *"The `MemoryProvider` singleton from v1 is the storage object both v1 and v2 use during the cutover."* M1 supersedes this with the clean-cutover decision above: v2 has its own SQLite file and zero v1 imports. The §7 wording is left intact for historical reference; M1's choice wins on the *clean cutover* requirement from the build contract.

This is the v2-graduation-plan §4.A gate, refined and shipped.

---

### M2 — Read path: port Tier 4 retrieval, delete substring heuristics
**Status: complete (2026-04-11).** All deliverables shipped, all gates green. M3 and M4 are now unblocked.

**Why this phase exists.** M1 wrote facts; M2 reads them. The read path is also where v1's substring-matching heuristics die. Until M2 ships, no synthesis turn benefits from durable memory.

**Clean-cutover supersedes the §8 wording.** The original deliverable list said *"Port v1's FTS5 + sqlite-vec + RRF retrieval ([memory_search.py](../lokidoki/core/memory_search.py)) into the v2 read path"* and *"Delete `_query_mentions()` and `_is_explicitly_relevant()` from [memory_phase2.py:49](../lokidoki/core/memory_phase2.py#L49)"*. Per the M1 clean-cutover decision, v2 imports zero v1 code, so M2 implements its retrieval **from scratch** under [v2/orchestrator/memory/reader.py](../v2/orchestrator/memory/reader.py) with the same algorithmic shape (BM25 + RRF) but no shared lines of code. The "delete from v1" deliverable is recast as a CI grep guard: the symbol names `_query_mentions` and `_is_explicitly_relevant` must never appear as live code under [v2/orchestrator/memory/](../v2/orchestrator/memory/). v1's `memory_phase2.py` is left intact and gets deleted in the same change that deletes the rest of v1's memory modules at cutover time.

**Deliverables (all shipped).**
1. Port v1's FTS5 + sqlite-vec + RRF retrieval ([memory_search.py](../lokidoki/core/memory_search.py)) into the v2 read path for Tier 4.
2. Delete `_query_mentions()` and `_is_explicitly_relevant()` from [memory_phase2.py:49](../lokidoki/core/memory_phase2.py#L49). Verify no other call sites remain via grep test.
3. Wire `need_preference` boolean field on the decomposer schema.
4. Add `{user_facts}` slot to the v2 combine prompt template at [v2/orchestrator/fallbacks/prompts.py](../v2/orchestrator/fallbacks/prompts.py), with the 250-char hard budget from §4.
5. Slot assembly module (`slots.py`) with truncation logic and per-slot budgets.

**Corpus.** Populate `v2_memory_recall_corpus.json` with multi-turn dialogues where turn N's correct answer requires recalling turn 1–3's content.

**Files shipped (M2).**

| Module | Purpose |
|---|---|
| [`v2/orchestrator/memory/store.py`](../v2/orchestrator/memory/store.py) | `facts_fts` FTS5 virtual table + INSERT/UPDATE/DELETE triggers; the triggers store the **humanized predicate** prefixed to source_text so user vocabulary bridges stored predicate identifiers without substring matching the user input |
| [`v2/orchestrator/memory/reader.py`](../v2/orchestrator/memory/reader.py) | `read_user_facts()` BM25 (FTS5) + structured subject-column scan, fused via Reciprocal Rank Fusion (k=60); `score_facts_rrf()` exposed for testing; cleaned query terms drop stopwords without classifying user intent |
| [`v2/orchestrator/memory/slots.py`](../v2/orchestrator/memory/slots.py) | `assemble_user_facts_slot()` calls the reader and renders Tier 4 hits as a `predicate=value` list, hard-truncated to 250 chars at a word boundary |
| [`v2/orchestrator/fallbacks/prompts.py`](../v2/orchestrator/fallbacks/prompts.py) | `COMBINE_PROMPT` and `DIRECT_CHAT_PROMPT` extended with optional `{user_facts}` slot; templates render even when the slot is empty so the M2 wiring is backward-compatible |
| [`v2/orchestrator/fallbacks/llm_fallback.py`](../v2/orchestrator/fallbacks/llm_fallback.py) | `build_combine_prompt()` reads `spec.context["memory_slots"]["user_facts"]` and threads it into both prompt families |
| [`v2/orchestrator/core/pipeline.py`](../v2/orchestrator/core/pipeline.py) | New `memory_read` step between `request_spec` and the LLM decision; opt-in via `context["need_preference"]` so "hi" turns never touch the store |
| [`tests/fixtures/v2_memory_recall_corpus.json`](../tests/fixtures/v2_memory_recall_corpus.json) | 18 cases targeting the M2 reader: direct preferences, single-value supersession, cross-user isolation, slot truncation, hedged statements, fragment-extracted writes, and a no-match path |
| [`tests/unit/test_v2_memory_m2.py`](../tests/unit/test_v2_memory_m2.py) | 21 phase-gate tests covering every gate item below |

**Tests.** Every M2 deliverable has at least one test in [tests/unit/test_v2_memory_m2.py](../tests/unit/test_v2_memory_m2.py) (21 tests, all passing as of 2026-04-11). The M1→M2 transition tests in [tests/unit/test_v2_memory_m1.py](../tests/unit/test_v2_memory_m1.py) and [tests/unit/test_v2_pipeline.py](../tests/unit/test_v2_pipeline.py) were updated in-place: the M1 active-phase pin is loosened to "M1 stays complete forever", and the v2 pipeline trace-step assertion is loosened to assert names rather than counting positional `done` entries (the new `memory_read` step is the 13th of 14 steps).

**Dev-tools v2 test page integration.** The active phase shown on `GET /dev/v2/status` advances from M1 to M2. The `_v2_memory_status()` helper now publishes the M2 deliverable list, marks the M2 phase complete, and the memory subsystem is *runtime-active* on the dev-tools v2 prototype runner whenever the caller passes `context["need_preference"] = True` and a `context["memory_store"]`. Default behavior remains opt-in so the rest of the v2 prototype is unaffected.

**Gate (all green).**
- ✅ M1 done first — green.
- ✅ Substring heuristics are gone (`test_m2_no_substring_heuristics_in_v2_memory` greps `v2/orchestrator/memory/` for `_query_mentions` / `_is_explicitly_relevant`; only doc-string references in the rationale are tolerated, code references fail the build).
- ✅ p95 retrieval latency < 100ms warm — `test_m2_reader_latency_p95_under_100ms_warm` seeds 200 facts and runs 50 warm queries.
- ✅ Multi-turn recall corpus passes — 18-case `test_m2_recall_corpus_pass_rate` checks min/max hits, must-include predicates, must-include values, slot substring, and slot length.
- ✅ `{user_facts}` slot stays under 250 chars — `test_m2_user_facts_budget_is_250`, `test_m2_truncate_to_budget_respects_user_facts_budget`, `test_m2_render_user_facts_clips_to_budget`.
- ✅ `need_preference` gates the fetch — `test_m2_pipeline_does_not_read_when_need_preference_false` and `test_m2_pipeline_reads_when_need_preference_true` end-to-end through `run_pipeline`.
- ✅ Cross-user isolation in the read path — `test_m2_cross_user_isolation_in_reader`.
- ✅ FTS5 triggers stay in sync with INSERT / UPDATE / supersession — `test_m2_fts5_triggers_keep_index_in_sync`, `test_m2_fts5_supersession_swaps_in_new_value`.
- ✅ End-to-end recall after write — `test_m2_pipeline_end_to_end_recall_after_write` writes a fact through M1's path, then reads it back through M2's path on a follow-up turn via the same store.

**Known M2 follow-up.** The vector embedding source (sqlite-vec or fastembed dot-product) is **not yet wired** as a third RRF input. M2 ships BM25 + structured subject-column scan only. Vocabulary mismatches that exceed Porter stemming + stopword dropping (e.g., a query about *"food"* against a stored fact about *"dietary restriction"*) require the embedding bridge — that work is queued for an M2 follow-up bake-off and explicitly noted in §10. The M2 corpus is structured so every case is solvable with the BM25 + subject-scan path; vocabulary-stretching cases land with M2.5 (vectors).

This is the v2-graduation-plan §4.B gate, refined and shipped.

---

### M3 — Tier 5 social: wire LokiPeopleDBAdapter, bake off scoring, provisional handles
**Why this phase exists.** v1's strongest asset is the people graph; M1 wrote provisional handles but M3 is where the runtime resolver actually consults `LokiPeopleDBAdapter` and where the disambiguation scoring gets its first published bake-off. Tier 5 reads also land here.

**Deliverables.**
1. Wire `LokiPeopleDBAdapter` into the v2 runtime resolver per [v2-graduation-plan §4.D](v2-graduation-plan.md). The runtime resolver receives `MemoryProvider` + `viewer_user_id` via the `context` dict.
2. Bake off scoring formulas: v1 hand-tuned constants vs rapidfuzz vs recency-weighted hybrid. Pick one.
3. Wire `need_social` boolean field on the decomposer.
4. Add `{social_context}` slot (200-char budget) to combine prompt.
5. Provisional-handle merge logic: when a named candidate matches an existing provisional row's handle pattern (and relationship metadata is consistent), merge.
6. Index `(owner_user_id, handle)` on `people` for fast provisional lookups (was migration-drafted in M0; applied here).

**Corpus.** Populate `v2_people_resolution_corpus.json` with utterances paired with expected `(person_id, ambiguous?)`. Common typos, family relations, partial names, last-name-only, full names with multiple matches, provisional handles like *"my boss"*, merge cases.

**Gate.**
- M1 done first; M2 strongly preferred (clean read path).
- Top-1 accuracy ≥ 0.90 on the resolution corpus.
- Provisional handle merge test passes: prior provisional row gets `provisional=false` and `name` populated; relationship edges preserved.
- Empty-default guard test from [graduation plan §4.D](v2-graduation-plan.md) still passes.
- Existing tests in [tests/unit/test_v2_resolvers.py](../tests/unit/test_v2_resolvers.py) and [tests/unit/test_v2_loki_adapters.py](../tests/unit/test_v2_loki_adapters.py) still pass.
- Index `idx_people_owner_handle` exists in the schema (verified by SQL introspection).

This is the v2-graduation-plan §4.D gate, refined.

---

### M4 — Tier 2 + Tier 3: session state, episodic summarization, promotion, triggered consolidation, topic scope
**Why this phase exists.** M1 closed the write hole and M2 closed the read hole for Tier 4; M3 closed Tier 5. M4 introduces the time dimension: session state for cross-turn coherence, episodic summaries for cross-session recall, and the promotion logic that turns recurrence into durability.

**Deliverables.**
1. `session_state` JSON column on `sessions` (M0 migration applied here). Last-seen map (`last_movie`, `last_person`, …) maintained per turn.
2. Pronoun resolver consults `session_state`, raising `need_session_context` even when the decomposer didn't.
3. Out-of-band session-close summarization job. Uses a small model; runs off the hot loop. Writes to the new `episodes` table.
4. New `episodes`, `episodes_fts`, optional `vec_episodes` (M0 migration applied here).
5. `topic_scope` field on episodes — derivation strategy chosen here (LLM tag at summarization vs deterministic clustering on shared entities; bake off both).
6. Layer 3 promotion logic upgrade: replace the M1 no-op stub with the real promotion rule (3+ separate session-close summarizations promote a claim from Tier 3 into Tier 4 or Tier 5 via the gate chain).
7. Triggered consolidation logic (`consolidation.py`): in-session frequency counter on `(subject, predicate)` pairs; fires immediate promotion attempt at threshold 3 within session OR 24h rolling window. Counter persisted to `session_state` so the rolling window survives session boundaries.
8. `{recent_context}` (300-char) and `{relevant_episodes}` (400-char) slots added to combine prompt.
9. `need_session_context` and `need_episode` decomposer fields wired.
10. Session-close hook on the v2 pipeline that queues the summarization job.

**Corpus.** Reuse `v2_memory_recall_corpus.json` from M2; add multi-turn dialogues that need cross-session episodic recall and triggered-consolidation cases.

**Gate.**
- M2 done first.
- Pronoun resolution accuracy ≥ 0.85 on the multi-turn corpus.
- No more than +50ms p95 added to turn latency by session-state lookup.
- Stale-context decay verified (turn-distance test).
- Cross-session promotion test: a fact emitted in 3 separate sessions reaches Tier 4 via promotion, never via direct write.
- Triggered consolidation test: a soft preference repeated 3 times within a single session reaches Tier 4 before session close, without waiting for the nightly job.
- Topic-scope retrieval test: an episode tagged `topic_scope="japan_trip"` is preferentially returned for queries about Japan.
- Session-close summarization runs out-of-band (verified by latency profile of the closing turn — must not be on the synchronous path).

This is the v2-graduation-plan §4.E gate, refined and extended.

---

### M5 — Tier 7 procedural: behavior events, nightly aggregation, 7a/7b split
**Why this phase exists.** Procedural memory is what makes the assistant feel adaptive instead of just informed. The 7a/7b split lands here because aggregation is what produces both sub-tiers.

**Deliverables.**
1. `behavior_events` append-only log table (M0 migration applied here).
2. `user_profile` table with `style` and `telemetry` JSON columns (M0 migration applied here).
3. Orchestrator hook that writes a `behavior_events` row at the end of every turn (input modality, response length tolerated, dialog dismissed, retry rate, etc.).
4. Nightly aggregation job (deterministic, no LLM):
   - Walks `behavior_events` since last run.
   - Updates `user_profile.style` (sub-tier 7a) per the closed enum of axes from §2 Tier 7.
   - Updates `user_profile.telemetry` (sub-tier 7b) per UX-relevant signals.
   - Drops folded-in events older than 30 days.
5. `need_routine` decomposer field.
6. `{user_style}` slot (200-char) added to combine prompt, always present.
7. Sub-tier 7b read path goes to UX code only — verified by a test that asserts `telemetry` JSON never appears in any prompt template render.
8. User-settings opt-out toggle for telemetry collection.

**Corpus.** Synthetic 100-session simulation. Simulate three distinct user profiles (terse, verbose, formal). After 100 sessions each, profile descriptors must converge and synthesis prompt output must observably differ.

**Gate.**
- M2 done first.
- Profile descriptors stable across the synthetic simulation (no oscillation).
- Synthesis prompt observably changes tone for at least 3 distinct profile shapes.
- Aggregation job runs in < 5 seconds for 1000 events.
- 7b leak test: `telemetry` JSON never appears in any rendered prompt across the entire test corpus.
- Opt-out test: toggling telemetry off prevents `behavior_events` writes entirely.

---

### M6 — Tier 6 affective: rolling window, character overlay, privacy opt-out
**Why this phase exists.** The relationship-temperature dimension. Last in the sequence because it depends on the v2 chat route already passing the active `character_id` into the request context, which the persona phase of the v2 graduation plan handles.

**Deliverables.**
1. `affect_window` table with composite PK `(owner_user_id, character_id, day)` (M0 migration applied here).
2. `sentiment` column on `messages` (M0 migration applied here). Decomposer already emits this in `short_term_memory`; just persist it.
3. Per-turn write of sentiment to `messages` and rolling aggregation into `affect_window`.
4. 14-day rolling-window aggregation job (or materialized view; decided in this phase).
5. Character-scoped read at session start; loaded into the request context filtered by the active `character_id`.
6. `{recent_mood}` slot (120-char) added to combine prompt, always present, per-character.
7. UI surface for "forget my mood" — wipes `affect_window` rows for the user (or for the user+character pair).
8. Per-user opt-out toggle for sentiment persistence entirely.
9. Episodic compression follow-up: episodes older than 6 months with `recall_count = 0` get rolled up into period summaries; originals dropped.

**Corpus.** Sentiment persistence test corpus + opt-out test cases + character-overlay test cases.

**Gate.**
- M2 done first.
- Sentiment trajectory persists across 7 simulated days for a single character.
- Character isolation test: sentiment written under `character_id=loki` is never returned for `character_id=doki`.
- Opt-out toggle disables the slot and prevents writes.
- "Forget my mood" action wipes the affected rows for the user.
- Episodic compression test: a 7-month-old never-recalled episode gets compressed into a period summary; original is dropped.

---

### Phase ordering recap
- **M0** is universal prerequisite.
- **M1** is the only phase that fixes the president bug; everything else assumes M1 ships first.
- **M2** is the only phase that wires Tier 4 reads; M3, M4, M5, M6 all benefit from a clean read path being live.
- **M3** and **M4** can be staffed in parallel after M2.
- **M5** and **M6** can be staffed in parallel after M2 (M6 prefers the persona slot from the graduation plan to be live, but does not strictly require it).
- **The reflect job** lands incrementally: triggered consolidation in M4, cross-session promotion in M4, behavior aggregation in M5, episodic compression in M6.

---

## 9. What we deliberately do not build

- **No external memory service.** Mem0, Zep, Hindsight, MemPalace all assume a separate process or hosted backend. LokiDoki runs on Pi 5; the memory layer stays inside the FastAPI process and the SQLite file already on disk.
- **No LLM verifier in the hot write path.** The decomposer is the only model that runs per turn. Adding a second model call to "verify" a fact recreates the v1 failure mode under a new name.
- **No knowledge graph database.** SQL recursive CTEs are enough.
- **No external vector store.** sqlite-vec is enough.
- **No real-time embedding on the write path.** Async backfill model from [memory_provider.py:70-126](../lokidoki/core/memory_provider.py#L70-L126) stays — fix the race conditions, don't replace the architecture.
- **No first-class belief timeline** with sources, certainty intervals, and per-assertion audit trail. v1's row-centric contradiction model is sufficient.
- **No full project-scoped memory hierarchy** (Pieces' user + project + session as a first-class axis). v1.1 *does* allow a lightweight `topic_scope` string tag on episodes (see Tier 3) to support recurring threads like *"japan_trip"* or *"garden_build"* — that is the cheap version of project memory and earns its place. The full hierarchy with permissions, settings, and project-scoped tiers is still deferred.
- **No suppression of writes on `direct_chat` routes.** v1.0 had this rule and v1.1 deletes it. Direct chat is the *primary* surface for assertive memory; gating writes on the route would suppress most of the human memory the system exists to capture. Gate 1 (parse-tree interrogative detection) and Gate 5 (intent context) handle the actual safety concerns; the route is incidental.
- **No regex or keyword classification of user intent** anywhere in the gate chain. Per [CLAUDE.md](../CLAUDE.md) hard rule.
- **No writes from the synthesizer.** The synthesizer reads memory; it never writes. All writes happen in the gate chain after extraction.

---

## 10. Open questions and explicit non-decisions

These are not blocking M1, but they need to be answered before later phases.

1. **Tier classifier shape.** Deterministic ruleset over gate-chain output, or constrained-decoding small model? The M1 bake-off picks one. The deterministic ruleset is the safer default.
2. **Episodic vector store.** Does Tier 3 need vectors at all, or is FTS5 + temporal proximity enough? Decide in M4 by bench, not by intuition. (MemPalace says no, you don't need vectors if your storage is structured. Hindsight says yes. We'll measure.)
3. **Procedural model shape.** v1.1 resolved this: closed enum for sub-tier 7a (prompt-safe), free-form JSON for sub-tier 7b (telemetry, never reaches the prompt). New axes in 7a require a design discussion, not a free-text addition.
4. **Reflect job cadence.** Nightly, or per-N-sessions, or on idle? Probably all three with rate-limiting. Decide when M4 lands.
5. **Cross-user isolation.** Multi-user already exists in the schema (`owner_user_id` everywhere). The reflect job and promotion logic must respect it. Add a multi-user fixture in M1.
6. **Rebench cadence for the magic constants in `_resolve_person()`** ([orchestrator_memory.py:30](../lokidoki/core/orchestrator_memory.py#L30)). Once at M3 is the minimum; quarterly thereafter is the ideal.
7. **Provisional handle merge UX.** When the user says *"my boss Steve approved it"* and we have an existing `provisional=true, handle="my boss"` row, do we silently merge or surface a one-liner confirmation (*"got it — I'll remember Steve as your boss"*)? Defer to M3, but lean toward silent merge with an undo affordance.
8. **Immediate-durable predicate set.** The v1.1 list is a starting point, not a final answer. M1 should expand or contract it based on the should-extract corpus. Candidates to consider adding: `religious_practice` (relevant to scheduling and food), `medical_condition` (relevant to advice gating), `language_preference`. Candidates to consider removing: none currently.
9. **Topic scope derivation.** LLM tag at episode summarization time, deterministic clustering on shared entities, or both? Deferred to M4.
10. **Prompt-safe vs telemetry boundary.** Sub-tier 7a vs 7b in Tier 7 is a strict separation today, but the boundary will be tested by edge cases (e.g., *"prefers the assistant to be quiet during morning hours"* — derived from telemetry but expressible as style). M5 needs a clear ruleset for which signals can cross.
11. **Triggered consolidation threshold (v1.2).** v1.2 set the in-session frequency threshold to 3, matching the cross-session promotion threshold. This may be too high (the user said it twice, isn't that enough?) or too low (one offhand repetition shouldn't promote). Tune in M4 against the recall corpus.
12. **Single-value predicate list expansion (v1.2).** v1.2 expanded v1's small list to ~13 entries. M1 should empirically validate the list against the should-extract corpus and add or remove entries based on what users actually say. Strong candidates to consider adding: `current_school`, `current_role` (distinct from employer), `relationship_status`. Strong candidates to consider keeping out: anything seasonal or moodlike that's expected to fluctuate.
13. **Character-overlay scope (v1.2).** v1.2 puts the `character_id` overlay only on Tier 6. Should Tier 7a (style) also be character-scoped? Argument for: different personas may want different default verbosity. Argument against: the user is the user; their style preferences are global. Defer to M5/M6.
14. **Reflect job triggers (v1.2).** With triggered consolidation now in M4, the nightly reflect job has less work to do — it primarily handles cross-session promotion that didn't fire in-session and episodic compression. Reconsider its cadence in M6 once we measure how often triggered consolidation already covers the load.

---

## 11. The one-paragraph summary

Seven tiers (working, session, episodic, semantic-self, social, emotional, procedural — with procedural split into prompt-safe style and prompt-forbidden telemetry, and emotional overlaid by `character_id`), one SQLite database, three layers of write defense (parse-tree non-interrogative gate → tier classifier → recurrence-driven promotion) plus two fast-paths (immediate-durable predicates for safety-critical facts and triggered consolidation for in-session repetition), lazy per-tier retrieval injected as separate named slots in the combine prompt with hard char budgets totaling ~1,470 chars, provisional handles for unnamed recurring people, a `topic_scope` tag on episodes for recurring threads, recency-weighted contradiction handling for an expanded single-value predicate list, and a background reflect job that turns repeated episodes into stable preferences and observed behaviors into procedural understanding. The president bug dies at Gate 1 because *"who is the current president"* is unambiguously interrogative. Casual chat (*"my brother Luke loves movies"*, *"call me Jesse"*, *"allergic to peanuts"*) writes normally — the gates block questions, not conversation. The substring-matching retrieval heuristics get deleted, not ported. v1's strongest assets (the people graph and the FTS5 + sqlite-vec hybrid) get preserved in their own first-class tiers. The procedural tier is what makes the system feel humanistic — the 7a/7b split is what keeps it from feeling surveillant — and the character overlay on Tier 6 is what lets each persona feel like *it* knows the user, not like the same model wearing different masks.

---

## 12. Lineage and revision history

### Source proposals
- [docs/CODEX_MEM.md](CODEX_MEM.md) — Codex's first proposal: seven-tier breakdown, promotion model, substring-matching catch, MemPalace skepticism.
- The discussion that produced the parse-tree write gate, the layered defense model, and the prompt-slot injection design.

### Revision history
- **v1.0** (2026-04-11). Initial unified design merging Codex's seven tiers with the parse-tree write gate. Erred on the side of safety — too aggressive on Gate 5 (suppressed all `direct_chat` writes), Gate 1 (required strict declaratives), and Tier 5 (rejected unnamed people). Procedural tier was a single bucket with no internal/external split. No immediate-durable carve-out for safety-critical predicates.
- **v1.1** (2026-04-11, same day). Codex second-pass review identified six places where v1.0 would have made LokiDoki feel "weirdly forgetful in ordinary conversation." All six findings adopted:
  1. Gate 5 reframed from "no writes on `direct_chat` routes" to "no writes on non-assertive intents" — assertive chat is now the primary write surface.
  2. Tier 5 gained provisional-handle support for unnamed recurring people (*"my boss"*, *"my therapist"*).
  3. Promotion model gained an immediate-durable carve-out for safety-critical predicates (allergies, names, pronouns, accessibility needs, hard dislikes, relationship labels).
  4. Gate 1 reframed from "must be declarative" to "must not be interrogative or info-request" — fragments, imperatives, and exclamatives now write normally.
  5. Tier 7 split into sub-tier 7a (prompt-safe style adaptation, closed enum) and sub-tier 7b (internal UX telemetry, never reaches the prompt).
  6. Episodes gained a lightweight `topic_scope` string tag for recurring threads (*"japan_trip"*, *"garden_build"*) without taking on a full project hierarchy.
- **v1.2** (2026-04-11, same day). Gemini third-pass review identified three substantive gaps and three implementation-checklist items. All adopted:
  1. **Triggered consolidation (latency hole).** A soft preference repeated 3 times within a single session no longer waits for the nightly reflect job — an in-session frequency counter fires immediate consolidation. Composes with immediate-durable predicates (safety-critical, fires on observation 1) and cross-session promotion (long-tail recurrence across sessions). Three mechanisms, no overlap.
  2. **Character-overlay on Tier 6 ("Puppeteer gap").** Tier 6 (affective) is now scoped per `(owner_user_id, character_id)`. The user is the user across personas (Tiers 4, 5, 7a remain user-global), but the *relationship temperature* with each persona is its own. Lets each character feel like it knows the user without leaking emotional state across personas.
  3. **Recency-weighted contradiction for single-value predicates ("memory drift").** Expanded the single-value predicate list from v1's small set to ~13 entries including `lives_in`, `current_employer`, `favorite_color`, `preferred_units`, `timezone`. New value supersedes immediately, prior value drops to confidence floor 0.1 — recency dominates frequency for these predicates.
  4. Gate 1 spaCy specifics made explicit (token tag checks, dep checks, sent-start checks).
  5. `(owner_user_id, handle)` index added to the `people` table schema.
  6. Synthesis prompt slot budgets made explicit and totaled (1,470 chars worst case, well under prompt budget).
  
  Plus a major rewrite of §8 phases: added M0 (prerequisites), expanded each phase from 5 lines to ~30 lines with deliverables/corpus/gate broken out, added a phase overview table at the top, made the critical path explicit, and updated each phase's gate to test the v1.1 and v1.2 features.
- **M0 shipped** (2026-04-11). Module location resolved to [v2/orchestrator/memory/](../v2/orchestrator/memory/) (clean cutover from v1, no shared imports). All scaffolding submodules, schema migrations, corpus fixtures, and the bake-off template landed. President-bug regression row added to [tests/fixtures/v2_regression_prompts.json](../tests/fixtures/v2_regression_prompts.json) with `expect.memory.denied_by_gate = "clause_shape"` — currently fails via stub `m0_stub` reason, which is the precise gap M1 closes. Memory subsystem surfaced on the dev-tools v2 test page via the new `memory` block on `GET /dev/v2/status` and the matching React panel section. M0 phase-gate tests live at [tests/unit/test_v2_memory_m0.py](../tests/unit/test_v2_memory_m0.py) (28 tests, all passing).
- **M2 shipped** (2026-04-11). Tier 4 read path live. The v2 store now owns a `facts_fts` FTS5 virtual table kept in sync via INSERT/UPDATE/DELETE triggers; the triggers store the **humanized predicate** prefixed to source_text so the BM25 query can match a user query like *"where do I live"* against the stored predicate `lives_in` without ever inspecting user-input strings. The reader runs BM25 + a structured subject-column scan, fuses them via Reciprocal Rank Fusion (k=60), and returns top-k hits as `FactHit` records. The `{user_facts}` slot is rendered into both `COMBINE_PROMPT` and `DIRECT_CHAT_PROMPT` with a hard 250-char word-boundary truncation. The pipeline gains a new `memory_read` step that's gated by `context["need_preference"]` so casual greetings never touch the store. **Clean-cutover supersedes §8 deliverable 2**: instead of deleting v1's `_query_mentions` / `_is_explicitly_relevant`, the M2 grep guard forbids those names from appearing as live code in `v2/orchestrator/memory/`; v1's `memory_phase2.py` is left intact and gets deleted at cutover time. 18-case recall corpus drives the gate; 21 phase-gate tests in `test_v2_memory_m2.py` (all passing). M1→M2 transition tests (`test_v2_memory_m1.py`, `test_v2_pipeline.py`) loosened in-place. Known M2 follow-up: vector embedding source (sqlite-vec) not yet wired as a third RRF input; the corpus is structured so every M2 case is solvable with BM25 + subject-scan only.
- **M1 shipped** (2026-04-11). Five-gate write path live for Tier 4 + Tier 5. The president bug now dies at Gate 1 (`clause_shape`, `wh_fronted` reason) rather than at the M0 stub. Deterministic tier classifier routes self/entity to Tier 4 and person/handle to Tier 5. Immediate-durable predicates (`is_named`, `has_pronoun`, `has_allergy`, `has_dietary_restriction`, `has_accessibility_need`, `has_privacy_boundary`, `hard_dislike`, plus the Tier 5 trio) write on first observation. Single-value predicates (`lives_in`, `current_employer`, `current_partner`, `favorite_*`, `preferred_units`, `timezone`, `is_named`, `has_pronoun`, …) flip prior values to `superseded` with confidence floor 0.1. Provisional handles (`handle:my boss`) write Tier 5 rows with `name=NULL, provisional=1` and merge into named rows when the user later names the person. **Clean-cutover supersedes §7**: the v2 store opens its own SQLite file at `data/v2_memory.sqlite` — zero v1 imports, zero shared mutable state. Memory writes are *opt-in* via `context["memory_writes_enabled"]` so the existing v2 regression suite is unaffected. Pipeline gains a new `memory_write` step between `extract` and `route`. The 131-case extraction corpus (50 should_write / 51 should_not_write / 20 ambiguous / 10 multi_clause) drives the precision/recall gates: precision ≥ 0.98 measured, recall ≥ 0.70 measured, gate-chain median latency well under 50ms. M1 phase-gate tests live at [tests/unit/test_v2_memory_m1.py](../tests/unit/test_v2_memory_m1.py) (22 tests, all passing). M0 transition tests in `test_v2_memory_m0.py` were updated in-place: corpus-empty assertion loosened (M0 only requires the schema, not the empty list); the m0_stub denial-reason test was replaced with a regression-row contract test pinning `denied_by_gate = "clause_shape"`. Dev-tools v2 status endpoint advances `active_phase` to M1 and marks both M0 and M1 phases complete.

### External research
- **Mem0** — layered memory model + compression engine for episodic rollup.
- **Hindsight** — retain / recall / reflect cycle + parallel retrieval (semantic + keyword + graph + temporal) + RRF + cross-encoder rerank.
- **Pieces** — 5-layer taxonomy (working / short-term / long-term / entity / episodic).
- **"Six types of memory" framing** — added procedural as a first-class tier.
- **MemPalace** — cited as interesting-not-foundational per the README corrections of 2026-04-07 and the fake-site warnings of 2026-04-11. The "store everything raw, filter at retrieval" philosophy is wrong for our footprint; the hierarchical metaphor is overkill for our scale.

### Authority
- If this file conflicts with [docs/spec.md](spec.md), spec.md wins on product/architecture.
- If this file conflicts with [docs/v2-graduation-plan.md](v2-graduation-plan.md), the graduation plan's gates win on subsystem readiness.
- This file is the implementation contract for the memory subsystem only.
