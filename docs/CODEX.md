# CODEX Plan: Phased Rollout For LokiDoki’s Human, Accurate, Fast Chat System

## Summary
This plan is structured so each phase can be implemented in a separate Codex conversation with minimal carryover context.

Core architecture goals:
- deterministic response control through `ResponseSpec`
- sparse, high-value memory usage through retrieval buckets and budgets
- warmer and less repetitive replies through a deterministic `HumanizationPlanner`
- selective verification only on uncertain turns
- local-first execution, with helper libraries only where they deliver measurable gains

Status convention for every phase:
- `pending` = not started
- `in_progress` = currently being implemented
- `completed` = implemented and validated against exit criteria

Current overall status:
- All phases are `pending`

## Phase 0: Baseline, Instrumentation, Eval Harness, And Shadow Mode
Status:
- `pending`

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
- Integration test that one chat turn emits a complete trace record
- Integration test that shadow-mode `ResponseSpec` logs a planned lane without affecting real routing
- Regression test that existing chat behavior is unchanged

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

## Phase 1: ResponseSpec Control Plane And Fast-Path Mapping
Status:
- `pending`

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
  - simple grounded turns route to `grounded_direct`
  - short fact-sharing turns route to `social_ack`
  - mixed and reasoning turns route to `full_synthesis`
- Prompt-budget tests confirming:
  - truncation occurs in the correct order
  - clarification hints and citation anchors are preserved
- Regression tests for current fast-path behavior that should survive unchanged

### Validation Metrics
- Lane selection accuracy against eval labels
- Reduction in unnecessary synthesis calls
- Reduction in unnecessary memories injected on simple turns
- Prompt overflow incidents reduced to zero

### Exit Criteria
- `ResponseSpec` is authoritative
- Fast-path ownership is explicit and tested
- Prompt budget is enforced without breaking response quality

## Phase 2: Memory Buckets, Injection Budgets, And Wake-Up Context
Status:
- `pending`

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
  - relationship queries preferring relational memory
  - older-session recall using episodic memory
  - unrelated turns not surfacing irrelevant names
- Prompt-budget regression tests with wake-up context enabled

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

## Phase 3: HumanizationPlanner And Session Hook State
Status:
- `pending`

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
  - no repeated opener phrases over 3 turns
  - no repeated personalization hook over 3 turns
  - follow-up appears only after the answer
- Golden tests for no parroting / no memory restatement

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

## Phase 4: Retrieval Quality Improvements And Novelty Penalty
Status:
- `pending`

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
  - possessive relation queries
  - long conversation reuse suppression
  - entity-boost on/off comparison
- Offline retrieval benchmark on eval corpus

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
  - “hi”, “hey”, “thanks” bypass decomposer
  - “hey what’s the weather” does not bypass
  - “I’m stressed out” does not bypass
- Regression test that near-threshold inputs still fall through safely
- Latency benchmark test on fast-lane eligible turns

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
  - clean turns skip verifier
  - ambiguous/problematic turns invoke verifier
  - verifier can change an unsafe plan
- Regression tests for latency on clean turns

### Validation Metrics
- Verifier invocation rate
- Accuracy improvement on flagged turns
- Memory-write precision improvement
- Added latency only on flagged turns

### Exit Criteria
- Uncertain turns improve measurably
- Clean turns remain fast
- Memory-write errors decrease

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
- memory quality
  - contradiction error rate
  - irrelevant memory injection rate
  - memory-write precision

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
- update the phase status in this file from `pending` to `completed` only after exit criteria are met

## Assumptions
- Local-first remains the default architecture.
- Helper libraries are acceptable only when narrowly scoped and measurable.
- Final conversational voice stays in the main synthesis path.
- Phases should not be marked `completed` until implementation and validation are actually finished.
