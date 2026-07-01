# Companion System — Architecture Review & Improvement Design

> **Implementation status (2026-07-01):** FULLY IMPLEMENTED. Phases 0–4 landed in
> `feat(companion): architecture overhaul`; the follow-up commit adds household-shared
> facts (4.3), the rolling in-conversation summary + RAG doc chunking (4.4), and the P2
> backlog — raw-text persistence with mask-on-read (A15), judge-before-delete (R10),
> tool-status labels + capped-reply flag (C4), and the parsed-vector cache (S8). Tool
> notes in history replace the need for most of C1's bounded tool loop; multi-intent
> Tier-2 calls are in. The two remaining ideas are now also built: message
> edit-and-resubmit (C5 — linear history: editing a user message replaces everything
> after it; POST /api/chat/edit) and companion-initiated check-ins (H8 — at most one
> per user per day, triggered only by fresh open-thread memories, delivered via the
> notification system with a mute category; lib/companionProactive.ts). Nothing from
> the review remains unimplemented.

**Date:** 2026-07-01
**Scope:** companion chat pipeline, personality/prompting, message routing, and memory — reviewed for speed, reliability, accuracy, completeness, and humanistic quality.
**Method:** four parallel deep-read passes over `backend/src/lib/companionTurn.ts`, `companionPrompt.ts`, `routes/chat.ts`, `routes/companions.ts`, `lib/pod/brain.ts`, `llm/router.ts`, `llm/ollama.ts`, `memory/*`, `tools/*`, and the frontend consumers (`ChatContext.tsx`, `useCompanionStream.ts`, `CompanionOverlay.tsx`).

---

## 1. Executive summary

The foundations are unusually strong for a local-first system: a raw-TCP streaming transport that defeats Bun's fetch buffering, a disconnect-tolerant generation queue with seq-cursor replay, a tiered router where most tool turns cost **zero** extra LLM calls, a sleep-time memory judge with entity-first recall, and `directReply` fast paths that give Alexa-class latency for smart-home/alarm/playback turns. Observability (timing laps, router decision logs, three admin benchmarks) is production-grade.

The problems cluster into four themes:

1. **Three diverged copies of the same brain.** `runCompanionTurn` (chat + Pods), the hand-rolled overlay pipeline in `routes/companions.ts` + `toolTurn.ts` (voice), and the Pod path have each accumulated fixes the others lack. The KV-cache prompt-ordering fix, the empty-search anti-hallucination guard, tool-execution try/catch, and briefing injection each exist in exactly one place. Every bug below that says "fixed in X but not Y" is this theme.
2. **Speed was bought at accuracy's expense in memory.** Recall is cached per-conversation for 30 minutes and computed from the *first* message — entities mentioned at turn 3 never surface. The vector threshold is effectively no filter, so the top-5 memories are injected regardless of relevance.
3. **A handful of real correctness bugs**: the judge's DELETE path silently drops replacement facts ("I moved to Boston" deletes NYC and stores nothing); the sweep advances its cursor even when extraction fails (permanent fact loss); "Stop" cancels emission but not GPU generation; a throwing tool kills the whole turn; the chat path's volatile time string busts Ollama's KV cache every minute.
4. **The humanistic layer is scaffolded but unplugged.** Relationship progression (`friendshipLine`) is dead code; emotional continuity is excluded by the judge's discard rules; the anti-parroting header forbids unprompted follow-ups entirely; the avatar's emotion faces depend on XML tags the prompt bans; `expressiveness` is stored but never consumed.

**Scorecard:**

| Axis | Grade | One-line verdict |
|---|---|---|
| Speed | B+ | Excellent transport & routing cascade; undermined by the chat-path KV-cache bug, warmup prefix mismatch, sequential pre-stream DB clusters, and num_ctx thrash |
| Reliability | B− | Fails open almost everywhere; but tool throws, judge failures, dropped streams, and cancel-doesn't-cancel all lose work silently |
| Accuracy | C+ | Routing regex misfires, always-inject memory recall, contradiction data loss, persona↔dial conflicts |
| Completeness | B | One-shot tool model (no chains, no tool memory), no partial-reply persistence, no user-facing memory management |
| Humanistic | C | Infrastructure above par; the actual warmth behaviors are dead code, forbidden by prompt policy, or unbuilt |

---

## 2. Current architecture

### 2.1 Surfaces and pipelines

