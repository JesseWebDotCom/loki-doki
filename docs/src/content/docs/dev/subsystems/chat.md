---
title: Chat & Routing
description: Chat pipeline architecture, latency optimizations, three-tier router, and tuning rules.
sidebar:
  order: 1
---

import { Aside } from '@astrojs/starlight/components';

This page covers every latency-related decision in the chat pipeline: what was changed, why, and what to watch for. Keep it updated when the pipeline changes.

---

## The Chat Pipeline

```
User sends message
  └─ 1. Prefs + companion load (parallel)
  └─ 2. Load conversation history (trimmed to token budget)
  └─ 3. Routing + memory embed (parallel)
       ├─ Router: cosine similarity → T0 / T1 / T2
       └─ Memory: embed → recall → format block
  └─ 4. Tool execution (if routed)
  └─ 5. Build system prompt
  └─ 6. ollamaChatStream → SSE tokens to browser
```

Timing is logged on every request via `[CHAT-TIMING]` lines. Use these to diagnose regressions.

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

**Tuning:** Observe `[ROUTER]` logs. Each line includes the top-3 cosine scores. If a tool call is missed (score below 0.40), the tool's example phrases need more natural language variations.

---

## Fix 1, KV Cache Warmup Prefix Must Match Chat Exactly

**File:** `backend/src/lib/models.ts` → `warmupModel()`

At startup we pre-warm the LLM with a dummy `"hi"` message so the first real message doesn't pay cold-load tax (~1–2s). The warmup system prompt **must be byte-for-byte identical** to the prefix every real chat message uses, or llama.cpp's KV cache misses and re-prefills the entire context.

**Correct warmup message:**
```typescript
{ role: 'system', content: `Today is ${dateStr}. Be concise — 1 to 3 sentences unless the user asks for more detail.` }
```

**What breaks the cache:** adding/removing words; including current time (changes every minute); including per-user memory or companion prompt.

<Aside type="caution">
If you change the system prompt prefix in `chat.ts`, update `warmupModel()` to match. A drift causes 4–6s first-message latency on every conversation.
</Aside>

---

## Fix 2, TCP noDelay: Disable macOS Delayed ACK

**File:** `backend/src/llm/ollama.ts` → `ollamaChatStream()`

Replaced Bun's HTTP client with a raw `node:net` TCP socket using `noDelay: true`:

```typescript
const sock = createConnection({ host, port, noDelay: true })
```

macOS has a 200ms delayed-ACK timer. Without `noDelay`, the kernel waits for ACKs to batch before sending more data. `noDelay` disables Nagle's algorithm on our socket, which also suppresses the delayed-ACK wait on the Ollama side.

**Diagnostic:** After every stream, the log emits:
```
[OLLAMA-TCP] tcp_segs=N ndjson_chunks=M
```
- `tcp_segs ≈ ndjson_chunks` → true per-token streaming
- `tcp_segs << ndjson_chunks` → Ollama is batching internally

---

## Fix 3, Disable Model Thinking Mode

**File:** `backend/src/llm/ollama.ts`

Add `think: false` to every Ollama request body:
```typescript
JSON.stringify({ model, messages, stream: true, keep_alive: -1, options, think: false })
```

Without this, thinking models (Gemma 4, etc.) spend hidden reasoning tokens before any visible output. Those tokens count toward `num_predict` but don't appear in `chunk.message.content`. With a 100-token cap, the model can exhaust the budget on reasoning and produce zero visible output, the response silently disappears.

---

## Fix 4, Token Ceiling (num_predict)

**File:** `backend/src/routes/chat.ts`

`num_predict` is a **ceiling, not a target.** The model stops at natural completion or the cap, whichever comes first.

| Message type | Cap | Rationale |
|---|---|---|
| Short conversational (≤20 chars) | 60 tokens | Model ignores brevity for greetings, cap enforces it |
| Everything else | 2048 tokens | Ceiling only, model stops when done; never cuts off |

