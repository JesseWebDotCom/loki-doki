# CODEX Plan: Phased Rollout For LokiDoki’s Human, Accurate, Fast Chat System

## Summary
This plan is structured so each phase can be implemented in a separate Codex conversation with minimal carryover context.

Core architecture goals:
- deterministic response control through `ResponseSpec`
- sparse, high-value memory usage through retrieval buckets and budgets
- warmer and less repetitive replies through a deterministic `HumanizationPlanner`
- selective verification only on uncertain turns
- local-first execution, with helper libraries only where they deliver measurable gains

Global test policy for every phase:
- Every phase must test three things, not two:
  - effectiveness on the intended behavior
  - regression safety against existing behavior
  - performance impact on the real execution path
- Integration coverage must prefer the actual user path that ships:
  - drive the system through the chat HTTP route / SSE stream
  - when frontend behavior matters, include tests that exercise the real chat input box path rather than only calling lower-level helpers
- Test inputs must include realistic, messy, real-life user turns:
  - natural phrasing
  - pronouns and follow-ups
  - corrections
  - emotionally colored turns
  - current-data phrasing like "right now", "today", "latest"
  - decomposer / LLM-shaped examples taken from observed or representative production-style inputs, not only clean synthetic strings
- Performance validation is mandatory before marking a phase `completed`:
  - measure p50 and p95 latency on the real chat path
  - compare against the previous baseline or control
  - reject changes that improve quality but cause unjustified latency regressions
- Benchmark and eval runs must include:
  - offline corpus-style cases
  - end-to-end chat-path cases
  - at least one set of realistic multi-turn conversations

Status convention for every phase:
- `pending` = not started
- `in_progress` = currently being implemented
- `completed` = implemented and validated against exit criteria

Current overall status:
- Phase 0 is `completed`
- Phase 1 is `completed`
- Phase 2 is `completed`
- Phase 3 is `completed`
- Phase 4 is `completed`
- Phases 5-8 are `pending`

## Phase 0: Baseline, Instrumentation, Eval Harness, And Shadow Mode
Status:
- `completed`

### Goal
Create a reliable baseline and a test harness so every later phase can be measured against current behavior.

### Deliverables
- Per-turn trace logging for:
  - decomposition output
  - referent resolution result
  - retrieved memory candidates
  - selected injected memories
  - skill results
  - prompt sizes
  - response lane
  - phase latencies
- Fixed eval corpus covering:
  - greetings / gratitude
  - fact-sharing turns
  - emotional turns
  - people / relationship turns
  - current-data turns
  - recommendations
  - pronoun follow-ups
  - contradiction / correction turns
- Scoring rubric for:
  - answer-first behavior
  - non-echo behavior
  - memory relevance
  - repetition
  - grounding freshness
  - latency
- `ResponseSpec` shadow mode:
  - compute planned routing
  - do not enforce it yet
  - log current behavior vs planned behavior

### Tests
- Unit tests for trace artifact assembly
- Unit tests for eval fixture loading
- Integration test that one chat turn emits a complete trace record through the real chat route / SSE path
- Integration test that shadow-mode `ResponseSpec` logs a planned lane without affecting real routing on the shipped chat path
- Integration test corpus with realistic user-language examples, not only idealized prompts
- Regression test that existing chat behavior is unchanged
- Baseline latency benchmark on the real chat path using representative single-turn and multi-turn inputs

### Validation Metrics
- p50 / p95 end-to-end latency
- decomposer fallback rate
- empty-ask rate
- current memory mention frequency
- repeated-memory frequency
- stale-answer rate on current-data turns
- shadow-mode disagreement rate between current routing and planned routing

### Exit Criteria
- Eval suite is reproducible
- Baseline metrics are recorded
- Shadow-mode disagreements are captured and reviewable
- Real chat-path latency baseline exists for future phase comparisons

## Phase 1: ResponseSpec Control Plane And Fast-Path Mapping
Status:
- `completed`

### Goal
Make routing and reply behavior deterministic and centralized.

### Deliverables
- `ResponseSpec` implementation with:
  - `reply_mode`
  - `memory_mode`
  - `grounding_mode`
  - `followup_policy`
  - `style_mode`
  - `citation_policy`