```
                    ┌────────────────────────────────────────────────┐
                    │              buildCompanionPrompt              │  ← one persona builder
                    └───────┬───────────────┬────────────────┬───────┘
                            │               │                │
  Chat app (text)   routes/chat.ts ──► genQueue('chat',2) ──► runCompanionTurn ──┐
  Pod devices       lib/pod/brain.ts ────────────────────► runCompanionTurn ──┤── llm/router.ts
  Overlay (voice)   routes/companions.ts ── (no queue!) ──► runToolTurn  ──────┘   (shared)
                            ▲
                    bespoke prompt assembly, briefing block,
                    KV-safe ordering — none shared back
```

Three prompt assemblers produce **materially different prompts for the same character**:
- Main chat: content policy → **date/time (volatile, position 2)** → locale → persona → memory → uiContext → skills → docs → interaction fragment. No briefing.
- Overlay: content policy → harness line → persona → candor → uiContext → memory → **briefing** → date/time **last** (KV-safe). No locale/skills/docs/depth fragments. Bypasses genQueue entirely.
- Pods: shared `runCompanionTurn`, but no briefing and no uiContext — the most "ambient roommate" surface is the least world-aware.

### 2.2 One turn, end to end (chat path)

1. Auth (2 queries) → context assembly (`resolveChatContext`: ~7 parallel queries) → conversation resolve → history load (last 40, trimmed to **800 tokens**).
2. Enqueue on the chat lane (concurrency 2, per-user waiting cap 3). Generation is decoupled from the SSE connection; reconnect via `genId` + seq cursor.
3. `runCompanionTurn`: **routing ∥ memory recall** in parallel (good). Then a *sequential* cluster: doc-override query → `isToolAllowed` (2q) → `isOffline` → `resolveToolConfig` (2q) → blocking tool execution → skills query → a **second** `chatDocuments` query.
4. Router cascade: ~8 regex fast paths → all-minilm embed + cosine over ~270 cached example vectors (40 tools) → Tier 1 (≥0.65: passthrough, zero LLM) / Tier 0 (<0.40: no tool) / Tier 2 (one non-streaming call on the router model, top-5 candidates + search, 10-turn history).
5. Zero or **one** tool runs (no loop). `directReply` skips the main LLM entirely. Otherwise tool data is folded into the user turn as raw JSON (+ optional `synthesisHint`).
6. Main LLM streams over raw TCP (noDelay, hand-rolled chunked parser, two-phase stall detection: 300s first-byte / 60s idle). Frontend RAF-batches tokens.
7. Persistence after completion; title generation (another full LLM call) **blocks the `done` event** on turn 1. Memory extraction is out-of-band (idle sweep judge).

### 2.3 Memory subsystem

- **Write:** judge (sole writer) runs on a 5-min idle sweep (chat) or fire-and-forget per turn (overlay). Two phases: extract (1 structured call over ≤60 messages) → per-fact dedup (embed + cosine >0.5 → 1 structured call returning ADD/UPDATE/DELETE/NO_CHANGE). User facts written to the shared brain (`character_id = null`).
- **Read:** top-150 active memories by pinned/importance → deterministic entity-token pass (score 1.0) + vector pass (`0.7·cos + 0.2·imp + 0.1·recency`, threshold 0.12, top-5) → formatted block ≤1200 chars → cached 30 min keyed by `convId` (chat) or `user:char` (overlay).
- **Lifecycle:** hourly maintenance (episodic decay/archival, 200-active cap), hourly audit (junk pruning, episodic ≤ importance 5 only), episode summaries at ≥20 messages.

---

## 3. Findings

Grouped by axis. Each finding carries its anchor file:line. (P0/P1/P2 = fix priority, mapped to the roadmap in §4.)

### 3.1 Speed

| # | Finding | Where | Priority |
|---|---|---|---|
| S1 | **Volatile minute-precision time sits near the front of the chat system prompt**, busting Ollama's KV cache every minute and forcing full re-prefill of persona + memory + skills + docs. The overlay fixed exactly this (`companions.ts:313-317` puts time last); the shared brain never got the fix despite its own comment claiming KV-stability (`companionTurn.ts:299`). | `companionTurn.ts:317-326` | **P0** |
| S2 | **Warmup prefix mismatch**: boot warmup primes the KV cache with a prompt beginning `Today is…` but the real prompt begins with the content-policy block — the warmup never matches, so turn 1 always pays cold prefill. | `models.ts:117-121` | **P0** |
| S3 | **num_ctx thrash on single-model setups**: Tier-2 routing pins `num_ctx: 4096` while chat uses 8192 — when no dedicated router model is configured, every Tier-2 turn can force two Ollama runner re-inits per message. | `router.ts:381-382` | **P0** |
| S4 | **No timeout budget on the Tier-2 routing call** — a wedged router model stalls a turn up to 120 s of pre-stream silence, despite routing failing open. | `router.ts:363`, `ollama.ts:19` | **P0** |
| S5 | Sequential pre-stream cluster (~8 queries: doc-override, isToolAllowed, isOffline, resolveToolConfig, skills, docs×2) with no data dependency on routing; near-static per-user context (protections, ceiling, locale, interaction style) re-read every turn. | `companionTurn.ts:188-363` | P1 |
| S6 | **Title generation blocks `done`** — every first turn holds the UI in "generating" through an extra full LLM call. | `chat.ts:548-551` | P1 |
| S7 | Per-turn judge on the overlay re-extracts an overlapping 10-message window after **every** turn — 5–10× more background 8B calls than needed, contending with interactive TTFT on a single GPU. | `companions.ts:373-385` | P1 |
| S8 | Embeddings stored as JSON text; ~150 `JSON.parse` of 768-float arrays per cache-miss recall. Fine now; a cliff as the durable set grows. | `embed.ts:16-27` | P2 |

