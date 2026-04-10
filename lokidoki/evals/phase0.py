from __future__ import annotations

import json
from pathlib import Path


EVAL_RUBRIC = {
    "answer_first_behavior": "Does the reply answer before adding social language or follow-ups?",
    "non_echo_behavior": "Does the reply avoid parroting the user's wording or stored memory?",
    "memory_relevance": "Any personalization should be directly helpful to this turn.",
    "repetition": "Avoid repeated openings, repeated hooks, and repeated memory callbacks.",
    "grounding_freshness": "Current-data turns should prefer grounded fresh information.",
    "latency": "Track end-to-end latency and time-to-first-token against baseline.",
}


def load_phase0_eval_corpus() -> list[dict]:
    fixture_path = (
        Path(__file__).resolve().parents[2]
        / "tests"
        / "fixtures"
        / "phase0_eval_corpus.json"
    )
    return json.loads(fixture_path.read_text())
