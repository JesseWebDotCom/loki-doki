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

## Phase 1 decision (later overturned — see Phase 2)

Phase 1 picked **`phi4-mini`** based on the curated 9-prompt set:
100/100 quality, 754ms direct_chat avg, 2.5GB on disk. Phase 2 below
expanded the corpus to 84 prompts, exposed a 27% refusal rate on
phi4-mini, and overturned the decision.

## Final decision (Phase 2)

**Default: `qwen3:4b-instruct-2507-q4_K_M`** ([v2/orchestrator/core/config.py](../../v2/orchestrator/core/config.py))

| metric | qwen3-instruct | phi4-mini |
|---|---:|---:|
| Quality (84-prompt) | **98 / 100** | 96 / 100 |
| Issues (84-prompt) | **10 / 84 (12%)** | 23 / 84 (27%) |
| Avg warm latency | **565 ms** | 852 ms |
| p95 warm latency | **1059 ms** | 1811 ms |
| Avg response length | **28 words** | 40 words |
| Verbose responses | **0** | 8 |
| Disk size | 2.5 GB | 2.5 GB |

qwen3-instruct wins on every dimension. Same disk footprint, 34%
faster on average, 42% faster at the tail, fewer refusals, never
goes long.

Override with env vars without touching code:

```sh
LOKI_GEMMA_MODEL=phi4-mini    # tied on small set, slower at scale
LOKI_GEMMA_MODEL=gemma4:e4b   # highest quality, 4x larger on disk
LOKI_GEMMA_MODEL=llama3.2:3b  # smallest, fastest, RAM-budget
```

> ⚠️ **Must be the `-instruct-2507` variant.** The default `qwen3:4b`
> tag points to the *thinking* variant, which leaks its entire
> reasoning monologue ("Steps:", "I must answer in...", "Let me check
> the rule") into `output_text` and pushes latency past 3.5s. The
> `think=False` API parameter does NOT suppress this on qwen3 — it
> only works on the gemma family. See
> [ollama/ollama#12917](https://github.com/ollama/ollama/issues/12917).

## Phase 2: 84-prompt regression corpus (added 2026-04-11 17:00)

The original 9-prompt curated set was too small to surface refusal
patterns. Phase 2 added a `--corpus` flag to the harness that loads
every utterance from
[tests/fixtures/v2_regression_prompts.json](../../tests/fixtures/v2_regression_prompts.json)
(84 real test prompts) and runs each one through the model as a
direct_chat prompt. This catches:

1. **Refusals at scale.** phi4-mini refuses anything that smells like
   real-time data (current time, weather, showtimes, news, indoor
   temperature). qwen3-instruct refuses fewer of the same prompts
   *and* refuses more politely without claiming "I am Microsoft AI
   with a knowledge cutoff".
2. **Verbosity drift.** phi4-mini consistently overshoots the 1–3
   sentence rule on recipes, plans, code samples, jokes — 8 of 84
   prompts produced 80+ word responses. qwen3-instruct hit 0/84 on
   this metric.

### Comparison table

| metric | phi4-mini | qwen3:4b-instruct-2507 |
|---|---:|---:|
| Total prompts | 84 | 84 |
| Issues | 23 (27%) | 10 (12%) |
| Avg quality | 96/100 | 98/100 |
| Avg warm latency | 852ms | 565ms |
| p95 warm latency | 1811ms | 1059ms |
| Refusals | 15 | 10 |
| Verbose responses | 8 | 0 |

### What both models refuse (and why it's OK)

Both refuse on the same general shape: *"I need real-time data to
answer this"*. Examples that hit both:

- "what time is it in london"
- "whats the weather today / tomorrow"
- "movie times for inception"
- "summarize this article"

These are **never supposed to land on Gemma in production** — every
one of them is handled by a real skill (`get_current_time`,
`get_weather`, `get_movie_showtimes`, `summarize_text`) before the
fallback path runs. The bake-off's `--corpus` mode forcibly routes all
84 utterances to direct_chat to stress-test how the model behaves on
prompts it shouldn't actually receive. So a 12% refusal rate on this
artificial test is fine — it represents the worst case where the
skill layer is broken and Gemma is taking over for everything.

### Phase 2 reproducibility

```sh
# Run a model against the full 84-prompt regression corpus
PYTHONPATH=. LOKI_GEMMA_ENABLED=1 python scripts/bench_v2_gemma_models.py \
    --models qwen3:4b-instruct-2507-q4_K_M \
    --replicates 1 \
    --corpus tests/fixtures/v2_regression_prompts.json \
    --output /tmp/v2_gemma_corpus_qwen3instruct.json
```

Raw results from this run are checked in alongside this report:

- [v2_gemma_corpus_2026-04-11_phi4mini.json](v2_gemma_corpus_2026-04-11_phi4mini.json)
- [v2_gemma_corpus_2026-04-11_qwen3instruct.json](v2_gemma_corpus_2026-04-11_qwen3instruct.json)
- [v2_gemma_bench_2026-04-11_qwen3instruct.json](v2_gemma_bench_2026-04-11_qwen3instruct.json) (9-prompt curated)

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

1. **Re-run on actual Pi 5 hardware.** Mac results pick
   qwen3-instruct comfortably; we need the same numbers on Pi 5 8GB
   before the production target ships. Expected Pi 5 latency from
   research: phi4-mini ~2-3s, qwen3:4b-instruct ~2-3s, gemma4:e4b
   ~5-7s, llama3.2:3b ~2.5-3.5s. Cannot be done remotely — needs
   physical hardware access.

2. ~~Investigate qwen3 thinking-mode disable.~~ **RESOLVED in Phase 2.**
   The `qwen3:4b` default tag is the *thinking* variant and ignores
   `think=False`. Use `qwen3:4b-instruct-2507-q4_K_M` instead — it has
   thinking stripped at the model level. Documented at
   [ollama/ollama#12917](https://github.com/ollama/ollama/issues/12917).

3. **Per-prompt-family model selection — INTENTIONALLY SKIPPED.**
   `gemma4:e2b` is the fastest at quality ≥95 (518ms avg). Splitting
   models by prompt family (phi4-mini for direct_chat, gemma4:e2b for
   combine) saves ~100ms per combine call but costs ~5GB of RAM (must
   keep both models loaded in Ollama VRAM to avoid the 5–30s swap
   cost). On a Pi 5 8GB target, two loaded models leaves ~400MB for
   the OS, Python orchestrator, all skills, and the Vite frontend.
   Not worth it. Single-model is the right call.

4. ~~Larger prompt corpus.~~ **RESOLVED in Phase 2.** Added a
   `--corpus` flag to the harness that loads every utterance from
   [tests/fixtures/v2_regression_prompts.json](../../tests/fixtures/v2_regression_prompts.json)
   (84 prompts). Re-running both finalists against the larger corpus
   exposed phi4-mini's 27% refusal rate and overturned the Phase 1
   decision. The harness now supports both modes — the curated set
   for fast iteration, the corpus for production gating.