- Reply lanes:
  - `grounded_direct`
  - `social_ack`
  - `full_synthesis`
- Explicit fast-path mapping:
  - keep `clarification` fast path
  - keep `capability_failure` fast path
  - absorb `verbatim` into `reply_mode="grounded_direct"`
  - absorb `grounded` into `reply_mode="grounded_direct"`
- Prompt budget guard:
  - pre-send prompt size estimate
  - hard ceiling at 80% of `num_ctx`
  - truncation order:
    1. lowest-scoring memory items
    2. older past-session messages
    3. lowest-value skill payload detail

### Tests
- Unit tests for `ResponseSpec` classification on representative turn types
- Unit tests for fast-path mapping rules
- Integration tests confirming:
  - simple grounded turns route to `grounded_direct` on the actual chat path
  - short fact-sharing turns route to `social_ack` on the actual chat path
  - mixed and reasoning turns route to `full_synthesis` on the actual chat path
- Prompt-budget tests confirming:
  - truncation occurs in the correct order
  - clarification hints and citation anchors are preserved
- Regression tests for current fast-path behavior that should survive unchanged
- Realistic LLM-input tests covering current-data phrasing, fact-sharing, corrections, and pronoun follow-ups
- Performance benchmarks confirming lane selection saves work on the chat path instead of only moving logic around internally

### Validation Metrics
- Lane selection accuracy against eval labels
- Reduction in unnecessary synthesis calls
- Reduction in unnecessary memories injected on simple turns
- Prompt overflow incidents reduced to zero

### Exit Criteria
- `ResponseSpec` is authoritative
- Fast-path ownership is explicit and tested
- Prompt budget is enforced without breaking response quality
- Real chat-path latency is same or better for fast-lane-eligible turns

## Phase 2: Memory Buckets, Injection Budgets, And Wake-Up Context
Status:
- `completed`

### Goal
Make memory selection sparse, relevant, and appropriate to the reply type.

### Deliverables
- Separate retrieval buckets:
  - `working_context`
  - `semantic_profile`
  - `relational_graph`
  - `episodic_threads`
- Injection budgets by lane:
  - `social_ack`: max 1 memory
  - `grounded_direct`: none unless required for referent resolution
  - `full_synthesis`: max 4 total with diversity
- Memory suppression rules:
  - no recent repeats
  - no near-duplicates
  - no contradicted or low-confidence memories unless explicitly relevant
- Structured wake-up context:
  - max 2 key facts
  - max 1 relationship
  - max 1 unresolved/recent thread

### Tests
- Unit tests for bucket assignment
- Unit tests for memory cap enforcement
- Unit tests for duplicate suppression
- Unit tests for contradiction filtering
- Integration tests for:
  - relationship queries preferring relational memory on the chat path
  - older-session recall using episodic memory on the chat path
  - unrelated turns not surfacing irrelevant names on the chat path
- Prompt-budget regression tests with wake-up context enabled
- Multi-turn transcript tests using realistic user inputs rather than normalized canonical strings
- Retrieval latency benchmarks so relevance gains are measured against cost

### Validation Metrics
- Relevant personalization rate
- Irrelevant personalization rate
- Repeated-memory rate
- Relationship-answer correctness
- Older-session recall usefulness

### Exit Criteria
- Memory injection is smaller and more relevant than baseline
- Relationship turns improve
- Irrelevant memory callbacks decrease
- Retrieval and prompt-assembly latency stay within agreed budget on the real chat path

## Phase 3: HumanizationPlanner And Session Hook State
Status:
- `completed`

### Goal
Make responses feel warm and varied without relying on prompt luck alone.

### Deliverables
- Deterministic `HumanizationPlanner`
- Session-scoped `recent_hooks: list[str]`
  - append hooks used in responses
  - keep only last 3
- Supported planner outputs:
  - optional empathy opener
  - optional personalization hook
  - optional follow-up slot
- Anti-repetition synthesis rules:
  - opener blocklist
  - answer-first enforcement
  - no follow-up instead of answer

### Tests
- Unit tests for planner decisions on:
  - sad/frustrated turns
  - neutral factual turns
  - fact-sharing turns
  - recommendation turns