```typescript
if (!tool && message.trim().length <= 20) {
  options['num_predict'] = Math.min(options['num_predict'] as number, 60)
}
```

At 60 tok/s generation speed, the 60-token cap means ~1s max for short messages. The reason for the cap: without it, Ollama's internal batch size (`n_batch ≈ 512`) causes all tokens to be generated before any TCP flush, making first-token latency equal total generation time.

---

## Fix 5, Per-Conversation Memory Cache

**File:** `backend/src/routes/chat.ts`

```typescript
const CONV_MEM_TTL_MS = 30 * 60 * 1000
const convMemCache = new Map<string, MemCacheEntry>()
```

- **Turn 1:** Embed + recall in parallel with routing. Cache result.
- **Turn 2+:** Instant cache hit. Memory block is stable → system prompt prefix is stable → KV cache hits.

The 30-minute TTL aligns with the background memory sweep (adds new memories after 5+ min idle).

---

## Fix 6, Dedicated T2 Router Model (granite4.1:3b)

**Files:** `backend/src/lib/router.ts`, `backend/src/lib/models.ts`

T2 routing previously used the main 12B chat model. This caused blocking, higher latency (~3s), and KV cache pollution.

**Solution:** Separate router model (`granite4.1:3b`, IBM, 2.1GB):
- 93% routing accuracy, ~1.8s T2 average
- Own KV cache, doesn't interfere with chat model
- Configured via DB setting `router_llm_model` or `ROUTER_MODEL` env var

