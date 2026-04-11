"""Merge + score the two v2 Gemma bake-off runs.

Input: /tmp/v2_gemma_bench_local.json + /tmp/v2_gemma_bench_new.json
Output: stdout — combined leaderboard sorted by a quality-aware score.

Quality grading is rule-based and conservative. We penalise:

  1. Scaffolding leakage — model leaked the prompt rules / template
     scaffolding into the user-visible answer. Examples:
       "Sure, here's the natural-language response:"
       "We are given a question:"
       "Steps:"
       "I must answer in the first person"
  2. Internal-terminology leakage — the model talked about "the
     request", "the spec", "RequestSpec", "output_text", "primary
     request", "chunks" etc. (the exact things the prompt told it not
     to mention).
  3. Refusals — the model said it can't / won't answer when it
     obviously could (e.g. "I can't provide information about ring
     cameras' spying capabilities").
  4. Empty / non-answer — the response acknowledges the question but
     never delivers content.

Each response gets a 0-100 quality score. The leaderboard sorts on a
combined ``score = quality - latency_penalty``.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path


SCAFFOLD_PATTERNS = [
    r"sure,?\s+here'?s the natural-language response",
    r"here'?s the natural-language response",
    r"\bwe are given a (?:question|requestspec|json)",
    r"^\s*steps?:\s*$",
    r"\bi must answer in",
    r"\blet me check the rule",
    r"\bthe rule says\b",
    r"\bwe (?:can|must|should) (?:say|answer|note|format)",
    r"\bnow let'?s (?:craft|write|consider)",
]

META_TERMS = [
    r"\brequestspec\b",
    r"\bthe primary request\b",
    r"\bthe spec\b",
    r"\bthe (?:user'?s )?request\b",
    r"\boutput[_\s]text\b",
    r"\bunresolved chunks?\b",
    r"\bprimary[-_\s]request\b",
    r"\bsuccessfully processed\b",
    r"\bin the context of (?:the )?request\b",
]

# Indicates the model refused to answer something it could.
REFUSAL_PATTERNS = [
    r"i'?m? (?:not )?(?:able|equipped) to (?:provide|answer|diagnose|explain)",
    r"i (?:cannot|can'?t) (?:provide|access|disclose|advise)",
    r"i don'?t have access to",
    r"as i am (?:not|unable)",
    r"i am unable to",
]

# Indicates the model deferred everything without giving real content.
EMPTY_NON_ANSWER_PATTERNS = [
    r"^i'?m having trouble understanding",
    r"^could you please (?:confirm|clarify|provide|tell me)",
    r"^can you please (?:specify|clarify|tell me|provide)",
]


def _grade(response: str) -> tuple[int, list[str]]:
    """Return ``(score_0_to_100, list_of_issue_tags)``."""
    text = response.strip()
    if not text:
        return 0, ["empty"]
    lower = text.lower()
    issues: list[str] = []
    score = 100

    for pattern in SCAFFOLD_PATTERNS:
        if re.search(pattern, lower):
            issues.append(f"scaffold:{pattern[:30]}")
            score -= 25
            break  # one scaffold hit is already disqualifying

    for pattern in META_TERMS:
        if re.search(pattern, lower):
            issues.append(f"meta:{pattern[:30]}")
            score -= 20
            break

    for pattern in REFUSAL_PATTERNS:
        if re.search(pattern, lower):
            issues.append(f"refusal:{pattern[:30]}")
            score -= 15
            break

    for pattern in EMPTY_NON_ANSWER_PATTERNS:
        if re.search(pattern, lower):
            issues.append(f"non_answer:{pattern[:30]}")
            score -= 30
            break

    # Verbosity penalty: anything over 80 words for a 1-3 sentence
    # constraint is bloat.
    word_count = len(text.split())
    if word_count > 80:
        issues.append(f"verbose:{word_count}w")
        score -= 10

    return max(0, score), issues


@dataclass
class ScoredResult:
    model: str
    prompt_id: str
    family: str
    user_request: str
    response_text: str
    warm_ms_median: float
    quality_score: int
    issues: list[str]


def load_results(path: Path) -> list[dict]:
    return json.loads(path.read_text())["results"]


def main() -> int:
    all_results: list[ScoredResult] = []
    for path in [
        Path("/tmp/v2_gemma_bench_local.json"),
        Path("/tmp/v2_gemma_bench_new.json"),
    ]:
        for r in load_results(path):
            if r.get("error"):
                continue
            score, issues = _grade(r["response_text"])
            all_results.append(
                ScoredResult(
                    model=r["model"],
                    prompt_id=r["prompt_id"],
                    family=r["family"],
                    user_request=r["user_request"],
                    response_text=r["response_text"],
                    warm_ms_median=r["warm_ms_median"],
                    quality_score=score,
                    issues=issues,
                )
            )

    # Group by model and produce summary
    by_model: dict[str, list[ScoredResult]] = {}
    for r in all_results:
        by_model.setdefault(r.model, []).append(r)

    print(f"\n{'='*100}")
    print("V2 GEMMA MODEL BAKE-OFF — UNIFIED LEADERBOARD")
    print(f"{'='*100}")
    print(f"{'MODEL':<20} {'qual':>6} {'DC ms':>8} {'CB ms':>8} {'all ms':>8} {'p95 ms':>8} {'issues':>8} {'verdict':<25}")
    print("-" * 100)

    summary: list[tuple[float, str, str]] = []
    for model, runs in by_model.items():
        dc = [r.warm_ms_median for r in runs if r.family == "direct_chat"]
        cb = [r.warm_ms_median for r in runs if r.family == "combine"]
        all_warm = [r.warm_ms_median for r in runs]
        all_warm_sorted = sorted(all_warm)
        p95 = all_warm_sorted[max(0, int(len(all_warm_sorted) * 0.95) - 1)]
        avg_quality = sum(r.quality_score for r in runs) / len(runs)
        total_issues = sum(1 for r in runs if r.issues)

        # Combined score: quality-weighted, latency-penalised.
        # Quality is 0-100, latency penalty is ~10 per 1000ms.
        latency_penalty = sum(all_warm) / len(all_warm) / 100
        composite = avg_quality - latency_penalty

        verdict = _verdict(avg_quality, sum(all_warm) / len(all_warm), total_issues)

        summary.append((composite, model, verdict))
        print(
            f"{model:<20} "
            f"{avg_quality:>5.0f}  "
            f"{(sum(dc)/len(dc) if dc else 0):>6.0f}ms "
            f"{(sum(cb)/len(cb) if cb else 0):>6.0f}ms "
            f"{(sum(all_warm)/len(all_warm)):>6.0f}ms "
            f"{p95:>6.0f}ms "
            f"{total_issues:>5}/9 "
            f"  {verdict}"
        )

    print(f"{'='*100}")
    print("\nRANKED BY COMPOSITE (quality - latency_penalty), HIGHER IS BETTER:")
    print("-" * 100)
    for composite, model, verdict in sorted(summary, reverse=True):
        print(f"  {composite:>7.1f}  {model:<20}  {verdict}")
    print("-" * 100)

    # Per-model issue breakdown for the bottom finishers
    print("\nQUALITY ISSUES BY MODEL (lower is better):")
    print("-" * 100)
    for model, runs in sorted(by_model.items(), key=lambda kv: -sum(1 for r in kv[1] if r.issues)):
        bad = [r for r in runs if r.issues]
        if not bad:
            print(f"  {model:<20}  ✓ no issues")
            continue
        print(f"  {model:<20}  {len(bad)}/9 prompts had issues:")
        for r in bad:
            tags = ", ".join(t.split(":")[0] for t in r.issues)
            print(f"    [{r.family}] {r.prompt_id}: {tags}")

    return 0


def _verdict(quality: float, latency_ms: float, issues: int) -> str:
    if quality >= 90 and latency_ms <= 800 and issues == 0:
        return "★ ship-ready"
    if quality >= 80 and latency_ms <= 1500 and issues <= 1:
        return "✓ strong contender"
    if quality >= 70 and latency_ms <= 2000:
        return "↓ usable, has caveats"
    if quality < 50:
        return "✗ poor quality"
    if latency_ms > 2500:
        return "✗ too slow"
    return "↓ has caveats"


if __name__ == "__main__":
    raise SystemExit(main())