- Multi-turn integration tests confirming:
  - no repeated opener phrases over 3 turns on the chat path
  - no repeated personalization hook over 3 turns on the chat path
  - follow-up appears only after the answer on the chat path
- Golden tests for no parroting / no memory restatement
- Frontend-oriented integration tests that exercise the visible chat input flow when planner behavior affects user-visible sequencing
- Performance tests verifying humanization does not materially slow streaming start or total turn latency

### Validation Metrics
- Non-echo rate
- Repeated-opening rate
- Repeated-hook rate
- Human-review warmth score
- Human-review naturalness score

### Exit Criteria
- Responses are measurably warmer
- Repetition drops in multi-turn conversations
- No factual regression from baseline
- Warmth gains do not come with unacceptable latency regressions

## Phase 4: Retrieval Quality Improvements And Novelty Penalty
Status:
- `completed`

### Goal
Improve which memories get selected before they reach the model.

### Deliverables
- Deterministic candidate scoring using:
  - retrieval rank
  - confidence
  - observation recency
  - relation match
  - novelty penalty
  - contradiction penalty
- Session-scoped `session_seen_fact_ids: set[int]`
  - add facts when surfaced in a reply
  - apply a soft novelty penalty on reuse
- `RapidFuzz` integration for:
  - alias matching
  - near-duplicate suppression
  - noisy entity/name repair
- Graph-walk resolution for:
  - “Artie’s wife”
  - “my brother’s daughter”
- Entity-boost experiment behind a flag

### Tests
- Unit tests for scoring math
- Unit tests for novelty penalty behavior
- Unit tests for `RapidFuzz` alias matching
- Unit tests for graph-walk referent expansion
- Integration tests for:
  - possessive relation queries on the chat path
  - long conversation reuse suppression on the chat path
  - entity-boost on/off comparison on the chat path
- Offline retrieval benchmark on eval corpus
- Realistic referential multi-turn evals using natural user phrasing
- Retrieval performance benchmark covering scorer cost and graph-walk overhead

### Validation Metrics
- Top-1 memory relevance
- Top-3 memory relevance
- Repeated-fact injection rate in long chats
- Referent resolution correctness on possessive queries
- Precision/recall impact of entity boost

### Exit Criteria
- Memory relevance improves over baseline
- Novelty penalty reduces repetition
- Graph-walk improves people resolution without regressions
- Retrieval-quality gains justify their latency cost on real turns

## Phase 5: Micro Fast-Lane For Greetings And Gratitude
Status:
- `pending`

### Goal
Reduce latency only for the safest trivial turns.

### Deliverables
- Embedding-based micro fast-lane before decomposition
- Scope limited to:
  - greetings
  - gratitude
- Threshold policy:
  - fire only at similarity `>= 0.90`
  - log near-misses `> 0.80`
- Direct route from fast-lane to `social_ack`
- No emotional-turn bypass

### Tests
- Unit tests for template similarity matching
- Integration tests confirming:
  - “hi”, “hey”, “thanks” bypass decomposer through the actual chat path
  - “hey what’s the weather” does not bypass through the actual chat path
  - “I’m stressed out” does not bypass through the actual chat path
- Regression test that near-threshold inputs still fall through safely
- Latency benchmark test on fast-lane eligible turns
- Real-life greeting/gratitude variants gathered from representative user phrasing, not only template words

### Validation Metrics
- Fast-lane precision
- Near-miss distribution
- Latency improvement on greeting/gratitude turns
- False-positive bypass count

### Exit Criteria
- Fast-lane precision is very high
- False positives are acceptably rare
- Meaningful latency win exists on trivial turns

## Phase 6: Selective Verifier And Memory-Write Risk Checks
Status:
- `pending`

### Goal
Add a second-pass safety net only where uncertainty is high.

### Deliverables
- `DecompositionDiagnostics`
- Verifier triggers only when:
  - repair fired
  - asks are empty/fallback
  - referent resolution is ambiguous
  - routing fields conflict
  - memory-write risk is high
- Verifier checks only:
  - reply lane
  - freshness need
  - capability need
  - memory-write confidence
- Optional branch for tiny NLI contradiction check

