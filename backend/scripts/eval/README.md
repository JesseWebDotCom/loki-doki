# Eval suite

Automated regression tests for the four quality pillars of the companion stack.
All run against the REAL modules/pipeline (no mocks) and need the dev stack up
(backend on :3000, Ollama, voice server for the wakeword eval).

| script | what it measures | run |
|---|---|---|
| `router-eval.ts` | Tool-routing accuracy over the 41-case fixture set (`adminRouterBenchmark.TEST_CASES`) with per-path latency. | `bun run eval:router` (`--t1-only` to skip the LLM tier) |
| `memory-eval.ts` | Recall quality: seeds a throwaway user with pinned/durable/episodic/entity memories (plus a 22-fact entity flood and 40 filler rows) and asserts each probe question surfaces — or correctly does NOT surface — the target fact in the real formatted prompt block. | `bun run eval:memory` |
| `chat-e2e.ts` | True end-to-end latency through `POST /api/chat/stream` exactly as the frontend calls it: headers→first-token→total, plus the server's own `[CHAT-TIMING]` stage breakdown pulled from the log ring buffer. Mints a temporary admin session and deletes it after. | `bun run eval:chat "message" [--runs N] [--character Name]` |
| `companion-eval.ts` | Answer quality on single-shot factual/tool prompts, graded on directness, conciseness, accuracy (route + content/grounding), and speed. | `bun run eval:companion [--character] [--only id] [--json out.json]` |
| `continuity-eval.ts` | Multi-turn continuity: pronoun follow-ups ("how old is he?"), "what did you just tell me", "tell me more", clarify turns, and a past-conversation probe — graded on topical overlap with the prior reply, sane routing, mechanical assistant-speak tells, and a raw-log grep baseline. | `bun run eval:continuity [--only id] [--json out.json]` |
| `stress-eval.ts` | Adversarial discovery battery (23 scenarios): deep pronoun chains, self-corrections, remember/forget lifecycle across conversations, misspellings/slang, fake people and fabricated events (hallucination bait), prompt injection, degenerate inputs, persona self-consistency. Mechanical flags decide PASS/FLAG; the full transcripts are printed for human triage — read them even on a clean run. | `bun run scripts/eval/stress-eval.ts [--only id] [--json out.json]` |
| `wakeword-fa-eval.ts` | False-accepts/hour + recall through the REAL ort-web detection pipeline (`lib/pod/wake.ts`, shared by browser and Wyoming paths). Builds a cached audio bank (Kokoro speech = TV-dialog proxy, phonetic near-misses, colored noise, silence, positive utterances), records the smoothed score stream once per model, then replays the exact fire logic across a threshold × hysteresis sweep. | `bun run eval:wakeword [modelId ...]` |
| `router-scores.ts` | Debug helper: dumps top-5 embedding scores for a prompt list — use when tuning thresholds or adding tool examples. | `bun run scripts/eval/router-scores.ts` |

## Baselines (2026-07-01, M4 Pro 24 GB, llama3.1-8b + granite4.1:3b)

Recorded after the fixes in this pass, as the numbers to not regress from:

- **Router**: 41/41 (was 32/41 before the search-intent gate/math/unit/define/absorber fixes).
- **Memory**: 11/11 (was 7/9 before the durable-tier cosine gate + caps).
- **Chat E2E**: conversational TTFB 0.4–2.2 s (absorber hit + warm KV ≈ 0.4–0.9 s;
  cold prefix ≈ 2 s). Was 5.3–6.0 s. News tool turn TTFB ≈ 6.5 s (was 21 s).
  Watch the `llm-done` line: `load=` should be ~100 ms (a ~930 ms value means the
  model got evicted/reloaded — check `OLLAMA_MAX_LOADED_MODELS` and that no call
  site passes a non-default `num_ctx`), and repeat turns in a conversation should
  show `prefill:` near 0 (KV hit).
- **Wakeword** (`trained_hey_loki_mqwl8glv`, calibrated th 0.47, adversarial bank):
  browser (hyst 2) 44 FA/hr @ 83% recall; pod (hyst 4) 22 FA/hr @ 67% recall.
  Nearly all fires come from the near-miss bank (phonetic rhymes) — models
  trained before the near-miss fallback fix have no rhyme negatives. Noise and
  silence banks: 0 fires.

## Baselines (2026-08-12, prod box, Qwen 3.5 9B latest set, after the companion audit fixes)

- **Router**: 53/53 warm (first run 52/53: one tier2-error from a cold router-model load).
- **Memory**: 11/11.
- **Continuity**: 5/5 (pronoun follow-up, "what did you just tell me", "tell me
  more", "what did you mean by that", past-chat recall + grep baseline).
- **Companion**: 8-10/10 across runs — the variance is sampling wordiness (a case
  landing a few words over its budget), not accuracy or routing. Directness held
  10/10; conciseness 10/10 after the no-ambient-padding prompt line.
- **Stress**: 23/23 clean after the first two discovery rounds fixed: explicit
  "remember that X" commands falling to conversation (fact content dominates the
  embedding — now a deterministic fast path), invented personal facts when the
  memory block lacked the answer, persona questions being web-searched, same-chat
  references firing the past-conversations tool, self-corrections losing their
  tool, and false-premise questions laundered through tangential news results.
- Note on memory hygiene: eval cleanup deletes conversations DIRECTLY in the DB.
  The API delete fires a judge snapshot over the doomed messages, which RACES the
  memory scrub and writes probe "facts" into the real store after cleanup
  (observed live: a judge-invented "sister Sarah" row). If probe facts ever show
  up in real chats, check recent memories in Admin → Memory.

## The grep-baseline rule (memory features)

Before any memory feature ships or grows, it must beat the dumbest possible
baseline: LIKE/grep over the raw transcripts it draws from. `continuity-eval.ts`
enforces this on the past-conversation probe (`grep-baseline=LOST-TO-GREP` means
the recall machinery failed to surface something a plain substring search could
see). The 2026 memory-benchmark literature is polluted (LoCoMo's answer key is
~6% wrong; vendor leaderboards contradict each other), so our own probes + the
grep baseline are the ground truth here. Evaluate variants PAIRWISE (old prompt
vs new prompt on the same probes), never by absolute scores.

## Gotchas

- `data/router-index.json` is keyed by a hash of tool examples + the
  conversational exemplars; `loadCache` also validates entry count. If routing
  behaves stale in dev, delete the file and let it rebuild.
- The wakeword bank caches under `data/voice/wake-eval-bank/` (plus
  `scores_<model>.json` per run for offline threshold analysis). Delete to
  regenerate; keep it committed to nothing (it's synthesized, reproducible).
- `chat-e2e.ts` writes real conversations to the admin account — they show up in
  the UI. Harmless, but delete them if they clutter.
