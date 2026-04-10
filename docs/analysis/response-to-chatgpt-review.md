# Response to ChatGPT Review of Pipeline Latency Analysis

## Where ChatGPT is right, and I need to correct

### 1. Context window: I was wrong about 4,096 being the model's limit

ChatGPT correctly identified that `ollama show gemma4:e4b` reports a context length of **131,072**, not 4,096. I stated the prompt "overflows the context by 31%" as proven — that was wrong.

What's actually happening: Ollama **loads** the model with a default runtime KV cache allocation of 4,096 tokens (confirmed via `ollama ps` showing `context_length=4096`). When `num_ctx=8192` is passed, Ollama expands the allocation at runtime. The model CAN handle 131K context — it's a runtime allocation choice, not a hard cap. I conflated the default runtime allocation with the model's architectural limit.

**Correction:** The prompt is not being truncated by a hard context ceiling. The cost is from processing a ~5,300-token prompt through attention layers, not from overflow. The prompt bloat is still a real performance problem (more tokens = more attention cost per forward pass), but the "model can't see the prompt" claim was overstated.

### 2. The "2.8x schema penalty" needs qualification

My original claim of "2.8x slower" was from a single benchmark run. Re-benchmarking with proper warmup and multiple runs shows:

| Config | Median (warmed up) | Notes |
|--------|-------------------|-------|
| Full prompt (618 ppl) + schema | **3.7s** | High variance: first run after grammar change hits 12.4s |
| Full prompt (618 ppl) + json | **1.2s** | Very stable across runs |
| Small prompt (10 ppl) + schema | **3.0s** | |
| Small prompt (10 ppl) + json | **2.3s** | |

The schema penalty depends on prompt size:
- At full prompt size: **3.1x** (3.7s vs 1.2s)
- At small prompt size: **1.3x** (3.0s vs 2.3s)

So the schema penalty is real and significant at large prompt sizes, but **it's not a fixed 2.8x**. It interacts with prompt length. ChatGPT was right to flag this as "too broad."

More importantly: the schema's first-run penalty after any change (grammar recompilation) is **massive** — 12.4s and 6.3s for the first run vs 3.5–3.7s steady-state. This may explain some of the production variance.

### 3. The code-first decomposer was too aggressive a recommendation

ChatGPT's critique: "would create a second intent-routing system to maintain" and "conflicts with this repo's explicit design direction."

This is fair. The CLAUDE.md rule against regex/keyword classification exists for good reason, and while spaCy is a trained model (not regex), building a parallel routing system is a large architectural bet that the current evidence doesn't fully justify. The 96%-single-ask stat is real but doesn't prove that code classification would be *correct* on those 96% — it only proves the decomposer outputs single asks.

I should have presented the code-first approach as an option to evaluate after the high-confidence fixes are applied and re-measured, not as the primary recommendation.

---

## Where ChatGPT is wrong or incomplete

### 1. The production traces show 18–20s, not 3.5s

ChatGPT's review focuses on "trim the subject registry and fix the greeting fast path" as sufficient. But there's a gap between my isolated benchmarks (3.5–3.8s for full decompose()) and production traces (18–20s). My re-benchmarking shows:

| Measurement | Time | Condition |
|-------------|------|-----------|
| Isolated `decompose()` call, warm model, 5 runs | 3.5–3.8s | No other load, model resident |
| Isolated `decompose()` call, cold start | 12.3s | First call after loading |
| Production trace ("hi") | 18.4s | Real pipeline, user-facing |
| Production trace ("what is nintendo") | 20.0s | Real pipeline, user-facing |

The 5x gap between isolated benchmarks and production isn't fully explained by the subject registry alone. There's likely additional overhead from: model not being fully warm, KV cache state from prior calls at different num_ctx, system load, or other pipeline interactions.

Trimming the subject registry will help proportionally in all conditions, but claiming it solves the problem requires actually measuring the production pipeline after the fix — which is exactly what ChatGPT recommends. That's correct.

### 2. The fast-lane fix is not as simple as "lower the threshold"

