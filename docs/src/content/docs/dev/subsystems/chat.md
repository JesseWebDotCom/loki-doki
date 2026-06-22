---
title: Chat & Routing
description: The chat pipeline, semantic router, tool calling, memory, SSE streaming contract, and the message-render performance rules.
sidebar:
  order: 1
---

import { Aside } from '@astrojs/starlight/components';

This page covers the chat subsystem end to end: how a message flows from the browser to Ollama and back, how the router decides whether to call a tool, how long-term memory is recalled, and the two performance contracts (server-side streaming and client-side rendering) that keep it fast. Keep it updated when the pipeline changes.

## High-Level Flow

```
Browser (ChatContext.submit)
  └─ POST /api/chat/stream
       └─ chat.ts: load prefs + companion + content ceilings (parallel)
       └─ resolve content dials, model, options, conversation
       └─ enqueue a genQueue job (decouples generation from the connection)
       └─ stream a `gen` event, then tail the job over SSE
            └─ makeChatRun closure (runs inside genQueue):
                 ├─ persist user message (fire-and-forget)
                 ├─ routing + memory recall (parallel)
                 ├─ tool execute (if routed) → emit block / sources / tool_data
                 │    └─ snappy path: directReply → emit + done, skip the LLM
                 ├─ build system prompt (content + date + companion + memory + UI)
                 └─ ollamaChatStream → emit `token` events → persist final message
```

Every stage is timed. Look for `[CHAT-TIMING] <label> +<ms>ms` lines to diagnose regressions.

Key files:

