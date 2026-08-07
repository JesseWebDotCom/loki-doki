# Chat Latency: Architecture & Tuning

This document explains every latency-related decision in the chat pipeline: what we changed, why, and what to watch for. Keep it updated when the pipeline changes.

---

## The Problem We Solved

Out of the box, chat responses took **5–8 seconds** to the first visible token. After profiling, six independent root causes were found and fixed. Combined, they bring most conversational responses to **200–900ms** first-token.

---

## The Chat Pipeline (in order)

```
User sends message
  └─ 1. Prefs + character load (parallel)
  └─ 2. Load conversation history (trimmed to token budget)
  └─ 3. Routing + memory embed (parallel)
       ├─ Router: cosine similarity → T0 / T1 / T2
       └─ Memory: embed → recall → format block
  └─ 4. Tool execution (if routed)
  └─ 5. Build system prompt
  └─ 6. ollamaChatStream → SSE tokens to browser
```

Timing is logged on every request via `[CHAT-TIMING]` log lines. Use these to diagnose regressions.

---

## Fix 1: KV Cache Warmup Prefix Must Match Chat Exactly

**File:** `backend/src/lib/models.ts` → `warmupModel()`

At startup, we pre-warm the LLM with a dummy `"hi"` message so the first real user message doesn't pay cold-load tax (~1–2s). But **the warmup system prompt must be byte-for-byte identical to the prefix every real chat message will use**, or llama.cpp's KV cache misses and re-prefills the entire context.

**Correct warmup message:**
```typescript
{ role: 'system', content: `Today is ${dateStr}. Be concise: 1 to 3 sentences unless the user asks for more detail.` }
```

