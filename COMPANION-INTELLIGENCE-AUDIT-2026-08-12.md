# Companion Intelligence Audit: Memory, Continuity, and World Knowledge

Date: 2026-08-12
Scope: the chat/voice companion's memory, conversational continuity, world knowledge, and response quality. Four parallel deep audits (memory subsystem, chat pipeline, knowledge/persona layer, and a web-research pass on 2025-2026 state of the art) plus hand verification of the highest-impact findings in code.

**Implementation status (2026-08-12): ALL 25 plan items implemented** across six
commits (Phases 1-6; see git log for this date). Item 8's 60-token clamp turned
out to be already removed (verbosity hints replaced it), and item 22's pacing
needs were already met by the existing typing indicator + streaming, so both
became documentation corrections. New evals: `eval:continuity` (multi-turn
probes + grep baseline), plus `eval:companion` wired into package.json.
Docs refreshed: chat-latency.md, subsystems.md, llm-architecture.md.

## Verdict

The architecture is genuinely modern: the memory system is a mem0 / Generative-Agents / "sleep-time judge" hybrid that most hobby projects never reach, every live-data tool is actually wired into chat, and the latency work is production-grade. The failures the user experiences ("the companion says something, I ask about it, and it has no idea") are NOT a missing memory system. They are three specific continuity breaks in the turn pipeline, plus a set of real gaps in humanlike memory (no self-memory, weak past-chat recall, no temporal reasoning) and world knowledge (stale-weights answers on no-tool turns).

The 2026 research consensus supports the current shape: small models live or die on context curation, not context size, and the frontier products (ChatGPT, Claude, Character.AI) all converged on simple curated injection rather than fancy vector/graph stores. The wins here are targeted fixes, not a rewrite.

---

## Part 1: What exists today (verified)

- **Turn pipeline** (`companionTurn.ts:345`): route (2-tier + regex fast paths) -> tools -> system prompt assembled stable-to-volatile for KV cache -> stream. History loaded per conversation, trimmed to 800 tokens (`chat.ts:305`).
- **Memory**: background judge sweep every 5 min on idle conversations (`memory/sweep.ts`), two-phase extraction (entities + facts, then per-fact ADD/UPDATE/DELETE dedup, `memory/judge.ts`), entity-first + vector recall with tier/importance/recency scoring (`memory/recall.ts`), hourly decay/audit (`maintenance.ts`, `audit.ts`), per-conversation block cache (`blockCache.ts`: 30 min TTL, 8-turn max, entity-triggered invalidation).
- **Scopes**: user-global "shared brain", household, per-character-instance, and a character-global scope that is defined and readable but never written.
- **Cross-session**: `memory_episodes` conversation summaries, recalled by cosine only; top 1 injected; hard cap 50 per (user, character) with hard deletion.
- **World knowledge**: 14+ live tools all registered and chat-reachable (search stack: SearXNG -> google-sr/DDG/Mojeek/Marginalia, keyless; news via Google News RSS; ESPN; Open-Meteo; JustWatch; TVMaze; Fandango; Wikipedia live + offline ZIM). An always-on ~700-char ambient briefing block (weather, world/local news, sports, calendar) is injected every turn.
- **Persona**: static `personalityPrompt` (~1-3 sentences) + few-shot examples + appearance + reply style. `backstory` column exists but is never injected. No mood, opinion, or self-consistency state. Relationship depth = one "you've known each other N months" line.

### Doc drift found along the way

`docs/internal/llm-architecture.md` still says "No Chinese-origin models (Qwen...)" and describes a single-model architecture; the shipped Latest model set is Qwen-based and the engine/model-set design has moved on (commits 0af7b06d, cdc0b55b). The doc needs a refresh pass; several agents were initially misled by it.

---

## Part 2: Findings, ranked

### P0-1. Voice turns carry ZERO conversation history

