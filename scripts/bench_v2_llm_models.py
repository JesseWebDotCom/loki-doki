"""Bake-off harness for the v2 LLM fallback path.

Runs the same set of representative prompts across multiple Ollama
models so we can pick the best default for each prompt family
(``direct_chat`` and ``combine``). For each (model, prompt) pair we
record:

  - Wall-time end-to-end (warm only — see below).
  - Response text + word/char count for side-by-side quality eval.

Critical fairness constraint: every reported latency is measured AFTER
the model has been fully loaded into Ollama VRAM and AFTER a throwaway
warmup inference. This guarantees:

  1. Model switch / load time (which can be 5–30s for an 8B model) is
     never included in the measurement.
  2. The cache / context-window state is identical between runs.
  3. We do N replicates per prompt and report ``min`` (best case),
     ``median`` (typical), and ``mean`` so a single hiccup does not
     skew the comparison.

The warmup procedure for each model is:

  a) Send a tiny ``"hi"`` prompt and wait for the response. This
     forces Ollama to load the weights into VRAM and JIT the
     attention kernels.
  b) Send the actual benchmark prompt once and DISCARD the result.
     This warms the prompt-side KV cache for the prompt template
     family (direct_chat / combine) we're about to measure.
  c) Send the actual benchmark prompt N more times and record the
     warm latencies. Only the (b)/(c) timings are written to the
     report — never the (a) load.

Usage:

  python scripts/bench_v2_llm_models.py \
      --models gemma4:e4b gemma4:e2b qwen3:4b qwen3:8b llama3.1:8b \
      --replicates 3 \
      --output /tmp/v2_llm_bench.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from v2.orchestrator.core import config as v2_config
from v2.orchestrator.core.types import RequestChunkResult, RequestSpec
from v2.orchestrator.fallbacks.llm_fallback import build_combine_prompt
from v2.orchestrator.fallbacks.ollama_client import call_llm, set_inference_client_factory


# ---------------------------------------------------------------------------
# Prompt corpus
#
# Each entry tags whether it exercises the direct_chat template (no skill
# matched, conversational answer) or the combine template (one or more
# skills produced data and the model must weave them together).
# ---------------------------------------------------------------------------

@dataclass
class BenchPrompt:
    id: str
    family: str  # "direct_chat" or "combine"
    user_request: str
    spec: RequestSpec


def _direct_chat_spec(user_question: str) -> RequestSpec:
    return RequestSpec(
        trace_id=f"bench-dc-{user_question[:8]}",
        original_request=user_question,
        chunks=[
            RequestChunkResult(
                text=user_question,
                role="primary_request",
                capability="direct_chat",
                confidence=0.55,
                success=True,
                result={"output_text": user_question},
            )
        ],
        llm_used=True,
        llm_reason="direct_chat",
    )


def _combine_spec_with_supporting_context(
    user_request: str,
    primary_text: str,
    primary_capability: str,
    primary_output: str,
    supporting_text: str,
) -> RequestSpec:
    return RequestSpec(
        trace_id=f"bench-cb-{user_request[:8]}",
        original_request=user_request,
        chunks=[
            RequestChunkResult(
                text=primary_text,
                role="primary_request",
                capability=primary_capability,
                confidence=0.95,
                success=True,
                result={"output_text": primary_output},
            ),
            RequestChunkResult(
                text=supporting_text,
                role="supporting_context",
                capability="",
                confidence=0.0,
            ),
        ],
        supporting_context=[supporting_text],
        llm_used=True,
        llm_reason="supporting_context",
    )


def _empty_skill_spec(
    user_request: str,
    primary_capability: str,
) -> RequestSpec:
    """A skill that succeeded but returned an empty output_text — should
    fall through to LLM via the new ``empty_output`` trigger."""
    return RequestSpec(
        trace_id=f"bench-eo-{user_request[:8]}",
        original_request=user_request,
        chunks=[
            RequestChunkResult(
                text=user_request,
                role="primary_request",
                capability=primary_capability,
                confidence=0.85,
                success=True,
                result={"output_text": ""},
            )
        ],
        llm_used=True,
        llm_reason="empty_output",
    )


PROMPTS: list[BenchPrompt] = [
    # ---- direct_chat: factual / definitional ----
    BenchPrompt(
        id="dc.json_acronym",
        family="direct_chat",
        user_request="what does json stand for",
        spec=_direct_chat_spec("what does json stand for"),
    ),
    BenchPrompt(
        id="dc.ring_privacy",
        family="direct_chat",
        user_request="do my ring cameras spy on me",
        spec=_direct_chat_spec("do my ring cameras spy on me"),
    ),
    BenchPrompt(
        id="dc.wifi_slow",
        family="direct_chat",
        user_request="why is my wifi so slow",
        spec=_direct_chat_spec("why is my wifi so slow"),
    ),
    BenchPrompt(
        id="dc.casual_chat",
        family="direct_chat",
        user_request="tell me a fun fact about octopuses",
        spec=_direct_chat_spec("tell me a fun fact about octopuses"),
    ),
    BenchPrompt(
        id="dc.opinion",
        family="direct_chat",
        user_request="what's the difference between machine learning and ai",
        spec=_direct_chat_spec("what's the difference between machine learning and ai"),
    ),

    # ---- combine: skill output + supporting context ----
    BenchPrompt(
        id="cb.time_running_late",
        family="combine",
        user_request="what time is it because im running late",
        spec=_combine_spec_with_supporting_context(
            user_request="what time is it because im running late",
            primary_text="what time is it",
            primary_capability="get_current_time",
            primary_output="3:42 PM",
            supporting_text="because im running late",
        ),
    ),
    BenchPrompt(
        id="cb.weather_picnic",
        family="combine",
        user_request="whats the weather like im planning a picnic this afternoon",
        spec=_combine_spec_with_supporting_context(
            user_request="whats the weather like im planning a picnic this afternoon",
            primary_text="whats the weather like",
            primary_capability="get_weather",
            primary_output="72F and partly cloudy this afternoon in San Francisco",
            supporting_text="im planning a picnic this afternoon",
        ),
    ),
    BenchPrompt(
        id="cb.directions_traffic",
        family="combine",
        user_request="how long to drive to the airport im worried about traffic",
        spec=_combine_spec_with_supporting_context(
            user_request="how long to drive to the airport im worried about traffic",
            primary_text="how long to drive to the airport",
            primary_capability="get_directions",
            primary_output="22 miles, about 35 minutes via US-101 N",
            supporting_text="im worried about traffic",
        ),
    ),

    # ---- empty_output: skill returned blank, llm must answer from scratch ----
    BenchPrompt(
        id="eo.knicks_score",
        family="direct_chat",  # treated like direct_chat in prompt selection
        user_request="whats the score of the knicks game",
        spec=_empty_skill_spec("whats the score of the knicks game", "get_score"),
    ),
]


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------


@dataclass
class RunResult:
    model: str
    prompt_id: str
    family: str
    user_request: str
    response_text: str
    warm_ms_min: float
    warm_ms_median: float
    warm_ms_mean: float
    warm_ms_replicates: list[float]
    response_chars: int
    response_words: int
    error: str = ""


@dataclass
class ModelSummary:
    model: str
    direct_chat_avg_warm_ms: float
    combine_avg_warm_ms: float
    overall_avg_warm_ms: float
    overall_median_warm_ms: float
    overall_p95_warm_ms: float
    successful_runs: int
    failed_runs: int
    avg_response_words: float


async def _warmup_model(model: str) -> tuple[bool, str]:
    """Force Ollama to load the model and JIT its kernels.

    Returns ``(success, error_message)``. We send a deliberately tiny
    prompt and wait for the response so subsequent calls don't pay
    the load cost.
    """
    object.__setattr__(v2_config.CONFIG, "llm_model", model)
    try:
        # The first call after a model switch is the expensive one — it
        # has to load weights into VRAM. We don't time it.
        await call_llm("hi")
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)
    return True, ""


async def _run_single(model: str, prompt: BenchPrompt, replicates: int) -> RunResult:
    """Measure ``replicates`` warm calls for one (model, prompt) pair.

    The model has already been loaded by ``_warmup_model``. To remove
    KV-cache cold-start effects from the prompt template, we run one
    additional discarded warmup call before timing.
    """
    rendered_prompt = build_combine_prompt(prompt.spec)
    object.__setattr__(v2_config.CONFIG, "llm_model", model)

    # Prompt-template warmup: warms the KV cache for this exact prompt
    # shape so the first measured call doesn't pay the prefill cost.
    discard, _ = await _timed_call(rendered_prompt)
    if isinstance(discard, Exception):
        return RunResult(
            model=model,
            prompt_id=prompt.id,
            family=prompt.family,
            user_request=prompt.user_request,
            response_text="",
            warm_ms_min=0.0,
            warm_ms_median=0.0,
            warm_ms_mean=0.0,
            warm_ms_replicates=[],
            response_chars=0,
            response_words=0,
            error=str(discard),
        )

    samples: list[float] = []
    last_text = ""
    for _ in range(replicates):
        text, elapsed_ms = await _timed_call(rendered_prompt)
        if isinstance(text, Exception):
            return RunResult(
                model=model,
                prompt_id=prompt.id,
                family=prompt.family,
                user_request=prompt.user_request,
                response_text=last_text,
                warm_ms_min=min(samples) if samples else 0.0,
                warm_ms_median=statistics.median(samples) if samples else 0.0,
                warm_ms_mean=statistics.mean(samples) if samples else 0.0,
                warm_ms_replicates=samples,
                response_chars=len(last_text),
                response_words=len(last_text.split()),
                error=str(text),
            )
        samples.append(elapsed_ms)
        last_text = text.strip()

    return RunResult(
        model=model,
        prompt_id=prompt.id,
        family=prompt.family,
        user_request=prompt.user_request,
        response_text=last_text,
        warm_ms_min=min(samples),
        warm_ms_median=statistics.median(samples),
        warm_ms_mean=statistics.mean(samples),
        warm_ms_replicates=samples,
        response_chars=len(last_text),
        response_words=len(last_text.split()),
    )


async def _timed_call(prompt: str):
    start = time.perf_counter()
    try:
        text = await call_llm(prompt)
    except Exception as exc:  # noqa: BLE001
        return exc, (time.perf_counter() - start) * 1000
    return text, (time.perf_counter() - start) * 1000


def _summarise(results: list[RunResult]) -> list[ModelSummary]:
    summaries: list[ModelSummary] = []
    by_model: dict[str, list[RunResult]] = {}
    for r in results:
        by_model.setdefault(r.model, []).append(r)

    for model, runs in by_model.items():
        successful = [r for r in runs if not r.error and r.warm_ms_median > 0]
        failed = [r for r in runs if r.error]
        if not successful:
            summaries.append(
                ModelSummary(
                    model=model,
                    direct_chat_avg_warm_ms=0,
                    combine_avg_warm_ms=0,
                    overall_avg_warm_ms=0,
                    overall_median_warm_ms=0,
                    overall_p95_warm_ms=0,
                    successful_runs=0,
                    failed_runs=len(failed),
                    avg_response_words=0,
                )
            )
            continue

        # Use median across replicates as the per-prompt latency so a
        # single jittery sample doesn't poison the model average.
        dc = [r.warm_ms_median for r in successful if r.family == "direct_chat"]
        cb = [r.warm_ms_median for r in successful if r.family == "combine"]
        all_warm = [r.warm_ms_median for r in successful]
        words = [r.response_words for r in successful]

        summaries.append(
            ModelSummary(
                model=model,
                direct_chat_avg_warm_ms=statistics.mean(dc) if dc else 0,
                combine_avg_warm_ms=statistics.mean(cb) if cb else 0,
                overall_avg_warm_ms=statistics.mean(all_warm),
                overall_median_warm_ms=statistics.median(all_warm),
                overall_p95_warm_ms=_p95(all_warm),
                successful_runs=len(successful),
                failed_runs=len(failed),
                avg_response_words=statistics.mean(words),
            )
        )

    return summaries


def _p95(values: list[float]) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    idx = max(0, int(len(sorted_vals) * 0.95) - 1)
    return sorted_vals[idx]


async def _run_bench(
    models: list[str],
    prompts: list[BenchPrompt],
    replicates: int,
) -> dict[str, Any]:
    set_inference_client_factory(None)
    object.__setattr__(v2_config.CONFIG, "llm_enabled", True)

    results: list[RunResult] = []
    for model in models:
        print(f"\n{'=' * 70}\nMODEL: {model}\n{'=' * 70}")
        print("  → warming up model (loading weights into VRAM)…")
        load_start = time.perf_counter()
        ok, err = await _warmup_model(model)
        load_ms = (time.perf_counter() - load_start) * 1000
        if not ok:
            print(f"  ❌ warmup failed: {err}")
            for prompt in prompts:
                results.append(
                    RunResult(
                        model=model,
                        prompt_id=prompt.id,
                        family=prompt.family,
                        user_request=prompt.user_request,
                        response_text="",
                        warm_ms_min=0.0,
                        warm_ms_median=0.0,
                        warm_ms_mean=0.0,
                        warm_ms_replicates=[],
                        response_chars=0,
                        response_words=0,
                        error=f"warmup failed: {err}",
                    )
                )
            continue
        print(f"  ✓ model loaded (one-time cost: {load_ms:.0f}ms — NOT counted)")

        for prompt in prompts:
            print(f"  → [{prompt.family}] {prompt.id}: {prompt.user_request}")
            result = await _run_single(model, prompt, replicates=replicates)
            results.append(result)
            if result.error:
                print(f"    ❌ ERROR: {result.error}")
            else:
                preview = result.response_text.replace("\n", " ")[:120]
                samples_str = " ".join(f"{s:.0f}" for s in result.warm_ms_replicates)
                print(
                    f"    ✓ min={result.warm_ms_min:.0f}ms median={result.warm_ms_median:.0f}ms "
                    f"mean={result.warm_ms_mean:.0f}ms (samples: {samples_str}ms) "
                    f"words={result.response_words}"
                )
                print(f"      → {preview}{'...' if len(result.response_text) > 120 else ''}")

    summaries = _summarise(results)
    return {
        "models": models,
        "replicates": replicates,
        "prompt_count": len(prompts),
        "results": [asdict(r) for r in results],
        "summaries": [asdict(s) for s in summaries],
    }


def _print_summary_table(summaries: list[ModelSummary]) -> None:
    print(f"\n{'=' * 90}")
    print(f"{'MODEL':<22} {'DC avg':>10} {'CB avg':>10} {'all avg':>10} {'median':>10} {'p95':>10} {'words':>8}")
    print("-" * 90)
    for s in sorted(summaries, key=lambda s: s.overall_avg_warm_ms or float("inf")):
        if s.successful_runs == 0:
            print(f"{s.model:<22} {'FAILED':>10}")
            continue
        print(
            f"{s.model:<22} "
            f"{s.direct_chat_avg_warm_ms:>9.0f}ms "
            f"{s.combine_avg_warm_ms:>9.0f}ms "
            f"{s.overall_avg_warm_ms:>9.0f}ms "
            f"{s.overall_median_warm_ms:>9.0f}ms "
            f"{s.overall_p95_warm_ms:>9.0f}ms "
            f"{s.avg_response_words:>7.0f}"
        )
    print("=" * 90)


def _load_corpus_prompts(path: Path) -> list[BenchPrompt]:
    """Load utterances from a v2 regression-fixture JSON file and turn
    each one into a ``direct_chat`` BenchPrompt.

    The fixtures aren't all llm-relevant in the real pipeline (most
    of them get answered by skills before llm sees them), but for
    *quality stress-testing* the right thing to do is force the model
    to answer each utterance from its own knowledge. This catches
    refusals, scaffolding leakage, and meta-language drift on a much
    wider distribution of real conversational inputs than the small
    9-prompt curated set.
    """
    data = json.loads(path.read_text())
    cases = data.get("cases") or data
    if not isinstance(cases, list):
        raise ValueError(f"unexpected fixture shape in {path}")
    prompts: list[BenchPrompt] = []
    for case in cases:
        case_id = str(case.get("id") or "")
        utterance = str(case.get("utterance") or "").strip()
        if not utterance:
            continue
        prompts.append(
            BenchPrompt(
                id=f"corpus.{case_id}",
                family="direct_chat",
                user_request=utterance,
                spec=_direct_chat_spec(utterance),
            )
        )
    return prompts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--models",
        nargs="+",
        required=True,
        help="Ollama model tags to test (e.g. gemma4:e4b qwen3:4b)",
    )
    parser.add_argument(
        "--output",
        default="/tmp/v2_llm_bench.json",
        help="Where to write the full result blob (default: /tmp/v2_llm_bench.json)",
    )
    parser.add_argument(
        "--family",
        choices=["all", "direct_chat", "combine"],
        default="all",
        help="Restrict the benchmark to one prompt family",
    )
    parser.add_argument(
        "--replicates",
        type=int,
        default=3,
        help="Warm-call replicates per (model, prompt) — default 3",
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        default=None,
        help=(
            "Optional path to a v2 regression-fixture JSON file. When "
            "set, every utterance in the file is loaded as a "
            "direct_chat prompt and the curated 9-prompt set is "
            "ignored. Use this for large-scale quality stress tests."
        ),
    )
    args = parser.parse_args()

    if args.corpus is not None:
        selected_prompts = _load_corpus_prompts(args.corpus)
        print(f"Loaded {len(selected_prompts)} prompts from {args.corpus}")
    else:
        selected_prompts = (
            PROMPTS
            if args.family == "all"
            else [p for p in PROMPTS if p.family == args.family]
        )

    payload = asyncio.run(_run_bench(args.models, selected_prompts, args.replicates))
    Path(args.output).write_text(json.dumps(payload, indent=2))
    print(f"\nWrote full results to {args.output}")
    _print_summary_table([ModelSummary(**s) for s in payload["summaries"]])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