- `backend/src/routes/chat.ts`: the HTTP endpoints and the `makeChatRun` pipeline
- `backend/src/lib/genQueue.ts`: the generation queue (decouples work from the socket)
- `backend/src/llm/router.ts`: the two-tier semantic router
- `backend/src/llm/ollama.ts`: the raw-TCP streaming client
- `backend/src/memory/recall.ts` + `backend/src/memory/sweep.ts`: recall and the background memory writer
- `backend/src/tools/index.ts`: the tool registry
- `frontend/src/context/ChatContext.tsx`: the client stream consumer
- `frontend/src/components/chat/MessageList.tsx` + `ChatMessage.tsx`: the render contract

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/chat/conversations` | List the caller's conversations (optionally filtered by `projectId`); each row carries a `preview` of the last message. |
| `GET` | `/api/chat/conversations/:id` | One conversation plus its full message list (ownership enforced). |
| `PATCH` | `/api/chat/conversations/:id` | Rename or pin/unpin. |
| `DELETE` | `/api/chat/conversations/:id` | Delete a conversation (cascades to messages). |
| `POST` | `/api/chat/stream` | Start a generation. Returns an SSE stream. |
| `GET` | `/api/chat/stream/:genId?since=N` | Reconnect to an in-flight or recently finished generation, replaying from sequence `N`. |
| `POST` | `/api/chat/stream/:genId/cancel` | Actually stop server-side generation and free the queue slot. |

All routes require auth (`requireAuth`). The stream endpoints set `X-Accel-Buffering: no` so a reverse proxy does not buffer the SSE body.

## genQueue: Generation Outlives the Connection

`POST /api/chat/stream` does not run the model inline. It builds a `run` closure and hands it to `genQueue.enqueue({ type: 'chat', ... })`, then the HTTP handler just subscribes to that job and tails its event buffer.

This matters because **disconnecting is never a stop signal**. The job runs to completion whether or not a browser is attached. Consequences:

- Tokens are buffered in memory on the job (`job.events`, capped at `MAX_BUFFER`), each with a monotonic `seq`. A client that navigates away and comes back reconnects with `GET /api/chat/stream/:genId?since=<lastSeq>` and replays only what it missed.
- To actually halt generation you must `POST .../cancel` (the client's `stop()` does this). Dropping the socket alone leaves the job running by design.
- Jobs are garbage-collected `GC_DELAY_MS` (60s) after they finish. A reconnect after that returns 404, and the client falls back to `GET /conversations/:id` for the persisted final message.
- Per-type FIFO lanes with concurrency limits (`DEFAULT_LIMITS` chat 2 / image 1 / vision 1, overridable via `queue.*` app settings). One user may have at most `MAX_CHAT_WAITING_PER_USER` (3) chat jobs *waiting*; exceeding that returns HTTP 429.

`subscribeAndTail()` is the shared catch-up + live-tail primitive: it subscribes the live listener first, replays buffered events `>= sinceSeq` through a serial write chain, and unsubscribes (without aborting) on disconnect.

## SSE Event Contract

The stream is a sequence of named SSE events. Each carries an `id:` equal to the job's `seq` (the cursor used for resume). Event names and payloads:

| Event | Payload | Meaning |
|---|---|---|
| `gen` | `{ genId, conversationId, assistantMessageId }` | First event. The client stores these to reconnect later and to correlate the placeholder message with the server's real message id. |
| `queue` | `{ position, type }` | Queue position. `0` = a slot was acquired and work is starting. |
| `routing` | `{ tool }` | A tool was selected and is about to run. |
| `tool_data` | `{ tool, data }` | Raw tool result (consumed mainly for debugging/blocks). |
| `block` | a `Block` object | A structured render block (weather card, search results, etc.) to show above the prose. |
| `sources` | `Source[]` | Citation sources; rendered as inline `[1]` chips. |
| `offline` | `{ tool }` | The routed tool needs the internet but offline mode is on. |
| `tool_error` | `{ tool, error }` | The tool ran but failed; the model is told to acknowledge it. |
| `token` | raw text (not JSON) | One chunk of generated prose. Concatenate in order. |
| `done` | `{ model, conversationId, title }` | Generation finished; final message is persisted. Terminal. |
| `error` | error string | Generation failed. Terminal. |
| `cancelled` | `{ jobId }` | The job was cancelled. Terminal. |

<Aside type="note">
`token` data is the literal text, not JSON, so a token can contain any character. The client's SSE parser treats `token` specially and never `JSON.parse`s it.
</Aside>

## The Router (Two-Tier)

**File:** `backend/src/llm/router.ts`. The router answers one question: should this message call a tool, and if so, which one and with what arguments?

It uses a dedicated embedding model, `all-minilm` (`ROUTER_EMBED_MODEL`), distinct from the `nomic-embed-text` model used for memory recall. nomic's compressed similarity space does not threshold cleanly; all-minilm gives a wider spread between conversational and tool-intent messages.

```
routePrompt(message, history, model)
  └─ GREETING_RE matches ("hi", "thanks", "ok", …) → no tool (skip everything)
  └─ SEARCH_INTENT_RE matches ("what is X", "who is X", "look up X", …) → search tool, pass message verbatim (skip the embed)
  └─ embed message with all-minilm, cosine vs every tool's example embeddings
       ├─ best ≥ 0.65  → Tier 1 (confident)
       │     ├─ passMessage tool → pass raw message as the arg, no LLM call
       │     └─ otherwise → narrowed Tier 2: one candidate, LLM extracts args only
       ├─ best < 0.40  → conversational, no tool (skip Tier 2)
       └─ 0.40–0.65    → Tier 2: LLM picks from top-5 candidates (search always injected)