### 3.2 Reliability

| # | Finding | Where | Priority |
|---|---|---|---|
| R1 | **Cancel doesn't stop generation.** Breaking the stream loop never destroys the TCP socket or aborts Ollama — the GPU keeps generating a discarded reply while the freed queue slot admits the next job. Voice has no cancel endpoint at all. | `ollama.ts:308-318`, `companionTurn.ts:380-382` | **P0** |
| R2 | **A throwing tool kills the whole turn** — `tool.execute` is unguarded in `companionTurn.ts` (the overlay's `toolTurn.ts:80` has the try/catch). | `companionTurn.ts:240` | **P0** |
| R3 | **Judge failure permanently loses facts**: if extraction fails, the sweep still advances `memoryProcessedThrough`, skipping those messages forever. | `sweep.ts:155-160`, `judge.ts:183-184` | **P0** |
| R4 | **Partial replies are never persisted** — cancel or mid-stream error discards all streamed text; the UI shows it until reload, then it vanishes. | `chat.ts:531-554` | P1 |
| R5 | **Frontend treats a dropped stream as success**: connection close without `done` calls `onDone({})`, clears the reconnect cursor from sessionStorage (disabling the reconnect path built for this case), and shows a silently truncated reply. | `ChatContext.tsx:876-878` | P1 |
| R6 | **Voice consumer is the least protected surface**: never checks `res.ok`, ignores `error` SSE events entirely, bypasses genQueue (no concurrency limits, no reconnect). | `useCompanionStream.ts:46-73` | P1 |
| R7 | User-message insert is fire-and-forget with a swallowing catch — a failed insert silently loses the user's turn from history. | `chat.ts:482-488` | P1 |
| R8 | No per-conversation serialization: two tabs / voice+chat snapshot history at enqueue time and interleave replies. | `genQueue.ts`, `chat.ts:302` | P1 |
| R9 | Raw `String(err)` leaks internal error text into chat bubbles. | `chat.ts:555` | P2 |
| R10 | Deleting a conversation inside the 5–10 min idle window cascade-deletes messages before the judge ever runs. | `routes/chat.ts:129-138` | P2 |

### 3.3 Accuracy

| # | Finding | Where | Priority |
|---|---|---|---|
| A1 | **Judge DELETE drops the new fact.** The dedup prompt's DELETE action supersedes the old memory but never inserts the replacement — "I moved to Boston" can delete "lives in NYC" and store nothing. UPDATE also lets a low-importance refinement demote a durable memory to episodic. | `judge.ts:110-123, 311-335` | **P0** |
| A2 | **Recall is frozen to the conversation's first message** for 30 min (cache keyed by `convId`, never invalidated on the chat path even after the sweep writes new facts). The entity-recall guarantee — "'would Artie like this?' surfaces Artie's facts" — is defeated whenever the entity first appears mid-conversation. | `blockCache.ts:23`, `companionTurn.ts:144-169` | **P0** |
| A3 | **The vector threshold (0.12) is effectively no filter** — importance + recency terms alone clear it at cosine 0, so the top-5 memories are injected on every cache miss regardless of relevance, even for "hi". | `recall.ts:171-215` | **P0** |
| A4 | **Router regex misfires**: `SEARCH_INTENT_RE` web-searches "how do you feel?"/"who are you?" (fires before the social-question filter); `CONTEXTUAL_LOOKUP_RE`'s bare `can you (look|check|verify|confirm)` hijacks "can you check the weather?" into a search-only Tier-2 where weather/HA are unreachable. | `router.ts:28, 55, 222, 273` | **P0** |
| A5 | **Empty-search anti-hallucination guard exists only on the voice path** — chat folds `{"results":[]}` raw and can confidently deny a subject exists (the exact failure the overlay fixed for misheard names). | `toolTurn.ts:100-105` vs `companionTurn.ts:284` | **P0** |
| A6 | **Persona ↔ clamped-dials contradiction**: dials clamp to the user's ceiling but the persona text doesn't adapt — a locked-profile user chatting with a flirtatious character gets three-way conflicting instructions (persona says tease, policy says non-sexual, core says "do not refuse"). | `chat.ts:603-606`, `contentPolicy.ts` | P1 |
| A7 | **Assistant statements can become "user facts"**: the extract prompt never restricts extraction to user-asserted facts; an uncorrected hallucination is eligible for memory. `sourceText` provenance exists in schema but is always null. | `judge.ts:167-170, 355` | P1 |
| A8 | **Entity alias collisions**: relationship nouns ("brother", "mom") as aliases merge distinct people into one entity at upsert and force-inject that entity's whole fact set on any bare token match; `relinkEntityIds` uses substring matching ("art" matches "artichoke"). | `judge.ts:209-210, 423-434`, `recall.ts:135-138` | P1 |
| A9 | Tier-2 resolution matches the **full registry**, not the candidate set, while the static system prompt always advertises 18 tools regardless of what's callable — undocumented, unmeasured escape hatch. | `router.ts:92-118, 398` | P1 |
| A10 | Denied/disabled tools fail silent: `isToolAllowed` runs post-routing; the model answers a weather question from stale memory instead of saying the tool is off. Disallowed tools also occupy Tier-2 candidate slots. | `companionTurn.ts:200` | P1 |
| A11 | No Tier-1 margin check: two tools at 0.66/0.65 → blind passthrough of the winner. Known confusable clusters (tvshows/search/whereToWatch; youtube/play_music). | `router.ts:312` | P1 |
| A12 | Contradictory memories can coexist (dedup only fires at cosine >0.5; no post-hoc conflict detector) and dedup candidates aren't sorted by similarity (`.filter().slice(0,5)` takes the first 5 above threshold, not the closest 5). | `judge.ts:274-283` | P1 |
| A13 | Temporal mis-grounding: facts stored in eternal present tense ("getting married next month") with no event dates, despite the code citing the bi-temporal pattern it half-implements. | `judge.ts:314` | P2 |
| A14 | Episode generation repeatedly summarizes the **first 60 messages** of long conversations (no since-cursor windowing, no dup check), evicting older distinct episodes via the 50-cap. | `sweep.ts:162-178` | P1 |
| A15 | Masked-profanity history feedback loop: persisted assistant text contains `****`, teaching the model to self-censor — which the unrestricted profanity fragment explicitly forbids; overlay judge sees raw text, chat sweep sees masked. | `companionTurn.ts:410-412` | P2 |
| A16 | Admin studio tester uses a stripped prompt (no appearance/policy/memory/date) — admins tune a persona that isn't what ships. | `adminCompanions.ts:200-202` | P2 |
| A17 | Security-sensitive HA actions (unlock/open) execute instantly on a fuzzy Tier-1 match with no confirmation step. | `homeAssistant/index.ts` | P1 |

### 3.4 Completeness

| # | Finding | Priority |
|---|---|---|
| C1 | **No multi-step tool use**: one-shot route → ≤1 tool → synthesis. Tool results never persist into history (the continuation regexes exist to patch exactly this), so "tell me more" re-searches and "compare X and Y" is impossible. Only `tool_calls[0]` is read — compound voice commands ("lights off and play jazz") half-execute silently. | P2 |
| C2 | **No user-facing memory management**: memories are admin-only; a family member cannot see, correct, pin, or delete what companions know about them. No explicit `remember`/`forget` tool — the only write path is hoping the judge extracts it 5+ minutes later. | P1 |
| C3 | **Durable memories are immortal and unaudited** (maintenance and audit both skip the durable tier); superseded/archived rows with ~15 KB embeddings accumulate forever; entities have no lifecycle at all. The 150-row recall window eventually starves episodic memories out. | P1 |
| C4 | Dead protocol surface: `tool_data`/`offline`/`tool_error` SSE events are emitted but unconsumed; routing status labels exist for 4 of ~38 tools; `done_reason` (truncation at num_predict) is ignored with no "continue" affordance. | P2 |
| C5 | No message editing / branching; no in-conversation summarization (history is a hard 800-token clamp against an 8192 context — ~90% of the window unused); attached docs hard-truncate at 8k chars despite a RAG ingest lib existing. | P2 |
| C6 | Household-shared facts unsupported: character-global scope (`user_id = null`) exists in schema with zero writers — the dog's name must be re-learned per family member. | P2 |
| C7 | Benchmark blind spots: no multi-intent/follow-up/misfire-negative cases; tier attribution inferred from `<30 ms` wall time (mislabels under load); latency test calls a stale 4-arg `routePrompt` signature. | P2 |

### 3.5 Humanistic quality

| # | Finding | Where | Priority |
|---|---|---|---|
| H1 | **Relationship progression is dead code**: `friendshipLine()` ("You've known each other for 3 weeks") has zero callers. No stranger→old-friend tone arc, no "it's been a while since we talked." | `friendshipMemory.ts:5-15` | **P0** (trivial) |
| H2 | **Unprompted callbacks are structurally forbidden**: the anti-parroting header orders "Never mention, reference, or hint at these facts unprompted — especially not in greetings," and the judge discards all moods/temporary states. The companion can never ask "how'd the interview go?" or "you sounded stressed yesterday — better?" The pendulum swung from creepy parroting to polite amnesia. | `recall.ts:282`, `judge.ts:68` | P1 |
| H3 | **The avatar emotion system is unreachable**: moods are driven by `<action>` XML tags that VOICE_RULE explicitly bans; prosody already fell back to sentiment regexes, but the emotion faces (happy/laugh/love/surprised) can effectively never fire. | `moods.ts:7-10` vs `companionPrompt.ts:29-31` | P1 |
| H4 | `expressiveness` (per-character prosody swing, 0–1) is stored, has an admin slider, and is never consumed — `prosody.ts:28` hardcodes 1.0. | `prosody.ts:28` | **P0** (trivial) |
| H5 | **directReply has zero personality**: HA confirmations, alarm acks — the highest-frequency voice interactions — are verbatim canned strings; every character sounds identical. | `companionTurn.ts:265-273` | P1 |
| H6 | Time is a clock, not a rhythm: no part-of-day energy guidance, and server-local time is wrong for remote clients. | `companions.ts:288-289` | P1 |
| H7 | Personality is a single authored paragraph: `backstory` is display-only copy; no example dialogue (few-shot voice samples are the biggest lever for small-model voice fidelity), no likes/never-says, no per-character override of hardcoded fragments (a roleplay character cannot use a single stage direction, awkward given VOICE_RULE applies to text chat too). | `companionPrompt.ts`, `defaultCompanions.ts` | P2 |
| H8 | No proactivity: the companion only ever responds; nothing initiates with context despite alarms/announcements existing in sibling subsystems. | — | P2 |
| H9 | Three surfaces, three minds (§2.1): ask "what's happening around town today?" in chat, overlay, and on a Pod — only the overlay knows (briefing block is overlay-only). | — | P1 (via unification) |
| H10 | Reply-length triple-instruction: character replyStyle vs user depth fragment vs overlay harness line can disagree; proximity means the user's depth setting silently beats the authored cadence, and "keep replies short" fights the bedtime-storyteller persona. | `companionPrompt.ts:15-20`, `companions.ts:306` | P2 |

---

## 4. Improvement design

Four phases, ordered so each unlocks the next. Phase 0 is a day or two of trivial, high-leverage fixes; Phase 1 is the keystone refactor that makes every later fix land once instead of three times.

### Phase 0 — Surgical fixes (each ≤ half a day; do immediately, in any order)

1. **KV-cache repair (S1+S2).** In `companionTurn.ts`, move the date/time/location line to the **tail** of the system prompt (port the documented overlay fix), and rebuild the `models.ts` warmup prefix to byte-match the real prompt head (content-policy block first). Verify with the existing `[CHAT-TIMING] prefill=` logs. *Expected: the single largest first-token-latency win on the chat path; restores turn-1 warm start.*
2. **Judge DELETE → REPLACE (A1).** On DELETE, supersede the old row **and insert the new fact**; reserve pure deletion for negations ("I don't like cheese anymore") via prompt guidance. Preserve `tier`/`importance` maxima on UPDATE instead of overwriting from the new fact.
3. **Cursor safety (R3).** `runJudge` returns a `failed` flag on phase-1 error; the sweep only advances `memoryProcessedThrough` on success, with a small retry budget so one poisoned conversation can't wedge the sweep.
4. **Guard tool execution (R2+A5).** Wrap `tool.execute` in try/catch in `companionTurn.ts` and port `toolTurn.ts`'s `isEmptyResult` guard ("do NOT claim the subject doesn't exist — may be misheard"). Extract the fold-in logic (offline/error/synthesisHint wording) into one shared helper — the two files have already drifted.
5. **Real cancellation (R1).** `try/finally` in the `ollamaChatStream` generators destroying the socket; thread the abort signal so "Stop" frees the GPU, not just the SSE. (Ollama aborts generation when the connection drops.)
6. **Router hygiene (A4+S3+S4).** Reorder `SOCIAL_QUESTION_RE` ahead of the search-intent fast path; require an object (`it/that/this`) in the `can you check…` alternative; pass `timeoutMs: 10_000` to the Tier-2 call; match Tier-2 `num_ctx` to the chat value (or omit it) to stop runner re-inits. Add the misfire phrasings as benchmark cases.
7. **Make the recall threshold real (A3).** Gate the vector pass on **raw cosine** (start ~0.55 for nomic-embed, tune against real memories) before blending importance/recency. Stops top-5 always-inject and most memory parroting.
8. **Two dead wires (H1+H4).** Inject `friendshipLine()` as one stable, KV-safe line near the persona ("You've known each other for 3 months"). Wire `characters.expressiveness` into `prosody.ts` in place of the hardcoded 1.0.

### Phase 1 — One brain (the keystone refactor, ~1–2 weeks)

**1a. Unify the three pipelines behind `runCompanionTurn`** with an options struct:

```ts
runCompanionTurn(ctx, {
  persist: boolean,          // false for overlay/pods
  surface: 'chat' | 'overlay' | 'pod',
  includeBriefing: boolean,  // default true everywhere (it's a sync cache read)
  includeSkills, includeDocs, includeLocale: boolean,
  samplingOverrides?: {...}, // overlay's temp/num_ctx/num_predict
})
```

Standardize one section order (stable → volatile): content policy → persona (+appearance +friendship line) → locale → skills → memory block → briefing → docs → uiContext → interaction fragments → **date/time last**. The overlay route becomes a thin caller; `toolTurn.ts` is deleted after its guards are absorbed. Pods gain briefing + uiContext. One companion, one worldview, three surfaces (fixes H9, halves future maintenance).

**1b. Reliability hardening on the unified path:**
- Persist partial replies on error/cancel with a `truncated` flag + `done` variant (R4); frontend treats close-without-`done` as an error and attempts `streamResume` before surfacing it (R5).
- Route the overlay through genQueue (limits + cancel + reconnect); voice consumer checks `res.ok` and renders `error` events (R6).
- Await the user-message insert (~1 ms on SQLite); serialize turns per conversation (queue key = convId) (R7, R8).
- Detach title generation from `done` (S6); deliver via a follow-up event or list refresh.
- Fold `isToolAllowed`/`isOffline`/skills/docs/tool-config into the existing routing∥memory `Promise.all`; dedupe the double `chatDocuments` read; cache near-static per-user context (protections, ceiling, locale, interaction style) with write-through invalidation (S5).

**1c. Routing accuracy on the unified path:**
- Compute the allowed-tool set **before** routing; exclude denied tools from candidates; fold a "that tool is disabled for you" instruction when the only plausible route was denied (A10).
- Constrain Tier-2 resolution to the candidate set (or log off-candidate matches distinctly so the escape hatch is measurable); generate the Tier-2 system prompt from the actual candidates (~200–400 tokens saved on the 3B router) (A9).
- Tier-1 margin gate: `top1 − top2 < 0.05` at ≥0.65 → escalate to Tier-2 with both tools as candidates (A11).
- Confirmation step for security-sensitive HA domains (lock/cover) using the existing directReply + follow-up-context machinery: "Unlock the front door — yes?" (A17).

### Phase 2 — Memory accuracy (~1 week)

1. **Kill recall staleness (A2).** Keep the block cache, but: run the deterministic entity pass **every turn** (tokenize + Map lookup, no embed — nearly free); bust the cache when a new entity is matched, when message-embedding cosine vs the embedding that produced the cached block exceeds a topic-shift threshold, or every N turns; invalidate conversation-keyed blocks after the sweep writes for that user (the overlay already does its half).
2. **Provenance + source discipline (A7).** One line in the extract prompt: *extract only facts asserted or confirmed by the User; treat Assistant statements as context, never as source.* Populate `sourceText` with the triggering user quote so every memory is auditable.
3. **Entity disambiguation (A8).** When the only alias match is a generic relationship noun and proper names differ, create a new entity instead of merging; switch `relinkEntityIds` to word-boundary matching. Sort dedup candidates by similarity before slicing (A12).
4. **Lifecycle repairs (C3, A14).** Extend the audit to durable non-pinned rows (or let it demote mis-tiered durable junk to episodic); add a purge job for superseded/archived rows older than N months; fix episode generation to summarize the unprocessed span with a since-last-episode check.
5. **Debounce the overlay judge (S7).** Per user+character idle timer (~2 min after last turn) over the accumulated window instead of every turn — 5–10× fewer background 8B calls contending with TTFT.
6. **Temporal grounding (A13).** Pass conversation dates into the extract prompt; resolve relative time to absolute ("married in Aug 2026"); optionally add `eventAt`/`validUntil` columns for true bi-temporal supersession.

### Phase 3 — The humanistic layer (~1–2 weeks; mostly prompt + plumbing, not new subsystems)

1. **Open threads — a carve-out from anti-parroting (H2).** Add a small section to the memory block fed by goal/event-category episodic memories from the last ~7 days: *"Open threads you may ask about once, naturally: …"*. This is the highest warmth-per-token change in the system: it re-enables "how'd the interview go?" while keeping the parroting ban for everything else.
2. **A fast-decay "current state" tier (H2).** Let the judge keep moods/situations ("stressed about a work deadline") with a 3–7-day hard expiry, rendered as "Recently:" — decay answers the original junk objection that led to discarding feelings entirely.
3. **Persona ↔ dial reconciliation (A6).** When `clampDials` lowers a character below its authored identity, append one reconciliation line ("Right now, keep your affection warm but fully non-explicit — express your personality within that"), or ship per-tier persona variants for the mature roster.
4. **Persona-flavored directReply (H5).** Per-character confirmation micro-templates (cheap, deterministic) or a 1-sentence rewrite on the router model with a ~300 ms budget — so alarm/HA acks sound like Pixel vs Sage instead of a machine.
5. **Rhythm and place (H6).** Send client timezone offset with requests; add one part-of-day line ("It's late evening for them — match that energy"). Immediately felt on the bedtime/wellness roster.
6. **Structured persona (H7).** Studio fields for 2–3 in-voice example lines (few-shot), favorite topics, never-says — concatenated into the persona. Make the studio tester call the real prompt assembly so admins tune what ships (A16). Optionally a per-character `allowStageDirections` flag relaxing VOICE_RULE for text-roleplay characters.
7. **Resolve the emote contradiction (H3).** Recommended: drop the `<action>`-tag mood path (it already caused a documented small-model stall) and drive avatar emotion faces from the same sentiment lexicons prosody uses — the wiring exists; the trigger is what's broken.

### Phase 4 — Capability (larger, sequence after the above)

1. **Tool results in history + bounded tool loop (C1).** Persist a compact `[tool: weather → 72°F sunny]` note with each turn so follow-ups elaborate instead of re-searching (retiring the continuation regexes), then allow a bounded 2-step loop during synthesis. Read **all** `tool_calls` from Tier-2 and execute serially (with one-directive-per-turn rules) so "lights off and play jazz" fully executes.
2. **User-facing memory (C2).** A "What I know about you" page in user Settings (view/pin/correct/delete over the shared brain) plus `remember`/`forget` companion tools that write through the judge's dedup. Both accuracy (corrections) and trust — notable gaps for a privacy-first family product.
3. **Household scope (C6).** Give the unused character-global scope a writer: facts the judge tags as household-level ("the wifi password", "the dog's name") land in a family-shared scope, surfaced in the same settings page.
4. **Context-window use (C5).** Raise the history budget with an in-conversation rolling summary once past N turns (the episode machinery is 80% of this); chunk oversized docs through the existing RAG ingest instead of hard truncation.
5. **Benchmark regression suite (C7).** Multi-intent, HA follow-ups with seeded context, misfire negatives from Phase 0, denied-tool cases; return the actual tier from `routePrompt` instead of inferring from wall time; fix the stale 4-arg latency-test call (and consider actually sharing the message embedding between router and recall — the two-model design currently embeds every message twice by necessity, but the seam was clearly once planned).

### Sequencing rationale

- Phase 0 items are independent, each hours of work, and remove the worst user-visible defects (minute-tick prefill stalls, lost facts, dead turns, GPU waste, identity questions being web-searched).
- Phase 1 must precede Phases 2–3: without unification, every prompt/memory/humanistic fix has to be written three times and will drift again — that is precisely how the current bug pattern (fixed-in-one-path) arose.
- Phase 3 is deliberately after Phase 2: proactive callbacks ("open threads") amplify whatever recall injects, so recall precision (A2/A3) must be fixed first or the companion will proactively ask about the wrong things — worse than not asking.

---

## 5. Strengths to preserve (do not regress)

- **Raw-TCP streaming transport** (`ollama.ts:139-319`): hand-rolled chunked parser, UTF-8-safe byte handling, noDelay, tcp_segs/ndjson_chunks diagnostics — this fixed real Bun buffering; keep it through any refactor.
- **genQueue replay** (`genQueue.ts:416-475`): subscribe-live-then-replay with monotonic seq cursors + sessionStorage reconnect. The decoupling of generation from connection is the right architecture; extend it to voice rather than replacing it.
- **The routing cascade**: most tool turns cost zero LLM calls; the 40-tool registry never enters any prompt; the disk-cached embedding index self-heals. Fix the regex edges; keep the shape.
- **directReply**: sub-second smart-home/alarm/playback turns are a genuine differentiator. Phase 3.4 adds personality on top; don't add an LLM to the critical path.
- **Sleep-time judge + entity-first recall**: the design (judge off the request path, deterministic entity pass beating pure cosine, durable/episodic tiers, anti-parroting header, shared brain) is state-of-practice; the fixes above are calibration and bug repair, not redesign.
- **KV-cache-conscious engineering** (memory block caching for prefix stability, boot warmup, the overlay's volatile-tail ordering): the discipline exists — Phase 0 just applies it consistently.
- **Observability**: `[CHAT-TIMING]` laps, `[ROUTER] path/score/top3` logs, three admin benchmarks. Extend (tier tags, injected-memory traces), never remove.

---

## Appendix A — Cross-reference: which fix lives where

| Fix | Findings closed |
|---|---|
| Phase 0.1 KV repair | S1, S2 |
| Phase 0.2–0.3 judge fixes | A1, R3 |
| Phase 0.4 tool guards | R2, A5 |
| Phase 0.5 cancellation | R1 |
| Phase 0.6 router hygiene | A4, S3, S4 |
| Phase 0.7 recall threshold | A3 |
| Phase 0.8 dead wires | H1, H4 |
| Phase 1a unification | H9, H10 (ordering), S1 (structurally), drift class |
| Phase 1b hardening | R4–R8, S5, S6 |
| Phase 1c routing | A9–A11, A17 |
| Phase 2 memory | A2, A7, A8, A12–A14, C3, S7 |
| Phase 3 humanistic | H2, H3, H5–H7, A6, A16 |
| Phase 4 capability | C1, C2, C5, C6, C7 |
| Unscheduled (P2 backlog) | R9, R10, A15, C4, S8, H8 |

## Appendix B — Notable single-file bug list (for quick triage)

| File:line | Bug |
|---|---|
| `companionTurn.ts:317-326` | Volatile time near prompt head busts KV cache every minute |
| `models.ts:117-121` | Warmup prefix no longer matches real prompt head |
| `judge.ts:311-322` | DELETE supersedes old fact, never inserts the new one |
| `sweep.ts:155-160` | Cursor advances even when judge extraction failed |
| `sweep.ts:162-178` | Episodes re-summarize first 60 messages; no dup check |
| `ollama.ts:308-318` | Stream generator has no cleanup — cancel leaks socket + GPU generation |
| `companionTurn.ts:240` | Unguarded `tool.execute` — a throw kills the turn |
| `router.ts:28,55` | Search-intent / contextual-lookup regexes hijack social + weather/HA phrasings |
| `router.ts:381-382` | Tier-2 `num_ctx: 4096` vs chat 8192 → runner re-init thrash |
| `router.ts:398` | Tier-2 tool name matched against full registry, not candidates |
| `recall.ts:171-215` | 0.12 blended threshold ≈ always inject top-5 |
| `blockCache.ts:23` + `companionTurn.ts:144` | 30-min conv-keyed recall cache, never invalidated on chat path |
| `judge.ts:274-283` | Dedup candidates not sorted by similarity before slice(0,5) |
| `judge.ts:209-210, 423-434` | Alias merge on relationship nouns; substring relinking |
| `ChatContext.tsx:876-878` | Stream close without `done` treated as success; clears reconnect cursor |
| `useCompanionStream.ts:46-73` | No `res.ok` check; `error` events ignored |
| `chat.ts:482-488` | Fire-and-forget user-message insert, swallowing catch |
| `chat.ts:548-551` | Title generation blocks `done` |
| `friendshipMemory.ts:5-15` | `friendshipLine()` dead code |
| `prosody.ts:28` | `expressiveness` hardcoded to 1.0; DB column unused |
| `adminLatencyTest.ts:247` | Stale 4-arg `routePrompt` call; embedding silently discarded |
| `adminCompanions.ts:200-202` | Studio tester uses non-production prompt |
| `textFloor.ts:30` | Safety floor skipped entirely when images are attached |