`satelliteSession.ts:585` calls `runPodBrain(text, { userId, characterId, convId: 'pod:'+userId, ... })` with no `history`; `brain.ts` defaults it to `[]`. Every spoken turn is answered with an empty conversation window. Long-term memory still injects (stable convId), but "what you said five seconds ago" is gone. The router's follow-up fast paths (`CONTINUATION_RE`, `CONTEXTUAL_LOOKUP_RE`) are gated on `history.length > 0`, so on voice they never fire either: "tell me more" falls through to conversational/search with no subject.

This is the single most direct cause of the reported failure mode, and it is a wiring bug, not a design gap.

### P0-2. History-blind fast-path routing misroutes question-shaped follow-ups

All regex fast paths and the embedding tier see only the current message. Only tier-2 sees history (last 10 turns, `router.ts:651,706`). Consequences, verified in code:

- "who was he?" matches `SEARCH_INTENT_RE` ("who was", `router.ts:28`), scores below every tool, and takes the literal search passthrough (`router.ts:553`): the web is searched for the string "who was he?".
- "what did you mean?" is not in `CONTINUATION_RE` or `SEARCH_INTENT_RE`; it falls to tier-2-with-search, which may or may not recover.
- Follow-up detection is a hardcoded whitelist (`CONTINUATION_RE`, `CONTEXTUAL_LOOKUP_RE`); anything phrased slightly off ("wait, back up, what was that about?") misses.

Research note: this exact failure (embedding routers on the bare last utterance) is a known-broken pattern; the production fix is history-conditioned classification with an explicit "is this a follow-up? inherit the previous route" instruction. Zero extra hops, ~200 extra prompt tokens.

### P1-1. The 800-token history window is smaller than a conversation's short-term memory

`chat.ts:305` (also Telegram `handler.ts:145`): last 40 messages loaded but trimmed to 800 tokens, roughly 3-6 turns, minimum 4 messages. Beyond that, continuity relies on the rolling summary, which only refreshes every ~8 messages for conversations >= 16 messages and is capped at ~150 words. A reference to something said 8-15 turns ago can land in a hole: out of the live window, not yet in the summary. One long assistant answer can consume most of the budget by itself.

### P1-2. Tool data is reconstructed lossily across turns

The model only ever sees the tool's `answer_payload` (not raw data), and the next turn sees a `toolNote` capped at 600 chars per tool / 800 total re-appended to the assistant message (`chat.ts:315-318`, `companionTurn.ts:1249`). "What was the third headline's source?" is unanswerable: the detail was summarized away before it was ever stored. The good part: the mechanism exists and the assistant's own words persist verbatim; it is the caps and the raw-payload discard that bite.

### P1-3. The companion has no memory of itself

The character-global scope (`userId=null, characterId=Y`, "the character's own knowledge") is defined in schema and readable by recall but nothing ever writes it (`sweep.ts:163,287`). The companion has no durable record of its own past statements, opinions, promises, or experiences. Episodes summarize what it learned about the user, not what it said. Humans remember what they told you; this companion structurally cannot.

### P1-4. Past-chat recall is the weakest tier, and it is the one users notice most

- Only ONE episode summary is ever injected (`TOP_K_EPISODES=1`), selected by cosine only, no recency weighting.
- No temporal capability at all: "what did we talk about last week" has no data path (no time-filtered queries, no browse/search over prior sessions, raw prior messages never searched).
- Episodes are hard-capped at 50 per (user, character) and hard-deleted beyond that, while facts are soft-archived: the most human-facing memory is the most aggressively destroyed.
- Episodes are character-scoped with no cross-character sharing (facts are shared; conversations are not).

### P1-5. Contradiction handling and consolidation are cosine-gated

Contradictions resolve only when the new fact lands within cosine 0.5 of the old one AND in the top-5, and only via one small-model ADD/UPDATE/DELETE call. Dissimilarly-phrased contradictions both stay active and can be recalled together. Superseded rows are kept 90 days but recall never reads them, so "you used to live in NYC, now Boston" is impossible. There is no periodic global consolidation; near-duplicates accumulate unless a new similar fact happens to arrive.

### P2-1. Stale-weights answers on no-tool turns