**What breaks the cache:**
- Adding or removing words (e.g. warmup uses `"Today is X."` but chat uses `"Today is X. Be concise..."`)
- Including the current time (changes every minute → cache never hits)
- Including per-user memory or character prompt (varies per user → can't pre-warm centrally)

**Rule:** If you change the system prompt prefix in `chat.ts`, update `warmupModel()` to match.

---

## Fix 2: TCP noDelay: Disable macOS Delayed ACK

**File:** `backend/src/llm/ollama.ts` → `ollamaChatStream()`

Bun's built-in HTTP client and its `node:http` compat layer share an internal buffer that held ~80% of generated tokens before emitting any data. Replaced with a raw `node:net` TCP socket using `noDelay: true`.

```typescript
const sock = createConnection({ host, port, noDelay: true })
```

**Why it matters:** macOS has a 200ms delayed-ACK timer. Without `noDelay`, the kernel waits for ACKs to batch before sending more data. `noDelay` disables Nagle's algorithm on our socket, which also suppresses the delayed-ACK wait on the Ollama side.

**Diagnostic:** After every stream, the log emits:
```
[OLLAMA-TCP] tcp_segs=N ndjson_chunks=M
```
- `tcp_segs ≈ ndjson_chunks` → true per-token streaming (each segment carries one JSON chunk)
- `tcp_segs << ndjson_chunks` → Ollama is batching internally

**Note:** Even with per-token TCP delivery, Ollama still batches internally based on `n_batch` (default 512). If a response is shorter than one batch, all tokens arrive at once near the end of generation. The token cap (Fix 4) is the real fix for this.

---

## Fix 3: Disable Model Thinking Mode

**File:** `backend/src/llm/ollama.ts`

Gemma 4 and similar "thinking" models spend hidden reasoning tokens before producing visible output. These tokens:
- Count toward `num_predict` (the generation cap)
- Do **not** appear in `chunk.message.content`
- Produce `gen=100` in logs with no `first-token` log and no visible response in the UI

With thinking enabled and `num_predict=100`, the model could spend all 100 tokens reasoning and produce zero visible output. The response would silently disappear.

**Fix:** Add `think: false` to every Ollama request body (both streaming and non-streaming):
```typescript
JSON.stringify({ model, messages, stream: true, keep_alive: -1, options, think: false })
```

This is applied globally in `ollamaChat()` and `ollamaChatStream()`. It's a no-op for models that don't support thinking.

---

## Fix 4: Token Ceiling (num_predict)

**File:** `backend/src/routes/chat.ts`

**Key principle:** `num_predict` is a **ceiling, not a target.** The model stops at natural completion or the cap, whichever comes first. A high ceiling does not slow down short answers: snappiness comes from time-to-first-token, not from the cap.

**The one real problem:** Without any cap, the model generates 250–330 tokens for "hi" regardless of the brevity instruction. Ollama's internal batch size (`n_batch ≈ 512`) means all those tokens are generated before any TCP flush, so first-token latency equals total generation time for short messages.

**Solution:** One targeted cap for short messages only.

| Message type | Cap | Rationale |
|---|---|---|
| Short conversational (≤20 chars) | 60 tokens | Model ignores brevity for greetings: cap enforces it |
| Everything else (long, tool responses) | 2048 tokens (user pref wins) | Ceiling only: model stops when done; never cuts off |

```typescript
// Short conversational messages only: model ignores brevity instruction for greetings
if (!tool && message.trim().length <= 20) {
  options['num_predict'] = Math.min(options['num_predict'] as number, 60)
}
```

User can override `num_predict` via `max_tokens` preference. Default is 2048.

**At 60 tok/s generation speed:**
- 60-token cap → ~1s max (short messages)
- 2048-token ceiling → model stops naturally; actual time matches response length

**What was tried and abandoned:** A 150-token cap for "long conversational" messages was added in a prior iteration to keep factual answers brief. It caused cutoffs on any list-style or multi-part answer (e.g. "list every Star Wars movie"). The research finding that settled this: no major production chat app (ChatGPT, Claude.ai, open-webui, LibreChat) uses per-query dynamic token budgeting; they all rely on a generous static ceiling and let the model stop naturally.

---

## Fix 5: Per-Conversation Memory Cache

**File:** `backend/src/routes/chat.ts`

On the first turn of a conversation, we embed the message and recall relevant memories (~50–150ms). On subsequent turns in the same conversation, the memory block is identical: recalling again would waste time AND change the system prompt prefix, breaking the KV cache.

**Solution:** Cache the memory block per `conversationId` with a 30-minute TTL:
```typescript
const CONV_MEM_TTL_MS = 30 * 60 * 1000
const convMemCache = new Map<string, MemCacheEntry>()
```

- **Turn 1:** Embed + recall in parallel with routing. Cache result.
- **Turn 2+:** Instant cache hit. Memory block is the same → system prompt prefix is stable → KV cache hits.

The 30-minute TTL aligns with the background memory sweep (which adds new memories after 5+ minutes of idle). After 30 minutes, the cache expires and the next message re-computes.

---

## Fix 6: Dedicated T2 Router Model (granite4.1:3b)

**Files:** `backend/src/lib/router.ts`, `backend/src/lib/models.ts`, `backend/src/lib/catalog.ts`

T2 routing (ambiguous messages that need LLM-based tool selection) previously used the main 12B chat model. This caused:
- T2 calls blocking the main model during chat
- Higher latency (~3s) because the 12B model is slow
- KV cache pollution (different `num_ctx` setting required for routing)

**Solution:** Separate router model (`granite4.1:3b`, IBM, 2.1GB):
- Benchmarked at 93% routing accuracy, ~1.8s T2 average
- Has its own KV cache; doesn't interfere with chat model
- Configured via DB setting `router_llm_model` or `ROUTER_MODEL` env var
- Falls back to the main chat model if not set

**Selection:** Evaluated several small non-Chinese models:
- `gemma3:4b`, disqualified: 37% accuracy (doesn't call tools, returns null)
- `granite4.1:3b`, selected: 93% accuracy, native Ollama tool calling support
- All Qwen variants: excluded by design (Chinese origin)

---

## Fix 7: Search Intent Regex Bypass

**File:** `backend/src/llm/router.ts`

all-minilm scores "what is X", "who is X", "tell me about X" queries at ~0.20 regardless of how well tool capability descriptions are written. The embedding model simply doesn't generalize well for open-ended topic queries. Rather than tuning thresholds or adding endless examples, a regex matches these patterns deterministically, before the embed call, faster and more reliable:

```typescript
const SEARCH_INTENT_RE = /\b(what is|what are|what was|what were|who is|who was|who are|tell me about|explain to me|how does|how do|how did|have you heard of|do you know about|what happened to|what's up with)\b/i
```

This runs **before** the embedding step. If it matches, the message goes straight to search passthrough with no embed call, no score check, no T2 LLM call.

**What NOT to do:**
- Don't gate this on an embedding score threshold: the whole point is that scores are unreliable for these patterns.
- Don't try to solve this by adding more examples to the search tool's examples array: adding 50 "what is X" variations was tried and still scored 0.20 because all-minilm can't generalize the intent.

**False positive surface:** `"what are you"`, `"how do you feel"`, `"what is happening in the conversation"` will route to search. Acceptable: the search result is either informative (for AI questions) or the tool gracefully returns empty results and the model falls back to its own answer. The alternative (broken routing for all topic queries) is worse.

---

## Fix 8: Tool Examples → Capability Descriptions

**Files:** all `backend/src/tools/*.ts`

Original approach: each tool had 15–25 example *user utterances* ("what is red letter media", "what is covid", etc.). Problems:
- all-minilm matches syntactically similar sentences, not semantically equivalent intents
- "what is claude mythos" scored 0.215 even though "what is red letter media" was literally in the examples
- Required constant maintenance: can never enumerate all phrasings

Replacement: 4–8 **capability descriptions** per tool, phrases that describe what the tool *does*, not what users *say*:

```
// Before (search tool, 30+ examples):
'what is red letter media',
'what is covid',
'what is perverted justice',
...

// After (search tool, 8 descriptions):
'find information about any topic, person, company, or concept online',
'look up what something is or who someone is',
'search the web for facts or background on any named subject',
...
```

Capability descriptions generalize to any user phrasing because the semantic match is between the user's *intent* and the tool's *purpose*, not between two specific sentences. This is the correct abstraction.

**Startup cost:** `initRouter()` embeds all examples in parallel at startup and caches to `data/router-index.json`, keyed by a hash of all example text. Subsequent restarts with unchanged examples load the cache instantly. The cache is automatically invalidated whenever any tool's examples change.

---

## Fix 9: Memory Block: Don't Volunteer Facts Unprompted

**File:** `backend/src/memory/recall.ts`

The memory block is injected into the system prompt as background context. The original instruction said "do not volunteer these facts unless the user brings them up first", but the model ignored it for greetings, responding to "hi" with "Are you in the mood to talk about Tom Petty?" (referencing a memory about the user's music taste).

**Fix:** Stronger, more literal instruction:

```
[Background context about the user. Use ONLY when directly relevant to what the user just asked. Never mention, reference, or hint at these facts unprompted, especially not in greetings or small talk. Do not say "I know you like X" or "since you enjoy Y". Wait for the user to raise a topic before using any of this.]
```

**Key additions over the original:**
- "especially not in greetings or small talk": the model needs explicit anti-patterns
- `"I know you like X"` and `"since you enjoy Y"`: explicit forbidden phrases
- "hint at": closes the loophole of indirect references

---

## Fix 10: datetime Tool: current_time Operation

**File:** `backend/src/tools/datetime.ts`

"What time is it" routed to the datetime tool but the tool had no `current_time` operation: only `time_in_timezone` (requires a timezone argument). The LLM correctly concluded it couldn't answer and asked the user for their timezone.

Added `current_time` operation (no args required) and updated the tool description to list it first:

```typescript
case 'current_time': {
  const timeStr = shortTime(now)
  const dateStr = longDate(now)
  return { success: true, data: { time: timeStr, date: dateStr, answer_payload: { gist: `${timeStr}, ${dateStr}` } } }
}
```

---

## Three-Tier Router Architecture

**File:** `backend/src/llm/router.ts`

```
Message arrives
  └─ Embed with all-minilm (router embed model)
  └─ Cosine similarity against all tool examples
  └─ Score < 0.40 → T0: Conversational (no LLM call)
  └─ Score 0.40–0.65 → T2: Ambiguous (granite4.1:3b LLM call, top-3 candidates)
  └─ Score ≥ 0.65 → T1: Confident match
       ├─ passMessage tool → direct passthrough (no LLM call)
       └─ non-passthrough → T2 narrowed to 1 candidate (arg extraction only)
```

**Thresholds:**
```typescript
const CONVERSATIONAL_MAX = 0.40   // below = definitely not a tool call
const SIMILARITY_THRESHOLD = 0.65 // at/above = confident tool match
```

**Tuning thresholds:** Observe `[ROUTER]` logs. Each log line includes the top-3 cosine scores. If a tool call is missed (score below 0.40 for a message that should route), the tool's example phrases need more natural language variations.

---

## History Token Budget

**File:** `backend/src/routes/chat.ts`

We load the last 40 messages from DB but trim to an 800-token budget before sending to the LLM. Older context is covered by the memory system.

```typescript
const TOKEN_HISTORY_BUDGET = 800
```

**Why 800:** At actual observed prefill rates (~1.5 tok/ms for the 12B model), 800 tokens ≈ 533ms of prefill. Going higher (e.g. 1500 tokens) adds ~467ms per turn. The memory system handles long-term context.

**Minimum:** Always keep at least 4 messages (2 turns) regardless of budget.

---

## System Prompt Stability Rules

The system prompt is assembled in this order:
```
1. Date prefix + brevity instruction  ← STABLE (24h)
2. Character personality prompt        ← varies per character
3. Memory block                        ← stable within conversation (cached)
4. UI context                          ← varies per page/feature
```

**Rule:** Only prefixes that are identical across turns benefit from KV cache. The date is stable for 24h. Time was removed (it changed every minute). Per-user and per-conversation content (memory, character) can't be centrally cached, but the date prefix alone saves significant prefill work.

**`prompt_eval_duration=0`** in the done chunk means a perfect KV cache hit: zero prefill. This is the ideal state for turns 2+ in a conversation.

---

## Benchmark Tools

### Chat Benchmark (Admin → Troubleshooting)

`GET /api/admin/chat-benchmark/stream`

Runs 9 tests in sequence via SSE, using `ollamaChat` (non-streaming, `stream: false`) for reliable timing. Reports Ollama's own prefill/generation/load breakdowns.

Tests: bare LLM · +system · +memory · +history · +history+memory · routing T1 · routing T2 · KV cache 1st hit · KV cache 2nd hit

### Router Benchmark (Admin → Troubleshooting)

`GET /api/admin/router-benchmark/stream?model=MODEL`

30-test accuracy + speed benchmark. Tests natural language variations (e.g. weather: "will it rain?", "should I bring an umbrella?", "do I need a coat?"). Scores tool selection correctness and arg extraction.

### CLI Router Benchmark

```bash
cd backend
bun run ../scripts/router-bench.ts granite4.1:3b
```

Prints per-test ✓/✗, category breakdown, accuracy %, T2 average latency. No auth required.

---

## Observed Performance (June 2026)

**Model:** huihui\_ai/gemma-4-abliterated:latest (12B), Apple Silicon

| Scenario | First-token | Total |
|---|---|---|
| "hi" (KV cache hit, turn 2+) | 230–480ms | 400–650ms |
| "hi" (turn 1, cold KV) | 500–700ms | 700–1100ms |
| Factual conversational | 200–900ms | 1.5–2.5s |
| Tool call (T2 route + execute + synth) | 5–8s | 7–10s |
| T2 route only (granite4.1:3b) | n/a | 1.8–2.8s |

Tool call latency breakdown:
- T2 routing: ~1.8–2.8s (granite4.1:3b)
- Tool API execution: 0.5–1.5s (search, weather, etc.)
- Prefill with tool results in context: 1–2s (large context)
- Generation (synthesis): ~1.7s (100 tokens)

---

## Re-plan Hook (dead ends only) — added 2026-07

**Files:** `backend/src/llm/router.ts` → `replanAfterDeadEnd()`, `backend/src/lib/companionTurn.ts` → `tryReplan()`

A routed tool that returns **no results or an error** buys exactly ONE more attempt: the router
model re-picks (same tool with a corrected/broader query, or a fall back to search) and the result
is adopted as if it had been the original route.

**Why it costs the happy path nothing:** it is a dead-end hook, not a loop around every turn. A
successful tool call never calls it. Only the already-broken path (which was heading for "I found
nothing" anyway) pays the extra ~2–3s router call + tool execution.

**Bounds:** one hop per turn (`replanUsed`), skipped on primes and multi-intent turns, candidate set
is just `[deadTool, search]` (2 schemas — keeps granite4.1:3b near its floor), `REPLAN_TIMEOUT_MS =
8_000`, and a second dead end gives up rather than looping.

**Timing:** look for `[CHAT-TIMING] replan-tool-done(<tool>)`, and `[ROUTER] replan result=…`.

## Companion Status Cue — added 2026-07

`companionTurn` emits a `status` SSE event (`working`/`searching`/`retrying`) alongside `routing`.
It is metadata only — no model call, no added latency — and drives the companion's wordless
"working" affordance. A `spoken_cue` event fires ONLY on a re-plan; the phrases are a static
in-process list, so no LLM call is ever made in the request path to produce them.

## Background LLM Work Must Yield to Conversation (2026-08 regression)

**Files:** `backend/src/lib/youtube/popupFacts.ts`, `backend/src/lib/activityGate.ts`, `backend/src/lib/idleScheduler.ts`

The August 2026 "chats take 15+ seconds" regression: Pop-Up Facts moved its writing pass onto the MAIN chat model (it needs world knowledge) and kicked a build at watch time for every uncached video. Ollama serializes requests per model, so a live chat turn sent during a build queued behind a multi-thousand-token prefill plus a 900-token generation on the power-capped prod GPU, then paid full re-prefill because the build clobbered the chat KV prefix. The v5 to v9 cache-namespace bumps (each discarding every cached result) made rebuilds near-constant.

The rule: **any not-user-waiting LLM call on the chat model must (1) defer its start behind `backgroundGateSnapshot()` / `waitForInteractiveIdle()`, and (2) if the generation is long, run STREAMED with a cancelRef and abort when a live turn arrives** (`interactiveIdleMs() < elapsed` is the signal; see `llmWriteFacts`). `ollamaChat` with `stream: false` cannot be preempted, so it is the wrong call shape for long background generations. Fast-model calls (entity extraction, worth-it verdicts) are exempt: they are short and live on a different model.

Precompute-band jobs (`lib/precompute.ts`) already get (1) from the opportunistic gate in downloadJobs; they still lack (2), so keep their generations short or add the same abort pattern if one grows.

## What NOT to Change Without Re-Testing

1. **Warmup system prompt**: must stay in sync with `chat.ts` prefix or KV cache misses on every first turn
2. **`think: false`**: removing this re-enables thinking mode; hidden reasoning tokens exhaust `num_predict` before any visible output → silent/empty responses
3. **`CONVERSATIONAL_MAX = 0.40`**: lowering routes more to T0 (tools get skipped); raising increases T2 calls. "hi" scores ~0.265, so anything above that breaks greetings.
4. **`SEARCH_INTENT_RE`**: do not add a score threshold back. The regex fires unconditionally because all-minilm scores "what is X" at ~0.20 regardless of examples or descriptions. A score gate silently breaks all topic queries.
5. **Tool `examples` arrays**: they are now **capability descriptions**, not user utterances. Do not revert to user utterances. Adding "what is [specific thing]" examples does not help; all-minilm doesn't generalize from them. If a tool isn't routing correctly, check whether the capability description is specific enough and whether SEARCH_INTENT_RE covers the pattern.
6. **Memory block instruction**: the "never mention unprompted" wording is intentionally explicit. Softening it causes the model to volunteer memories in greetings (Tom Petty problem).
6a. **Presentation policy position + warmup**: `PRESENTATION_POLICY` (`lib/presentationPrompt.ts`) is the FIRST system-prompt part on text surfaces and is duplicated into `warmupModel()`. Change one and you must change the other, or turn 1 of every conversation pays full prefill again. It is suppressed on voice surfaces on purpose (nothing in it is speakable).
6b. **Re-plan stays dead-end-only**: do not "improve" `tryReplan` into a loop that runs on successful tool calls. That converts a rare recovery into a per-turn ~2–3s tax on the happy path.
7. **Memory cache TTL**: if lowered below the sweep idle window (5 min), memory re-computation changes the system prompt mid-conversation and breaks KV cache
8. **History token budget**: raising above 1200 adds perceptible prefill delay per turn

## Common Regression Patterns

| Symptom | Likely cause |
|---|---|
| "hi" gets no response or empty response | `think: false` removed: model is burning tokens on reasoning |
| First message of every conversation is slow (4–6s) | Warmup system prompt drifted from `chat.ts` prefix |
| "what is X" answered from model knowledge (wrong) | `SEARCH_INTENT_RE` not matching or search tool disabled |
| Model mentions Tom Petty / user memories in greetings | Memory block instruction weakened or removed |
| All tools stop routing | `routeIndex.length === 0`: all-minilm failed to warm up, `initRouter()` skipped |
| T2 routing very slow (>4s) | granite4.1:3b not running; check `ROUTER_MODEL` env var and Ollama |
| Long responses cut off mid-sentence | `num_predict` cap hit; default is 2048, check user's `max_tokens` preference in DB |
| Responses stream all at once instead of token by token | `noDelay: true` removed from TCP socket, or switched back to `fetch`/Bun.connect |
| Chats slow (10-30s first token) only sometimes, worse while videos are being watched | A background job is occupying the main chat model. Check `[CHAT-TIMING] first-token` against Ollama queue time; audit new `getModel()` callers for missing idle gating (see "Background LLM Work Must Yield to Conversation") |
