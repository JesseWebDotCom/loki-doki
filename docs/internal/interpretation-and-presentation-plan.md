# Intelligent interpretation, presentation & feedback plan (v2)

> **Implementation status (2026-07-17), branch `feat/companion-interpretation-presentation`:**
> **Phases 1–5 are BUILT** (backend `check:build` + frontend `tsc -b` clean):
> 1. presentation policy → `backend/src/lib/presentationPrompt.ts`, injected first, warmup synced;
> 2. wordless working state → `status` SSE event → `phase` → `working` → dock scan-sweep + LED pulse;
>    **plus** the spoken re-plan cue, which fires only out of Phase 4's dead end;
> 3. per-intent verbosity fragment;
> 4. bounded re-plan → `replanAfterDeadEnd()` in `router.ts`, one hop, **dead ends only**;
> 5. artifact auto-promotion (post-stream, code only).
>
> **Scoped out on purpose, not forgotten:** the *general* observe→re-plan loop around every turn
> (rejected — it would tax the happy path; the dead-end hook gets most of the value for zero
> normal-path latency), prose→artifact promotion (can't infer "the user wanted a document" from a
> reply), and the `present` capability (needs tool-calling *during* synthesis — a real
> architectural change, and Phase 1's prompt rules already cover most of its value).

*Drafted 2026-07-17, revised same day to make performance a first-class constraint and add the
user-feedback/cue layer. Sources: codebase audit of `runCompanionTurn`/`router.ts`,
`docs/internal/chat-latency.md`, plus verified research into published/leaked system prompts
(Claude, Perplexity), the OpenAI Model Spec, Anthropic tool-use docs, and Anthropic's
advanced-tool-use engineering blog. Leaked-prompt rules are cross-corroborated reconstructions,
not vendor gospel.*

## The headline finding

The "missing art" is **not a separate router service**. ChatGPT and Claude do essentially no
external classification: the model itself decides answer-vs-search-vs-tool via natural-language
decision rules in the system prompt plus native function calling, with numeric budgets ("1 tool
call for a single fact; 3–8 for medium tasks; 8–20 for deep questions") in the prompt and hard
caps enforced in code. Presentation is the same: Claude's artifact-vs-inline choice is a
quantitative prompt rule (>20 lines / >1500 chars standalone → artifact; never for lists/tables),
Perplexity's citations/tables/verbosity are per-intent conditional rules the model self-applies.

We already have the bones: one chokepoint (`backend/src/lib/companionTurn.ts:275`), a three-tier
router (`backend/src/llm/router.ts`), 57 tools, streamed artifacts, block cards, citation chips,
and a hard-won 200–900ms conversational first-token. What's missing: (a) the model is never
allowed to *reason* about a request with rules and budgets — it's pre-routed one-shot; (b) there
is no per-message presentation policy; (c) the user gets no legible feedback during the 5–8s a
tool turn takes today.

## Performance ground rules (from chat-latency.md — every phase obeys these)

1. **The fast path is sacred.** Conversational T0 and regex fast-paths stay untouched: p50
   first-token for chitchat/greetings/recall must remain 200–900ms. Everything new happens only
   on turns that were already slow (tool routes) or is prompt-only.
2. **KV-cache stability.** Any new *stable* prompt text (presentation policy) goes in the stable
   region AND `warmupModel()` is updated byte-for-byte. Any *per-message* text (verbosity
   fragment, loop state) goes in the late-volatile tail, after memory/notes/summary, and is kept
   to tens of tokens. Verify `prompt_eval_duration=0` still holds on turn 2+.
3. **No per-query `num_predict` budgeting.** Tried June 2026, abandoned: caps cut off list-style
   answers. Verbosity is steered by prompt fragments only; the ceiling stays a ceiling. The one
   existing exception (≤20-char messages → 60-token cap) stays.
4. **Small models do the cheap work.** The loop and any narration flavoring run on
   `getRouterModel()` (granite4.1:3b, ~1.8–2.8s/call) / `getFastModel()`, never the 12B chat
   model, and persona flavoring is pre-generated, never in the request path.
5. **Regression gates.** `[CHAT-TIMING]` gets per-hop and per-cue timestamps; the chat-benchmark
   and router-bench suites (plus the tier-1 router-index examples as a fixed regression set) run
   before/after each phase. A phase that regresses conversational first-token >10% doesn't ship.

### Latency budget targets

| Scenario | Today | After plan | Feedback the user sees |
|---|---|---|---|
| Chitchat / greeting (T0) | 200–900ms first-token | unchanged | none needed (<300ms shimmer suppressed) |
| T1 confident tool (weather, HA) | ~2–4s | unchanged | named cue ≤300ms after route ("Checking the weather…") |
| T2 / loop turn (1–2 hops) | 5–8s first-token | similar per hop, but **acknowledged ≤1s** | verbal/visual ack, then per-hop cues |
| Loop re-plan (new: hop 2+) | inexpressible today | +2–3s per extra hop, capped | "On second thought, let me check…" narration |

The insight from the big products: perceived latency is governed by time-to-first-*signal*, not
time-to-first-token. We can't make an 8B tool turn faster than ~5s, but we can make second 0–1
feel intentional. That's why the feedback layer ships *before* the agentic loop.

## Current state (audit summary)

- Every surface (chat SSE, overlay/voice, pods, Telegram) funnels through `runCompanionTurn`.
- Routing: regex fast-paths → all-minilm similarity (T0 <0.40 / T1 ≥0.65 / T2 between) →
  granite4.1:3b function-calling over top candidates; multi-intent pre-decided, capped at 3.
- **Single-pass**: route → execute tool(s) → fold results → one synthesis stream. No
  observe→re-plan. Follow-ups handled by a bespoke override stack (`companionTurn.ts:368-413`).
- Presentation is tool-typed: cards only where a tool emits a `blockBuilder` block; artifacts only
  via the explicit `canvas` tool. Verbosity: one static per-character fragment + answer-first rule.
- **Feedback today**: chat shows a transient `ROUTING_LABELS` string while a tool runs
  (`ChatContext.tsx:941`, `ChatMessage.tsx:69`); the companion overlay/pod just enters a generic
  "thinking" state with no further cues — a question that triggers search looks identical to one
  that doesn't, for 5–8 silent seconds.

---

## Phase 1 — Presentation policy prompt section (prompt-only, most visible win)

A **presentation policy** block in `buildSystemParts()`'s stable region, ~200 tokens, adapted from
the verified rules; `warmupModel()` updated to match (ground rule 2).

- **Formatting defaults (Claude, officially published):** minimum markdown — no headers/bold/
  bullets unless content is genuinely multifaceted or the user asks; casual questions get short
  natural prose; long-form output is paragraph prose with enumerations in natural language.
- **Structure rules (Perplexity, leaked, stable 2024–2026):** never open with a header; "X vs Y"
  comparisons → GFM table (renderer already supports); flat lists only, never one-bullet lists;
  headers <6 words.
- **Citation rules:** per-sentence `[N]` immediately after the sentence (chips exist), no trailing
  References section (`SourcesCard` covers it), no citations for translation/creative/roleplay.
- **Artifact rule (Claude, corroborated):** code >20 lines or standalone doc >1500 chars → call
  `canvas`; never for lists/tables/short code/conversational replies. Backend fallback in the
  stream consumer (`companionTurn.ts` ~`:923`): a fenced code block that crosses 20 lines in a
  plain reply gets promoted to `artifact_token` streaming mid-flight, so small-model misses don't
  break the contract — and the promotion itself emits a feedback cue (Phase 2): *"this is getting
  long — moving it to canvas."*

**Perf cost:** ~200 stable prompt tokens ≈ +130ms prefill on turn 1 only (1.5 tok/ms); zero on
turn 2+ (KV hit). Measured via chat-benchmark before/after.

## Phase 2 — Feedback & cue layer (ships before the loop; the loop depends on it)

### The core principle: separate the response from the processing signal

The annoyance risk is NOT in the reply text — `companionTurn.ts:832` already forbids the model
from opening with "let me check" / "I'll look that up" filler (the answer-first discipline). The
gap is the *processing indicator during the wait*. Today the companion has exactly one busy state:
`thinking = streaming && replyText.length === 0` (`CompanionEngineContext.tsx:280`). A 5–8s tool
turn keeps `replyText` empty the whole time, so a question that fired a web search looks identical
to one that's just slow — one undifferentiated "thinking" orb, then eventually speech. That reads
as *being ignored*, exactly as reported.

The fix is emphatically NOT to make the companion talk more. Robotic task announcements ("Checking
the weather", "Let me check that for you") are banned outright — they're what makes an assistant
feel like a phone tree. The design has three tiers, and the verbal one is the last resort:

1. **Ambient/visual is primary and always-on.** The orb gets a distinct *working* state, visually
   separate from idle *thinking* — a subtle, calmer "I'm on it" motion. This alone kills the
   "silent, ignoring me" feeling with zero words. It can never be annoying because it's ambient and
   wordless. This is the whole fix for the common case.
2. **No spoken task announcements. Ever.** The companion never narrates what tool it's using or
   that it's looking something up. If it has nothing to say yet, it stays quiet — but *visibly
   working*, not visibly idle.
3. **Rare spoken "thinking aloud" — only for genuine plan changes, never for progress.** A human
   friend doesn't announce "I'm checking the weather," but they might, if they change their mind
   mid-thought, mutter "hmm, actually, let me look at that." That's *revealing thought*, not
   *announcing service* — and it only happens on a real inflection: a tool came back empty and we're
   trying another angle, or (Phase 4) the model decides to go a step deeper. It is varied,
   persona-voiced, fires at most once per turn, and never for the normal single-hop case. Overused,
   it reads as indecision; reserved for true re-plans, it reads as a mind at work.

### Event vocabulary

Extend the existing SSE stream contract (events already forward verbatim through `ctx.emit` on
chat and `jobCtx.emit` on the companion route) with one additive `status` event carrying
`{phase, toolId?}` where phase ∈ `working | searching | deeper | retrying | composing`. It does not
replace the existing `routing` event (which drives the chat-side per-tool labels) — it's the
companion-facing signal. Display/animation is decided client-side; the backend only states what's
happening.

### When to show feedback (the threshold ladder)

| Elapsed / event | Chat surface (visual, non-spoken) | Companion (voice/overlay) |
|---|---|---|
| <350ms | nothing (no flicker) | nothing |
| routing, no tool | existing shimmer | idle *thinking* orb (exists) |
| a tool is running | existing per-tool label line (kept) | **wordless *working* orb** — the key change |
| tool came back empty → retry | "That came up empty — trying another angle." (visual) | orb stays working; **one** soft persona line ("hmm, let me look again") |
| Phase 4 hop deeper | line updates | orb stays working; at most one "actually, let me dig a little more" |
| first answer token | cues clear | speech begins |

Rules of the art: never show raw tool ids; never stack more than one cue; cues are *replaced*, not
appended; silence below the threshold is correct; on voice, the default is *wordless*, and any
speech narrates a **transition of thought**, never elapsed time or the task name.

### The wordless working state (the biggest companion win, zero added words)

The moment routing picks a tool, the backend emits `status:{phase:'working'|'searching'}`.
`useCompanionStream` captures it (today it's DEV-logged and discarded at `useCompanionStream.ts:115`)
and exposes a `phase`. `CompanionEngineContext` derives a third indicator state — `working` —
distinct from `thinking`, so the orb shows a calm, intentional "on it" motion instead of the idle
spinner. No speech, no label read aloud, no latency cost (it rides an event that already fires).
This is what makes the wait feel *attended to* rather than *ignored*, and it's the default for
every tool turn.

### Rare spoken cue (opt-in, transition-only, pooled)

For the genuine re-plan case only (empty-result retry now; Phase 4 hops later), a short
persona-voiced line may be spoken **once**. Sourced from a **pre-generated pool** — at character
save time `getFastModel()` renders a handful of natural, non-announcing phrasings per character
("hmm, one sec", "let me look again", "actually…"), stored on the character — so there is zero LLM
call in the request path and no repetition (rotating, seeded per conversation). These are
deliberately *content-free continuers*, not task descriptions. Gated behind a per-character/setting
toggle and defaulted conservative: the wordless working state carries the normal case; the spoken
cue exists only so a real change of plan doesn't happen in total silence. Speculative KV-prime
(`fireKvPrime`) already overlaps tool execution and is unchanged.

## Phase 3 — Per-intent verbosity (prompt fragments only)

Perplexity's per-intent verbosity classes, driven by the router output we already have *before*
generation. A one-line fragment injected in the **late-volatile tail** (~20 tokens, after
memory/notes — costs a few ms of prefill, no cache damage):

| Intent (router result) | Fragment steers toward | Citations |
|---|---|---|
| weather, time, calc, unit, HA | one sentence; the card carries the data | no |
| factual (search/knowledge) | short, answer-first prose | per-sentence |
| how-to / repair / recipe | structured steps | if searched |
| "explain / compare / help me decide" | long-form, tables for comparisons | per-sentence |
| creative / roleplay / chitchat | persona-led, no format imposed | never |

No `num_predict` mapping (ground rule 3) — the 2048 ceiling and the ≤20-char/60-token greeting cap
stay exactly as documented. Voice/pod surfaces always inject the short class (spoken-reply rule
already exists). Character `replyStyle` biases the class; `auto` = pure per-intent.

## Phase 4 — Model-side interpretation loop (feature-flagged, chat first)

Keep T0/T1 fast-paths for the ~80% of traffic that's latency-critical and unambiguous. Upgrade the
T2 band from one-shot pick to a bounded agentic loop on `getRouterModel()`:

1. **Deferred tool loading:** tier-1 embeddings select top-k (≈8) candidate tool schemas — the
   Anthropic Tool Search pattern (85% token cut, accuracy gains in their evals); we already pass
   top candidates to T2, so this is an extension. `search` + core plumbing always included.
2. **Decision rules in prompt** (Claude's verified triggers): search when info is current/
   changing/outside training data; answer directly for stable knowledge, math, creative work, and
   anything already in memory/notes.
3. **Budgets in prompt, caps in code:** "1 call for a single fact; up to 3 for a bigger task" in
   the prompt; hard `maxToolCalls` in the loop (chat: 3, voice/pod: 1 — a hop costs 2–3s and voice
   can't hide it) plus a wall-clock timebox (~12s) that forces synthesis from whatever's gathered.
4. **Observe → re-plan:** after each tool result the model may call one more tool or synthesize —
   each extra hop emits the `replanning` cue from Phase 2, so the wait is always narrated.
5. **Unified follow-up state:** pending-confirmation / focused-canvas / last-tool context becomes
   a structured block in the loop context; the bespoke regex overrides shrink to fast-paths.
6. **Rules as data:** `TIER2_RULES` / conversational examples move from literals in `router.ts` to
   a data file so new intents don't mean router edits.

**Perf guardrails:** T0/T1 routing untouched; loop only replaces the already-slow T2 path; per-hop
`[CHAT-TIMING]` entries; the 30-test router-bench plus the router-index examples must hold ≥
current accuracy; feature flag per surface, voice keeps single-pass until chat proves the loop.

## Phase 5 — Content-typed presentation

- Prompt rules from Phase 1 cover most of it (tables, artifact threshold).
- A lightweight `present` capability the model can invoke in its final answer for structured cases
  prose can't render: image grids from search results, link-preview cards, map pins — mapping onto
  existing block types (`ImageBlock`, `SearchBlock`, maps). New trigger, no new renderers.
- Footnote UX stays: inline chips + `SourcesCard`, never a References section in the prose.

## Sequencing

1. **Phase 1** — prompt + warmup sync + artifact-promotion fallback. Prompt-only risk.
2. **Phase 2** — status events + threshold ladder + voice acknowledgment pools. This is the phase
   that fixes "the companion just goes into thinking mode"; it also makes Phase 4's extra hops
   affordable UX-wise, which is why it comes before the loop.
3. **Phase 3** — verbosity fragments riding on existing router output. Small, independent.
4. **Phase 4** — the loop, behind a flag, chat first, voice last.
5. **Phase 5** — mostly prompt work once 1–4 exist.

## Verified-research gaps (honesty section)

Nothing survived verification about ChatGPT's Canvas-vs-inline thresholds, GPT-5's real-time model
router internals, Gemini/Copilot routing, or the open-source stacks' dispatch internals. The plan
leans on Claude/Perplexity/OpenAI-spec evidence, which is also the best documented. Two refuted/
corrected claims worth remembering: Claude's published prompts contain **no** "concise by default"
rule (the real policy is minimum-formatting + prose-over-lists), and per-query token budgeting is
an anti-pattern both in our own June 2026 testing and across production chat apps.