Any turn that is not question-shaped and matches no tool (opinions, statements, current-events small talk: "Taylor Swift's new album is great") is answered purely from the 8-9B model's frozen training data. Mitigations exist (question-shaped low-confidence prompts escalate to tier-2 with search; empty-result guard bans "it doesn't exist" claims), but there is no freshness-aware fallback for statements, and no knowledge-cutoff framing anywhere in the system prompt (no "as of" language, no offer to search).

### P2-2. Current-events depth is thin

- Sports is today-only (`sportsToday`): "who won last night", standings, player stats spill to generic web search.
- The news cache (`feed_items`, polled every 15 min) is searched by SQL LIKE token-AND only; no embedding or BM25 index, so recall from it is brittle.
- Best search quality depends on the optional SearXNG sidecar; without it the keyless stack (google-sr often blocked from server IPs, Mojeek/Marginalia) is thin exactly when freshness matters.
- `contentRating`'s LLM fallback surfaces training-data ratings by design (labeled, but still the one deliberate confabulation path).

### P2-3. Persona is static and drift-prone

- `personalityPrompt` never evolves; no mood state, no stored opinions, no self-consistency memory. A companion can contradict its stance from yesterday.
- `backstory` is authored in the DB and displayed in UI but never reaches the prompt (`buildCompanionPrompt`, `companionPrompt.ts:52-57`). Free quality on the floor.
- Research: persona drift is measurable within ~8 turns even at 70B (attention decay over the system prompt); the countermeasure is a compressed persona reminder re-injected near the END of context. Our persona sits early in the prompt with nothing late.

### P2-4. Memory-block staleness within a conversation

The recalled-memory block is cached per conversation (30 min / 8 turns / entity-triggered invalidation). Entity mentions refresh it, but a topic shift to non-entity subjects ("let's talk about my job" after 20 minutes of movie talk) can serve a stale block for up to 8 turns. This is a deliberate KV-cache tradeoff; the invalidation triggers are just too narrow.

### P3 (notable, lower urgency)

- Multi-user attribution: all human turns are labeled "User"; in a shared conversation facts cross-attribute to `conv.userId`.
- Recall candidate window is a fixed 150 rows ordered by pinned+importance; big scopes silently starve low-importance memories out of recall forever.
- Judge output is bare `JSON.parse`, no schema validation; multi-row writes are not transactional (crash mid-batch can double-insert on retry).
- Overlay surface trusts client-echoed history, last 6 turns only.
- Cosine thresholds are hand-tuned to nomic-embed-text with thin margins; an embedder swap invalidates them silently.
- `num_predict` 60-token cap on messages <= 20 chars will clip a substantive answer to a short follow-up like "why?" or "explain".

---

## Part 3: What the research says (2025-2026, verified claims only)