### Tests
- Unit tests for verifier trigger conditions
- Unit tests for memory-write risk detection
- Integration tests confirming:
  - clean turns skip verifier on the chat path
  - ambiguous/problematic turns invoke verifier on the chat path
  - verifier can change an unsafe plan on the chat path
- Regression tests for latency on clean turns
- Realistic malformed / ambiguous LLM-output-style cases and user-turn examples that mirror actual repair scenarios

### Validation Metrics
- Verifier invocation rate
- Accuracy improvement on flagged turns
- Memory-write precision improvement
- Added latency only on flagged turns

### Exit Criteria
- Uncertain turns improve measurably
- Clean turns remain fast
- Memory-write errors decrease
- Verifier overhead stays acceptable on real end-to-end chat turns

## Phase 7: Telemetry-Driven Experiments And Controlled A/B Tests
Status:
- `pending`

### Goal
Experiment safely and only promote changes that outperform the control.

### Deliverables
- Access telemetry fields:
  - `access_count`
  - `last_accessed_at`
- Logging for when facts are retrieved and when they are injected
- A/B framework for:
  - memory formatting variants
  - reranker variants
- Memory-format experiments must include:
  - current format as control
  - at least one warmer variant
- Optional reranker experiments:
  - `BAAI/bge-small-en-v1.5`
  - optional `BAAI/bge-reranker-base`

### Tests
- Unit tests for telemetry updates
- Integration tests for experiment-arm assignment
- A/B evaluation scripts comparing:
  - control vs warmer memory formatting
  - baseline retrieval vs reranked retrieval
- Regression tests ensuring no experiment arm breaks citations, prompt budget, or answer-first behavior
- All experiment comparisons must include real chat-path latency and realistic user-turn corpora, not only offline scoring

### Validation Metrics
- Formatting arm: warmth score, echo rate, relevance score
- Retrieval arm: top-1/top-3 relevance, latency delta
- Access telemetry correlation with actual usefulness

### Exit Criteria
- Only experiments with measured wins over control are promoted
- No experiment is promoted solely on intuition

## Phase 8: Deferred Optimization And Cleanup
Status:
- `pending`

### Goal
Address lower-priority optimizations only after the core system is stable.

### Deliverables
Potential future work:
- decomposition prompt fragmentation if profiling proves prompt size is a real bottleneck
- background memory consolidation if memory sprawl becomes measurable
- external-inspired adapters:
  - MemPalace-style verbatim episodic retrieval
  - Zep/Graphiti-style temporal context formatting
  - LangMem-style procedural memory concepts

### Tests
- Each deferred item requires:
  - dedicated benchmark
  - dedicated regression suite
  - comparison against current production path
  - real chat-path measurement with representative user inputs
- No deferred optimization ships without eval evidence

### Validation Metrics
- Measurable quality gain
- Measurable latency/cost impact
- No regression against current default path

### Exit Criteria
- Deferred items only graduate if they clearly outperform the existing system

## Global Validation Strategy
Track after each phase:
- accuracy
  - current-data freshness correctness
  - grounded correctness
  - referent resolution correctness
- human quality
  - non-echo rate
  - relevant personalization rate
  - repeated-memory rate
  - repeated-opening rate
- speed
  - p50/p95 latency
  - time-to-first-token
  - extra model-call rate
  - retrieval / routing / synthesis phase deltas on the real chat path
- memory quality
  - contradiction error rate
  - irrelevant memory injection rate
  - memory-write precision

Validation inputs after each phase must include:
- offline eval corpus cases
- real chat route end-to-end cases
- frontend chat input path coverage where UI behavior is involved
- realistic single-turn and multi-turn user inputs shaped like actual LLM-era usage, not only tidy synthetic prompts

## Recommended Conversation Split
Use one new Codex conversation per phase:
1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7
9. Phase 8

Each phase conversation should:
- restate the target phase
- implement only that phase’s deliverables
- run only that phase’s listed tests plus affected regressions
- include performance checks for the shipped path, not only correctness checks
- update the phase status in this file from `pending` to `completed` only after exit criteria are met

## Assumptions
- Local-first remains the default architecture.
- Helper libraries are acceptable only when narrowly scoped and measurable.
- Final conversational voice stays in the main synthesis path.
- Phases should not be marked `completed` until implementation and validation are actually finished.