```

Thresholds:

```typescript
const SIMILARITY_THRESHOLD = 0.65       // at/above = confident Tier 1
const CONVERSATIONAL_THRESHOLD = 0.40   // below = clearly not a tool request
const TIER2_TOP_N = 5                    // candidates handed to the Tier 2 LLM
```

Tier 2 (`tier2Call`) sends the candidate tools' `toolDefinition`s to Ollama as function definitions, plus a `TIER2_SYSTEM` prompt of per-tool selection rules and the last `TIER2_HISTORY_LIMIT` (10) messages for context, then reads back `response.message.tool_calls[0]`. It runs on a dedicated router model when one is configured (`router_llm_model` app setting or `ROUTER_MODEL` env var, e.g. `granite4.1:3b`), falling back to the chat model. A separate router model gets its own KV cache so it does not pollute the chat model's.

<Aside type="caution">
`SEARCH_INTENT_RE` fires unconditionally with no score gate. `all-minilm` scores phrasings like "what is X" low regardless of tool examples, so a score threshold would silently break topic queries. Do not add one back.
</Aside>

### Tool examples are capability descriptions

Each tool's `examples` array (embedded at startup) should describe what the tool *does*, not transcribe what a user *says*. Capability descriptions ("find information about any topic, person, or concept online") generalize across phrasings; literal utterances ("what is covid") overfit.

`initRouter()` embeds every example in parallel and caches the index to `data/router-index.json`, keyed by a SHA-256 hash of all example text (`examplesHash()`). Changing any example invalidates the cache automatically; an unchanged restart skips all embed calls.

### The tool registry

**File:** `backend/src/tools/index.ts`. Tools implement the `Tool` interface (`id`, `name`, `examples`, `toolDefinition`, `offline`, optional `passMessage`, `dataSources`, `execute`). Registered tools:

`weather`, `search`, `calculator`, `unit_conversion`, `jokes`, `news`, `recipes`, `dictionary`, `youtube`, `tvshows`, `datetime`, `moonphase`, `image_gen`, `medical`, `whereToWatch`, `holidays`, `homeInventory`, `onthisday`, `localEvents`, `localNews`, `contentRating`, `sports`, `homeAssistant`.

`ToolResult` carries `success`, `data`, and optionally `error`, `offline`, or `directReply`. A `directReply` triggers the **snappy path**: the chat pipeline speaks that text verbatim and skips LLM synthesis entirely (used by Home Assistant, whose action confirmations are already finished sentences).

Per-tool gating happens at run time: `isToolAllowed(tool.id, userId)` can disable a tool for a user, and `tool.offline === false` plus `isOffline(userId)` short-circuits to an "offline" message instead of executing.

## System Prompt Assembly

The system message is assembled in `makeChatRun` from `systemParts`, joined with blank lines, in this order:

1. `buildContentPrompt(activeDials)`: the content-policy preamble (see the content-policy subsystem).
2. The stable line: `Today is <date>.`, plus `You are speaking with <name>.`, location, and a friendship line for companions; followed by the locale block.
3. The companion personality prompt (`buildCompanionPrompt`), if a character is active.
4. The memory block, if any (see below).
5. The UI context block (`uiContext`), if the page sent one.
6. The interaction-style fragment (language / depth / candor).

Order is chosen so the longest-lived, most-shared prefixes come first, which lets Ollama reuse its KV cache across turns. `prompt_eval_duration=0` in the final chunk (logged as `prefill=0(cached)`) means a perfect KV cache hit.

## Memory

Long-term memory has two halves: **recall** on the request path and a **background writer** that never touches it.

### Recall (`backend/src/memory/recall.ts`)

`recallMemories()` does an entity-first deterministic pass followed by a vector pass:

- **Entity pass:** tokenize the prompt, match tokens against `entities.name` + aliases, and load *all* active memories linked to matched entities regardless of cosine score. This guarantees "would Artie like this?" surfaces Artie's facts even after months of silence.
- **Vector pass:** cosine over the remaining memories (embedded with `nomic-embed-text`). Durable memories score `1.0` for recency; episodic memories use `score = 0.7·cosine + 0.2·importanceNorm + 0.1·recency`. Pinned memories are always included.

`formatMemoriesForPrompt()` sections the result into "Core facts", "People & places", "Remembered context", and "Past conversations" (episode summaries), capped at `PROMPT_CHAR_BUDGET` (1200 chars). The block opens with an explicit instruction:

```
[Background context about the user. Use ONLY when directly relevant to what the user just asked.
Never mention, reference, or hint at these facts unprompted — especially not in greetings or small talk…]
```

<Aside type="caution">
That wording is deliberate. Softening it makes the model volunteer memories in greetings ("Are you in the mood to talk about Tom Petty?"). Do not paraphrase it loosely.
</Aside>

### Per-conversation block cache (`backend/src/memory/blockCache.ts`)

Recall (embed → vector search → format) gates time-to-first-token because the block must be in the system prompt before generation starts. It is cached per conversation for `MEMORY_BLOCK_TTL_MS` (30 min):

- **Turn 1:** embed + recall run in parallel with routing, then the result is cached.
- **Turn 2+:** cache hit, instant. The stable block keeps the system-prompt prefix byte-identical, which is what lets Ollama's KV cache hit.

The 30-minute TTL aligns with the background sweep's idle window so memories written by the sweep are picked up on the next cold recall.

### The writer (`backend/src/memory/sweep.ts`)

Memory is **never** extracted on the request path. `startMemorySweep()` runs two background intervals:

- **Judge sweep** (every 5 min): finds conversations whose last message is older than the 5-minute idle threshold and newer than `memoryProcessedThrough`, feeds the unprocessed span to `runJudge` (LLM fact extraction + entity upsert), advances the cursor, and generates an episode summary once a conversation passes `EPISODE_MESSAGE_THRESHOLD` (20 messages).
- **Maintenance sweep** (every hour, plus once 30s after boot): decay scoring and archival.

`triggerJudgeForConversation()` exists to extract immediately on an explicit close, fire-and-forget. Neither job blocks chat; failures are logged, never surfaced.

## Structured Output

**File:** `backend/src/llm/structured.ts`. `structuredCall<T>()` wraps any LLM call that must return parseable JSON: it prepends a strict English-only JSON system instruction, runs at `temperature 0.1`, extracts the first JSON object/array from the response, and retries once with a correction prompt on a parse failure. The judge and several tools use it; the main chat stream does not.

## The Streaming Client (`ollama.ts`)

`ollamaChatStream()` bypasses Bun's HTTP stack and speaks HTTP/1.1 over a raw `node:net` socket with `noDelay: true`. Both Bun's `fetch` and its `node:http` compat layer buffer most of a generation before emitting anything; a raw socket fires `data` per TCP segment, giving true per-token streaming. `noDelay` also disables Nagle and suppresses the macOS 200ms delayed-ACK that otherwise lets the remote batch tokens.

- Every request sends `think: false`. Thinking models (Gemma and others) otherwise spend hidden reasoning tokens that count against `num_predict` but never appear in `message.content`, which can produce a silent/empty response under a low cap.
- HTTPS endpoints fall back to `node:http` (`nodeHttpChatStream`) because raw-TCP TLS needs cert config.
- Two-phase timeouts: a generous first-byte deadline (`OLLAMA_FIRST_BYTE_MS`, 300s) covers a cold VRAM load, then a tight idle timeout (`OLLAMA_STREAM_IDLE_MS`, 60s) bounds a mid-stream stall.
- After each stream the log emits `[OLLAMA-TCP] tcp_segs=N ndjson_chunks=M`. `tcp_segs ≈ ndjson_chunks` is true per-token streaming; `tcp_segs << ndjson_chunks` means tokens are being batched.

### Token ceiling

`num_predict` is a **ceiling, not a target**: the model stops at natural completion or the cap, whichever comes first. It defaults to the user's `max_tokens` preference or `2048` (set in `chat.ts`). `num_ctx` comes from the `ctx_limit` preference (default `4096`), and `temperature` from `temperature` (default `0.7`).

### Warmup

`warmupModel()` (`backend/src/lib/models.ts`) pre-loads the chat model, both embedding models, and the router model into VRAM at boot with `keep_alive: -1`, then calls `initRouter()`. It primes the chat model with a short system+`"hi"` exchange so the first real turn does not pay full cold-load tax.

<Aside type="caution">
The warmup system message and the prefix `chat.ts` actually builds are not byte-identical today (chat leads with the content-policy preamble and a richer date line). Warmup still loads the model into VRAM and primes the date-shaped prefix, but do not assume a guaranteed turn-1 KV cache hit. If you want a true turn-1 cache hit, the warmup prefix and the first `systemParts` entries in `chat.ts` must match exactly.
</Aside>

## Client Render Contracts

Two contracts in the frontend keep streaming smooth. Both live in `frontend/src/context/ChatContext.tsx` and `frontend/src/components/chat/`.

### 1. RAF-batched token application

`token` events arrive faster than React should re-render. `ChatContext` accumulates incoming tokens in `tokenBufRef` and flushes them with a single `setMessages` per animation frame (`requestAnimationFrame`). This fixes the "everything appears at once" symptom on fast models and avoids one render per token. The buffer is force-flushed on `done`, `stop`, and `error` so no trailing text is lost.

### 2. Memoized messages + scroll-to-top on generation start

- `ChatMessage` is wrapped in `React.memo`. Only the streaming (last) message changes its `content` each frame, so memoization keeps every earlier message from re-rendering on every token.
- `MessageList` (`MessageList.tsx`) does **not** simply follow the bottom. On generation start it sizes a spacer below the latest turn and scrolls so the **user's prompt pins to the top** of the viewport while the answer types out underneath. The spacer shrinks as the response grows; once the turn is taller than the viewport the spacer is 0 and normal bottom-following resumes. Auto-follow is suppressed if the user has scrolled up to read earlier content (`atBottomRef`).

<Aside type="caution">
Do not replace the spacer logic with a naive "scroll to bottom on each token". The scroll-to-top-of-turn behavior is the intended UX, and re-introducing per-token bottom scroll fights the RAF batch and jitters the view.
</Aside>

## Companions & Conversations

A chat may be bound to a `characterId` (companion). When set, `chat.ts` loads the character, builds its personality prompt, records the user→character grant in `userCharacters`, and on first meeting writes a durable "first met" memory so the companion recalls it naturally later. The composer defaults `characterId` to the active companion (`getActiveCompanionId()`), so chatting from the main input talks to the selected companion with their persona and voice.

Conversations get an auto-generated 3-5 word title (`generateConversationTitle`) after the first turn finishes (model already warm, so latency is minimal). Conversations can be pinned and filed under a `projectId`.

## Admin Benchmarks

| Endpoint | What it measures |
|---|---|
| `GET /api/admin/chat-benchmark/stream` | Per-stage latency (bare LLM, +system, +memory, +history, routing, KV cache hits) via SSE. |
| `GET /api/admin/router-benchmark/stream?model=MODEL` | Router accuracy + speed across natural-language variations per tool. |

## What NOT to Change Without Re-Testing

1. **`think: false`** in `ollama.ts`: removing it re-enables hidden reasoning that can exhaust `num_predict` and produce empty responses.
2. **`SEARCH_INTENT_RE`**: no score gate; the regex itself is the gate.
3. **`CONVERSATIONAL_THRESHOLD = 0.40` / `SIMILARITY_THRESHOLD = 0.65`**: re-tune only against the router benchmark.
4. **Tool `examples`**: capability descriptions, not utterances.
5. **The memory-block instruction wording**: softening it causes unprompted memory volunteering.
6. **The memory block cache TTL**: lowering it below the sweep idle window breaks the KV-cache-stable prefix.
7. **Disconnect-is-not-stop** in `genQueue`: closing the socket must never abort the job; only `/cancel` does.
8. **The RAF token buffer and the spacer scroll** in the client: they are the two render contracts.

## Common Regression Patterns

| Symptom | Likely cause |
|---|---|
| Empty / no response | `think: false` removed, or `num_predict` exhausted before content. |
| Responses stream all at once | `noDelay` removed in `ollama.ts`, or the client RAF token buffer bypassed. |
| "what is X" answered from model knowledge | `SEARCH_INTENT_RE` not matching, or the search tool disabled for the user. |
| Model mentions memories in greetings | Memory-block instruction weakened. |
| All tools stop routing | `routeIndex.length === 0` (all-minilm never warmed up). |
| Tool routing very slow | Configured router model (`granite4.1:3b`) not installed/running; check `router_llm_model` / `ROUTER_MODEL`. |
| Generation keeps running after the user leaves | Expected: only `/cancel` stops it; a dropped socket does not. |
| Reconnect shows blank then jumps | Job was GC'd (>60s after done); client correctly fell back to the persisted message. |