1. **Curation beats context size.** Chroma's context-rot report: focused ~300-token prompts beat full 113K histories across all 18 models tested. NoLiMa: without lexical overlap, 11/12 models fall below 50% of baseline by 32K. ICLR 2026 Outstanding Paper: average 39% quality drop from single-turn to multi-turn, worse at 8B. Our 800-token discipline is directionally right; the fix is guaranteeing the RIGHT tokens (the bot's own last message, verbatim recent turns), not a bigger window.
2. **Frontier products use simple memory.** ChatGPT: no vector DB; always-injected explicit facts + timestamped summaries of recent conversations + a periodically regenerated per-user knowledge paragraph (built from user messages only). Claude: tool-based search over raw history. Character.AI: ~15 pinned messages + a 400-char field. Our judge/recall stack is already fancier than all of them; what we lack is their injection shape (rolling recent-conversation summaries + a knowledge paragraph) and Claude's raw-history search.
3. **Follow-up amnesia is a router problem.** History-conditioned route classification (last 2-4 turns incl. the bot's last message + "inherit previous route unless topic changed") is the production fix. Gated query rewriting (only rewrite pronoun/ellipsis turns) works at 7-8B (CHIQ); blind always-rewrite is proven harmful (-9% retrieval when unneeded).
4. **Freshness is a pipeline property.** Simple recency priors beat clever trend heuristics. Inject real date + stated cutoff + Anthropic-style "answer as-of, flag staleness, offer to search" language; compute all cutoff logic in code, never ask the model.
5. **Memory benchmarks are polluted.** LoCoMo's answer key is ~6.4% wrong and its judge accepts 62.8% of wrong answers; vendor leaderboards (Mem0 vs Zep) are mutually contradictory. Evaluate with LongMemEval-style probes on our own data, pairwise judging only, and benchmark every memory feature against a "grep the raw logs" baseline.
6. **Humanlike feel is mostly UX + explicit state.** GPT-4.5 passed a Turing test at 73% WITH a persona prompt vs 21% without. Mood works as explicit injected state (1-2 lines, updated by a cheap post-turn classifier), not model magic. Short turns, typing indicators, and length-proportional pacing measurably increase perceived humanness.
7. **Model watch.** Qwen3.5-9B (IFEval 91.5, BFCL-V4 66.1, Apache 2.0) is the successor chat model but currently blocked in Ollama by the mmproj GGUF issue (ollama#14730); Gemma 4 E4B is the Ollama-ready A/B candidate today; Qwen3-4B-Instruct-2507 is the standout utility/judge model for the second card.

---

## Part 4: The plan

Ordered by leverage. Phases 1-2 attack the reported bug directly; 3-4 build the "human memory" the vision calls for; 5-6 are world knowledge and feel. Every phase that touches the prompt must re-run the chat benchmark (KV cache) and eval:router (the tier-2 prompt is load-bearing).

### Phase 1: Stop the amnesia (small diffs, highest leverage)

1. **Wire history into the voice path.** Accumulate turns in `satelliteSession` (or read back the `pod:{userId}` conversation) and pass the last ~6 turns into `runPodBrain`. One-line default today makes every Pod follow-up amnesiac.
2. **History-condition the router.** Give the fast tier a cheap follow-up gate: if the message contains pronouns/ellipsis/deixis ("he", "that", "it", "why", "what did you mean") and there is history, skip the literal search passthrough and route to a history-aware path. Add the "inherit previous route unless topic changed" instruction to the tier-2 prompt. Re-run eval:router before and after.
3. **Guarantee the bot's last exchange verbatim.** Change the trim contract: the last full exchange (user + assistant) is always included untrimmed, THEN the 800-token budget applies to older turns. Consider raising the budget to ~1200 (doc says the pain threshold is above 1200) and measure prefill with the chat benchmark.
4. **Gated query rewrite before search.** When a search-bound message is context-dependent (the same pronoun/deixis gate), spend one short fast-model call to rewrite it into a standalone query using the last 2-4 turns. Never rewrite self-contained queries.
5. **Fatten tool-turn retention.** Raise `toolNote` caps (600/800 chars is below what follow-ups need); persist the `answer_payload` the model actually saw so the next turn reconstructs the same view; consider keeping the full raw payload for the most recent tool turn only.

### Phase 2: Fix the short-term/long-term seam

6. **Close the summary hole.** Refresh the rolling summary whenever trimming drops messages that are not yet covered by `summaryThrough` (event-driven, not every-8-messages), so there is never a band of conversation that is neither in the window nor in the summary. Run it detached on the fast model as today.
7. **Widen memory-block invalidation.** Add a cheap topic-shift trigger: if the current turn's embedding similarity to the turn that built the cached block falls below a threshold, rebuild the block. Keeps the KV win for same-topic runs, kills the 8-turn stale window on topic shifts.
8. **Fix the 60-token clamp for short follow-ups.** Exempt messages that are questions or follow a substantive assistant turn; the clamp should only hit greetings.

### Phase 3: Human memory (the vision features)

9. **Companion self-memory.** Start writing the character-global scope: after each session, the judge (which already runs) additionally extracts the companion's own notable statements, opinions expressed, and promises made ("I told Jesse I'd remind him about the trip") into `userId=null/characterId=Y` (or per-user `characterId=Y` for relationship-private items). Recall already reads this scope; injection needs a small "Your own past statements:" section.
10. **Past-chat recall worth the name.** Raise injected episodes from 1 to 2-3 with a recency+cosine blend; raise the retention cap (50 -> 200+) or archive instead of hard-delete; add time-aware recall (parse "last week"/"yesterday" into a date filter, LongMemEval's proven trick); add a `recall_conversations` chat tool that searches raw prior messages (Claude's approach) so "what did we talk about on Sunday" actually works.
11. **Per-person knowledge paragraph (ChatGPT shape).** A sleep-time job (idle GPU, existing sweep infra) regenerates one compact paragraph per family member from their durable facts + recent episodes; always injected. This gives every turn a coherent picture without recall lottery.
12. **Bi-temporal validity, flat store.** Add `valid_from`/`superseded_by` columns; when a fact is superseded, keep the link so recall can render "used to X, now Y". Skip knowledge graphs (unproven marginal value, expensive writes).
13. **Consolidation + contradiction sweep.** A weekly idle-GPU pass that clusters near-duplicate actives and asks the judge to merge, and cross-checks durable facts pairwise within category for contradictions (not cosine-gated).

### Phase 4: World-smart

14. **Cutoff-aware system prompt.** Inject real date (already done) + the model's stated cutoff + Anthropic-style behavior language: answer as-of, flag possible staleness, offer to look it up. Pure prompt change; compute nothing in-model.
15. **Freshness routing for statements.** Extend tier-2 intent classes with time-sensitive / entity-unknown / stable; statements about current events get a background search-and-ground rather than a stale-weights answer.
16. **Search result hygiene.** Prefix every folded snippet with its publication date; apply a recency prior when reranking; surface date-stamped source chips in the UI (trust effect is proven even when users don't click).
17. **Sports/news depth.** ESPN scoreboard-by-date for "last night"/standings; add a BM25 (SQLite FTS5) index over `feed_items` so cached-news search stops being LIKE-only. FTS5 is built into bun:sqlite, no new dependency.
18. **Ship SearXNG by default** (installer step / admin nudge), since the whole current-events story leans on it.

### Phase 5: Persona and feel

19. **Inject the backstory** (it is already authored) for deep questions, and add a compressed persona reminder near the END of the system prompt (anti-drift, research-backed).
20. **Mood + emotional continuity.** Small per-(user, character) mood state updated by a cheap post-turn fast-model classification, rendered as 1-2 prompt lines; end-of-session emotional summary (Replika pattern) folded into episodes.
21. **Opinion consistency.** The self-memory from item 9 doubles as an opinion store; inject "opinions you have expressed" so the companion stops contradicting itself.
22. **Pacing UX.** Length-proportional multi-bubble pacing and typing indicator on text surfaces (voice already streams sentence-chunked).

### Phase 6: Evaluate like it's 2026

23. **Continuity probes in companion-eval.** Scripted multi-turn scenarios: follow-up pronoun resolution, "what did you just say", topic-shift recall, cross-session "what did we discuss last week", contradiction updates. Pairwise judging between variants only; plus mechanical metrics (assistant-tell regexes, reply-length distribution, persona-fact probes every N turns).
24. **Grep baseline.** Before shipping any Phase 3 memory feature, benchmark it against "search the raw logs" on the same probes; keep only what wins.
25. **Docs refresh.** `llm-architecture.md` model policy and single-model sections are stale versus the shipped model-set system.

### Sequencing and risk

- Phase 1 items 1-3 are each small, independent diffs with outsized effect; do them first and re-test with the existing chat/router benchmarks.
- The recurring tension is KV-cache stability vs context freshness (items 3, 7, 19 all touch prompt assembly). The stable-to-volatile ordering must be preserved; anything volatile goes late in the prompt, and the chat benchmark's KV-hit tests are the regression gate.
- Judge-quality items (9, 13) ride on the small model; keep structured calls short, schema-validated, and benchmarked, and consider moving judge work to the second card's utility model (Qwen3-4B class) so chat never queues behind it.
