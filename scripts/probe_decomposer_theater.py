"""Live decomposer probe for the theater-extraction prompt rule.

Runs a small panel of inputs against the real decomposer + gemma and
prints what it emits for each. Output is non-deterministic so this is
NOT a pytest test — it's a one-shot validation script you re-run after
each prompt iteration to spot leakage.

Usage::

    uv run python scripts/probe_decomposer_theater.py

What we're checking
-------------------
Positive cases (expect ``parameters.theater`` populated):
  * bare venue with chain prefix
  * "what's playing at <theater>"
  * theater + movie title together (expect both `theater` and `query`)

Negative cases (expect ``parameters.theater`` ABSENT):
  * bare movie title — must NOT be misclassified as a theater
  * unrelated proper noun ("Costco") — must NOT be misclassified
  * generic showtimes ask with no theater named — leave it to the
    skill's clarification path

Each line prints PASS/FAIL plus the populated parameters dict so you
can eyeball the leakage. Failures don't exit non-zero — gemma is
flaky enough that one bad run is meaningful only as a hint to iterate
on the prompt, not as a hard CI gate.
"""
from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import dataclass
from typing import Optional

from lokidoki.core.decomposer import Decomposer
from lokidoki.core.inference import InferenceClient


# (input, expects_theater, expects_query, label)
PROBES = [
    # ---- positives -------------------------------------------------------
    ("Galaxy Cinemas 16", True, False, "bare venue, full chain prefix"),
    ("Starlight Marquis 16", True, False, "bare venue, Starlight prefix"),
    ("what's playing at Starlight Marquis tonight", True, False, "at-phrase, Starlight"),
    ("showtimes at the Galaxy Cinemas", True, False, "at-phrase, generic Galaxy Cinemas"),
    ("what time is Hoppers playing at Starlight Marquis", True, True, "title + venue"),
    # ---- negatives -------------------------------------------------------
    ("Hoppers", False, False, "bare movie title (should NOT be theater)"),
    ("Costco", False, False, "unrelated proper noun (should NOT be theater)"),
    ("what's playing tonight", False, False, "generic showtimes ask, no venue"),
    ("Trump", False, False, "bare person name (should NOT be theater)"),
]


@dataclass
class ProbeResult:
    label: str
    user_input: str
    expects_theater: bool
    expects_query: bool
    got_theater: Optional[str]
    got_query: Optional[str]
    intent: str
    capability_need: str

    @property
    def theater_ok(self) -> bool:
        if self.expects_theater:
            return bool(self.got_theater)
        return not self.got_theater

    @property
    def query_ok(self) -> bool:
        if self.expects_query:
            return bool(self.got_query)
        # Negative-case query is fine either way; we only assert
        # theater absence on negatives. Hardcode True to avoid false
        # alarms when the model emits an incidental query field.
        return True

    @property
    def passed(self) -> bool:
        return self.theater_ok and self.query_ok


async def run() -> int:
    client = InferenceClient()
    decomposer = Decomposer(inference_client=client)
    # Match the real orchestrator: pass a realistic available_intents
    # list so gemma stays inside the closed set instead of inventing
    # intent names like "extract_entity".
    available_intents = [
        "direct_chat",
        "movies_fandango.get_showtimes",
        "weather_owm.get_forecast",
        "knowledge_wiki.search",
    ]

    results: list[ProbeResult] = []
    for user_input, expects_theater, expects_query, label in PROBES:
        try:
            decomp = await decomposer.decompose(
                user_input=user_input,
                available_intents=available_intents,
            )
        except Exception as e:  # noqa: BLE001
            print(f"  [error] {label}: {e}")
            continue
        ask = (decomp.asks or [None])[0]
        params = (getattr(ask, "parameters", None) or {}) if ask else {}
        results.append(ProbeResult(
            label=label,
            user_input=user_input,
            expects_theater=expects_theater,
            expects_query=expects_query,
            got_theater=params.get("theater"),
            got_query=params.get("query"),
            intent=getattr(ask, "intent", "?") if ask else "?",
            capability_need=getattr(ask, "capability_need", "?") if ask else "?",
        ))

    print()
    print(f"{'STATUS':6}  {'LABEL':45}  {'INPUT':40}  PARAMETERS")
    print("-" * 130)
    passed = 0
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        if r.passed:
            passed += 1
        params_repr = json.dumps(
            {k: v for k, v in {"theater": r.got_theater, "query": r.got_query}.items() if v},
            ensure_ascii=False,
        )
        print(f"{status:6}  {r.label[:45]:45}  {r.user_input[:40]:40}  {params_repr}")

    print()
    print(f"{passed}/{len(results)} probes passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