**Selection rationale:** `gemma3:4b` scored 37% (doesn't call tools); all Qwen variants excluded by design (Chinese origin).

---

## Fix 7, Search Intent Regex Bypass

**File:** `backend/src/llm/router.ts`

`all-minilm` scores "what is X", "who is X", "tell me about X" at ~0.20 regardless of tool descriptions. A regex matches these patterns deterministically before the embed call:

```typescript
const SEARCH_INTENT_RE = /\b(what is|what are|what was|what were|who is|who was|who are|tell me about|explain to me|how does|how do|how did|have you heard of|do you know about|what happened to|what's up with)\b/i
```

If it matches, the message goes straight to search passthrough with no embed call.

<Aside type="danger">
Do not add a score threshold back. The regex fires unconditionally because all-minilm scores "what is X" at ~0.20 regardless of examples. A score gate silently breaks all topic queries.
</Aside>

---

## Fix 8, Tool Examples → Capability Descriptions

**Files:** all `backend/src/tools/*.ts`

Tool examples are **capability descriptions** (what the tool *does*), not user utterances (what users *say*):

```typescript
// Correct — capability descriptions:
'find information about any topic, person, company, or concept online',
'look up what something is or who someone is',

// Wrong — user utterances (do not revert):
'what is red letter media',
'what is covid',
```

Capability descriptions generalize to any user phrasing because the semantic match is between user intent and tool purpose, not two specific sentences.

**Startup:** `initRouter()` embeds all examples in parallel and caches to `data/router-index.json`, keyed by a hash of all example text. Automatically invalidated when tool examples change.

---

## Fix 9, Memory Block: Don't Volunteer Facts Unprompted

**File:** `backend/src/memory/recall.ts`

The memory block uses an intentionally explicit instruction:

```
[Background context about the user. Use ONLY when directly relevant to what the user just asked.
Never mention, reference, or hint at these facts unprompted — especially not in greetings or small talk.
Do not say "I know you like X" or "since you enjoy Y". Wait for the user to raise a topic before using any of this.]
```

Softening this wording causes the model to volunteer memories in greetings ("Are you in the mood to talk about Tom Petty?").

---

## Fix 10, datetime Tool: current_time Operation

**File:** `backend/src/tools/datetime.ts`

Added `current_time` operation (no args required):

```typescript
case 'current_time': {
  const timeStr = shortTime(now)
  const dateStr = longDate(now)
  return { success: true, data: { time: timeStr, date: dateStr, answer_payload: { gist: `${timeStr} — ${dateStr}` } } }
}
```

Without this, "what time is it" routed to the datetime tool but the tool had no argless operation, the LLM asked the user for their timezone.

---

## History Token Budget

**File:** `backend/src/routes/chat.ts`

```typescript
const TOKEN_HISTORY_BUDGET = 800
```

We load the last 40 messages but trim to 800 tokens. At ~1.5 tok/ms prefill, 800 tokens ≈ 533ms. Older context is covered by the memory system. Raising above 1200 adds perceptible prefill delay per turn. Always keep at least 4 messages (2 turns) regardless of budget.

---

## System Prompt Stability Rules

```
1. Date prefix + brevity instruction  ← STABLE (24h)
2. Companion personality prompt        ← varies per companion
3. Memory block                        ← stable within conversation (cached)
4. UI context                          ← varies per page/feature
```

`prompt_eval_duration=0` in the done chunk means a perfect KV cache hit, zero prefill. This is the ideal state for turns 2+ in a conversation.

---

## Observed Performance (June 2026)

**Model:** huihui_ai/gemma-4-abliterated:latest (12B), Apple Silicon

| Scenario | First-token | Total |
|---|---|---|
| "hi" (KV cache hit, turn 2+) | 230–480ms | 400–650ms |
| "hi" (turn 1, cold KV) | 500–700ms | 700–1100ms |
| Factual conversational | 200–900ms | 1.5–2.5s |
| Tool call (T2 route + execute + synth) | 5–8s | 7–10s |
| T2 route only (granite4.1:3b) |, | 1.8–2.8s |

---

## What NOT to Change Without Re-Testing

1. **Warmup system prompt**: must stay in sync with `chat.ts` prefix or KV cache misses on every first turn
2. **`think: false`**, removing re-enables thinking mode; hidden tokens exhaust `num_predict` → silent responses
3. **`CONVERSATIONAL_MAX = 0.40`**, "hi" scores ~0.265; anything above that breaks greetings
4. **`SEARCH_INTENT_RE`**, do not add a score threshold back
5. **Tool `examples` arrays**, they are capability descriptions, not utterances; do not revert
6. **Memory block instruction**: the explicit wording is intentional; softening it causes Tom Petty problem
7. **Memory cache TTL**: if lowered below the sweep idle window (5 min), re-computation breaks KV cache
8. **History token budget**: raising above 1200 adds perceptible prefill delay per turn

---

## Common Regression Patterns

| Symptom | Likely cause |
|---|---|
| "hi" gets no response or empty response | `think: false` removed |
| First message of every conversation slow (4–6s) | Warmup system prompt drifted from `chat.ts` prefix |
| "what is X" answered from model knowledge (wrong) | `SEARCH_INTENT_RE` not matching or search tool disabled |
| Model mentions memories in greetings | Memory block instruction weakened or removed |
| All tools stop routing | `routeIndex.length === 0`, all-minilm failed to warm up |
| T2 routing very slow (>4s) | granite4.1:3b not running; check `ROUTER_MODEL` env var |
| Long responses cut off mid-sentence | `num_predict` cap hit, check user's `max_tokens` preference in DB |
| Responses stream all at once | `noDelay: true` removed or switched back to `fetch`/`Bun.connect` |

---

## Benchmark Tools

### Chat Benchmark
`GET /api/admin/chat-benchmark/stream`

9 tests via SSE using `ollamaChat` (non-streaming for reliable timing). Reports Ollama's own prefill/generation/load breakdowns.

Tests: bare LLM · +system · +memory · +history · +history+memory · routing T1 · routing T2 · KV cache 1st hit · KV cache 2nd hit

### Router Benchmark
`GET /api/admin/router-benchmark/stream?model=MODEL`

30-test accuracy + speed benchmark. Natural language variations per tool. Scores tool selection correctness and arg extraction.

### CLI Router Benchmark
```bash
cd backend && bun run ../scripts/router-bench.ts granite4.1:3b
```