ChatGPT suggests "either add exact-string short-circuits for trivial greetings/gratitude before embeddings, or lower the threshold." The exact-string approach is fine for greetings, but it doesn't help with paraphrases ("hey what's going on" vs "what's up") — which is the whole point of the embedding-based approach.

The real issue is that the embedder scores "hi" against "hi" at only 0.875. Lowering the threshold to 0.80 catches "hi" but may also catch non-greetings ("high" → "hi"?). The right fix is either:
- Test with the real embedder (not the fake one in tests) and set the threshold based on actual production similarity scores
- Use exact match as a first pass, embeddings as a second pass with a lower threshold

This is a more nuanced fix than "just lower the threshold."

### 3. "spaCy is not new leverage" misses the point

ChatGPT notes spaCy is already a dependency. True. But it's currently only used in decomposer repair (post-processing), not pre-processing. The point wasn't "install spaCy" — it was "use spaCy *before* the LLM call to reduce what the LLM needs to do." That's genuinely different from its current role.

That said, ChatGPT is right that the scope of spaCy's pre-processing role matters. Using it for candidate narrowing (resolving entities against the DB so only relevant names go into the prompt) is defensible and low-risk. Using it to replace semantic routing is a bigger bet.

### 4. "The strongest conclusion is trim the registry" undersells the schema penalty

At full prompt size, the schema penalty is 3.1x (3.7s vs 1.2s, warmed up). Even after trimming the people list, if the decomposer still uses schema-constrained decoding, it'll be ~3.0s vs ~2.3s (1.3x). That's not dramatic, but combined with the grammar recompilation spikes (6–12s on first run), it's still meaningful. Switching to loose JSON + validation is a small, safe change that eliminates a real variance source.

---

## Revised position

ChatGPT's recommended order is correct. Here's what I'd now propose:

### Phase 1: High-confidence fixes (do all of these, then re-measure)

1. **Cap KNOWN_SUBJECTS.people** to entities mentioned in recent context + spaCy NER matches from the current input. Max ~10–15 names. This is the highest-ROI fix.

2. **Fix the fast-lane** — add exact-string match for the curated greeting/gratitude lists as a pre-check before the embedding comparison. Test the threshold against the real embedder. Add regression tests with the real embedder.

3. **Decouple synthesis num_ctx** from the decomposer. Give synthesis its own explicit budget source set to the model's default loaded context (4096).

4. **Add a regression test** for KNOWN_SUBJECTS at realistic scale (100+, not 10).

### Phase 2: Re-measure, then decide

After Phase 1, measure actual production pipeline latency. If decomposition is still >5s:

5. **Switch to loose JSON** (`format="json"`) + validation in the decomposer. The schema penalty is real (1.3–3.1x depending on prompt size), and grammar recompilation spikes add variance.

6. **Use spaCy for entity pre-resolution** — run NER on user_input, match against people/entity DB, and inject only matched names into the decomposer prompt. This is narrower than a "code-first decomposer" — it's pre-processing that makes the LLM's job easier, not a replacement for it.

### Phase 3: Only if Phase 2 isn't enough

7. **Code-based fast classification for obvious patterns** (greetings, "what is X", weather, time) — but scoped as an expansion of the existing micro_fast_lane, not a parallel routing system. The decomposer remains the primary classifier for anything non-trivial.

---

## Corrections to the analysis document

The following claims in `decomposer-latency-2026-04-10.md` need correction:

| Claim | Correction |
|-------|-----------|
| "model has 4,096 token context window" | Model supports 131K context. Ollama loads with 4,096 default KV cache allocation. Runtime expansion is possible and happens when num_ctx is set higher. |
| "prompt overflows context by 31%" | Prompt is not truncated. The cost is attention over a large prompt, not context overflow. |
| "constrained decode is 2.8x slower" | Depends on prompt size: 3.1x at full prompt, 1.3x at small prompt. Also has high first-run variance from grammar compilation. |
| "2–4s decomposition projected" | Isolated benchmarks show 3.5–3.8s warmed-up with current full prompt. Production conditions add significant overhead. Projecting specific numbers requires measuring after fixes. |
| Code-first decomposer as primary recommendation | Should be Phase 3, after simpler fixes are applied and measured. |
