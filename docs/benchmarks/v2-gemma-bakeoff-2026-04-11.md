# V2 Gemma Fallback Model Bake-Off — 2026-04-11

## Goal

The v2 prototype's Gemma fallback path runs whenever the deterministic
combiner can't produce an answer (no skill matched, skill returned
empty, low routing confidence, supporting context to weave in). The
default model was `gemma3:270m` (which wasn't installed) → degraded to
the deterministic stub on every call → users saw their input mirrored
back as the response.

After fixing the model wiring to `gemma4:e4b`, that single model was
~5s for direct_chat answers on Mac. We needed to find the right model
for both prompt families (`direct_chat` and `combine`) under a tight
latency budget.

This bake-off scored 10 candidates on a 9-prompt corpus, measuring
warm-cache latency (with model load + KV-cache prefill explicitly
excluded) and rule-based response quality.

## Methodology

**Harness:** [scripts/bench_v2_gemma_models.py](../../scripts/bench_v2_gemma_models.py)

**Fairness rules:**

1. Each model is loaded into Ollama VRAM via a throwaway `"hi"` prompt
   before any measurement.
2. Each (model, prompt) pair runs **one additional** discarded warmup
   to prefill the KV cache for that exact prompt template.
3. Latency is reported as the median across **3 warm replicates** so
   a single jittery sample doesn't poison the average.
4. We report `min`, `median`, and `mean` per prompt and `avg(median)`
   across prompts so the reader can judge tail behavior.

**Prompt corpus** (9 prompts):

| Family | ID | User Request |
|---|---|---|
| direct_chat | `dc.json_acronym` | "what does json stand for" |
| direct_chat | `dc.ring_privacy` | "do my ring cameras spy on me" |
| direct_chat | `dc.wifi_slow` | "why is my wifi so slow" |
| direct_chat | `dc.casual_chat` | "tell me a fun fact about octopuses" |
| direct_chat | `dc.opinion` | "what's the difference between machine learning and ai" |
| combine | `cb.time_running_late` | time skill + "running late" context |
| combine | `cb.weather_picnic` | weather skill + "picnic this afternoon" context |
| combine | `cb.directions_traffic` | directions skill + "worried about traffic" context |
| empty_output | `eo.knicks_score` | sports skill returned empty → fall through |

**Quality grading** (rule-based, 0-100):

- −25 for scaffolding leakage ("Sure, here's the natural-language response:", "Steps:", "I must answer in...")
- −20 for internal-terminology leakage ("the request", "the spec", "RequestSpec", "output_text", "primary request")
- −15 for refusing harmless questions ("I'm not able to provide information about ring cameras")
- −30 for empty / non-answer ("I'm having trouble understanding...")
- −10 for verbosity (>80 words on a 1-3 sentence constraint)

Hardware: Mac (M-series), Ollama 0.x, all models Q4_K_M unless noted.

## Results

| # | Model | Quality | DC ms | CB ms | All ms | p95 ms | Issues | Verdict |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | **`phi4-mini`** | **100** | 754 | 551 | 687 | 1029 | **0/9** | ★ ship-ready |
| 2 | **`gemma3:4b`** | **100** | 740 | 842 | 774 | 940 | **0/9** | ★ ship-ready |
| 3 | `gemma4:e2b` | 98 | 551 | 452 | 518 | 612 | 1/9 | ✓ strong contender |
| 4 | `llama3.1:8b` | 100 | 1079 | 1127 | 1095 | 1503 | 0/9 | ✓ strong contender |
| 5 | `llama3.2:3b` | 94 | 624 | 498 | 582 | 822 | 2/9 | ↓ has caveats |
| 6 | `gemma4:e4b` (prev default) | 96 | 859 | 595 | 771 | 1074 | 1/9 | ✓ strong contender |
| 7 | `qwen3:8b` | 97 | 1240 | 1135 | 1205 | 1421 | 2/9 | ↓ refuses harmless qs |
| 8 | `gemma:2b` | 88 | 403 | 390 | 399 | 459 | 4/9 | ↓ scaffold leakage |
| 9 | `qwen3.5:4b` | 100 | 1643 | 1633 | 1640 | 2061 | 0/9 | ↓ slow at 4B |
| 10 | `qwen3:4b` | 60 | 3664 | 3740 | 3689 | 3910 | **9/9** | ✗ thinking-mode leak |

**Composite ranking** (quality - latency_penalty, higher is better):

```
93.2  gemma4:e2b
93.1  phi4-mini       ← winner on quality + footprint
92.3  gemma3:4b
89.0  llama3.1:8b
88.6  llama3.2:3b
88.4  gemma4:e4b
84.6  qwen3:8b
83.8  gemma:2b
83.6  qwen3.5:4b
23.1  qwen3:4b
```

## Per-model issue breakdown

**`qwen3:4b` — 9/9 prompts had issues** (disqualified)

Leaks its entire reasoning monologue into `output_text` even with
`think=False`. Example for "what does json stand for":

```
We are given a question: "what does json stand for"
As LokiDoki, I am a friendly conversational assistant. The user's
question is about what JSON stands for.
I know that JSON stands for "JavaScript Object Notation".
I must answer in the first person, concisely (1-3 sentences), and
directly without any internal terminology.
Steps:
 1. Answer directly: JSON stands for "JavaScript Object Notation".
 2. Since the user asked for what it stands for, I can say it in one sentence.
...
```

Qwen3 family ignores `think=False` for direct-chat prompts. v1's
[lokidoki/core/inference.py:54](../../lokidoki/core/inference.py#L54)
already documents the same problem with the gemma4 family but
gemma4 honors the flag — qwen3 does not.

**`gemma:2b` — 4/9 prompts had issues**

- Refuses "what's the difference between machine learning and ai"
- Leaks "Sure, here's the natural-language response:" on every combine
  path
- Misinterprets the directions+traffic combine as a request to
  summarize "the spec"

**`qwen3:8b` — 2/9 prompts had issues**

Refuses two harmless questions:
- "do my ring cameras spy on me" → "I don't have access to your devices"
- "why is my wifi so slow" → "I can't access your device's settings"

A lifestyle assistant can't refuse common questions like these.

**`llama3.2:3b` — 2/9 prompts had issues**

- Combine path leaks meta-language
- Empty_output knicks prompt becomes a non-answer ("I'm having trouble
  understanding what you're looking for")

**`gemma4:e4b` — 1/9** (refusal on empty_output knicks prompt)

**`gemma4:e2b` — 1/9** (refusal on combine directions+traffic)

**`phi4-mini`, `gemma3:4b`, `llama3.1:8b`, `qwen3.5:4b` — 0/9 issues**

## Decision

**Default: `phi4-mini`** ([v2/orchestrator/core/config.py](../../v2/orchestrator/core/config.py))

- Tied for best quality (100/100, zero issues)
- Sub-800ms direct_chat / sub-600ms combine on Mac
- 2.5GB on disk vs 9.6GB for `gemma4:e4b` — critical for Pi 5 8GB RAM
  headroom
- p95 latency just over 1s — fits comfortably under the 2s direct_chat
  budget and the 1s combine budget on Mac

Override with env vars without touching code:

```sh
LOKI_GEMMA_MODEL=gemma4:e4b   # higher-quality, slower
LOKI_GEMMA_MODEL=llama3.2:3b  # smaller, faster, RAM-budget
```

## Reproducing

```sh
# Run the bake-off (any subset of models you have pulled)
PYTHONPATH=. LOKI_GEMMA_ENABLED=1 python scripts/bench_v2_gemma_models.py \
    --models phi4-mini gemma3:4b gemma4:e4b llama3.1:8b \
    --replicates 3 \
    --output /tmp/v2_gemma_bench.json

# Score and rank the results
python scripts/score_v2_gemma_bench.py
```

The harness writes raw per-prompt latencies + responses to its `--output`
JSON so quality can be re-graded later as the rules evolve. Both raw
JSONs from this run are checked in alongside this report:

- [v2_gemma_bench_2026-04-11_local.json](v2_gemma_bench_2026-04-11_local.json)
- [v2_gemma_bench_2026-04-11_new.json](v2_gemma_bench_2026-04-11_new.json)

## Open follow-ups

1. **Re-run on Pi 5.** Mac results show phi4-mini wins comfortably; we
   need the same numbers on actual Pi 5 8GB hardware before we can
   confirm the choice for the production target. Expected Pi 5 latency
   from research: phi4-mini ~2-3s, gemma4:e4b ~5-7s, llama3.2:3b
   ~2.5-3.5s.

2. **Investigate qwen3 thinking-mode disable.** The `think=False` flag
   we pass works on gemma4 but not qwen3. Qwen3 may need a different
   API field (`thinking: false` in the chat options, or a system
   prompt prefix). If we can fix it, qwen3:4b becomes a viable
   contender on raw speed.

3. **Per-prompt-family model selection.** `gemma4:e2b` is fastest at
   acceptable quality (518ms avg, 1 issue) — worth A/B testing as a
   combine-only model while phi4-mini handles direct_chat. Two-model
   memory cost is ~5GB; tight on Pi 5.

4. **Larger prompt corpus.** 9 prompts is enough to surface the major
   quality failures (refusals, scaffolding leakage), but a longer
   corpus would catch subtler regressions. Consider adding 20-30
   prompts from the regression-prompt fixtures
   ([tests/fixtures/v2_regression_prompts.json](../../tests/fixtures/v2_regression_prompts.json))
   for the next bake-off pass.
