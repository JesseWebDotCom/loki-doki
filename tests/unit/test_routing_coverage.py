"""Routing accuracy coverage — held-out user queries per capability.

This test measures two separate signals:

1. **MiniLM-only baseline** — routing without the decomposer prior.
   Tells us whether the registry's example corpus alone is enough to
   route a phrasing the corpus doesn't literally contain.

2. **With decomposer prior** — routing with a (mocked) oracle
   decomposer that emits the correct ``capability_need``. Simulates
   the best case for the decomposer integration — gives an upper
   bound on how much the LLM prior helps.

Per-category floors enforce a minimum routing accuracy. When they
regress, that's a signal to add examples to the registry OR tune the
decomposer's boost magnitudes.
"""
from __future__ import annotations

import unittest

from lokidoki.orchestrator.core.types import RequestChunk
from lokidoki.orchestrator.decomposer.types import RouteDecomposition
from lokidoki.orchestrator.registry.runtime import get_runtime
from lokidoki.orchestrator.routing.router import route_chunk


# Held-out routing corpus — queries that do NOT appear verbatim in
# function_registry.json. Each tuple is (user_query, expected_capability,
# capability_need_hint). capability_need_hint is what an ideal decomposer
# should emit; tests run both with and without that hint.
#
# Capabilities here are CANONICAL — aliases (get_forecast, convert,
# lookup_birthday) resolve to their canonical target via
# ``runtime.resolve_capability`` before the comparison.
ROUTING_CORPUS: list[tuple[str, str, str]] = [
    # ── MEDICAL ─────────────────────────────────────────────────
    # Medical routes to knowledge_query first — that's the ZIM-backed
    # handler (MDWiki / WikEM). look_up_symptom is a web-only fallback.
    ("my head is pounding", "knowledge_query", "medical"),
    ("ankle is really swollen", "knowledge_query", "medical"),
    ("ibuprofen with food or without", "knowledge_query", "medical"),
    ("tylenol extra strength dosage", "knowledge_query", "medical"),
    ("what does zoloft treat", "knowledge_query", "medical"),
    ("pain in my lower back for a week", "knowledge_query", "medical"),
    # ── HOWTO / KNOWLEDGE ───────────────────────────────────────
    ("how do i unstop a kitchen sink", "knowledge_query", "howto"),
    ("steps to re-tile a shower wall", "knowledge_query", "howto"),
    ("fix a running toilet", "knowledge_query", "howto"),
    # ── COUNTRY FACTS ───────────────────────────────────────────
    ("how many people live in sweden", "knowledge_query", "country_facts"),
    ("currency of thailand", "knowledge_query", "country_facts"),
    # ── EDUCATION ───────────────────────────────────────────────
    ("explain the chain rule", "knowledge_query", "education"),
    ("what is newton's second law", "knowledge_query", "education"),
    # ── GEOGRAPHIC ──────────────────────────────────────────────
    ("top attractions in tokyo", "knowledge_query", "geographic"),
    ("must-see places in reykjavik", "knowledge_query", "geographic"),
    # ── ENCYCLOPEDIC (existing) ─────────────────────────────────
    ("who was alan turing", "knowledge_query", "encyclopedic"),
    ("what is langchain used for", "knowledge_query", "encyclopedic"),
    # ── WEATHER ─────────────────────────────────────────────────
    ("is it raining tomorrow", "get_weather", "weather"),
    ("will it be sunny friday", "get_weather", "weather"),
    # ── YOUTUBE — both get_video and get_youtube_channel are valid ─
    ("pull up the latest mkbhd video", "get_youtube_channel", "youtube"),
    # ── CURRENT MEDIA ───────────────────────────────────────────
    ("whats in theaters tonight", "get_movie_showtimes", "current_media"),
    ("whens avatar showing", "get_movie_showtimes", "current_media"),
    # ── PEOPLE LOOKUP ───────────────────────────────────────────
    ("whens my sisters birthday", "lookup_person_birthday", "people_lookup"),
    # ── CALENDAR ────────────────────────────────────────────────
    ("add dentist appointment next tuesday", "create_event", "calendar"),
    ("what events do i have next week", "get_events", "calendar"),
    ("reschedule my 3pm to 4", "update_event", "calendar"),
    # ── TIMER / REMINDER ────────────────────────────────────────
    ("set a 45 second timer", "set_timer", "timer_reminder"),
    ("remind me in an hour", "set_reminder", "timer_reminder"),
    ("wake me at 6:45", "set_alarm", "timer_reminder"),
    # ── NAVIGATION ──────────────────────────────────────────────
    ("how long to drive to san francisco", "get_eta", "navigation"),
    ("whats the closest pharmacy", "find_nearby", "navigation"),
    ("directions to the airport", "get_directions", "navigation"),
    # ── CONVERSION ──────────────────────────────────────────────
    ("how many cups in a liter", "convert_units", "conversion"),
    ("convert 30 miles to kilometers", "convert_units", "conversion"),
    # ── MESSAGING ───────────────────────────────────────────────
    ("text mom im running late", "send_text_message", "messaging"),
    ("phone my brother", "make_call", "messaging"),
    # ── MUSIC CONTROL ───────────────────────────────────────────
    ("play the morning playlist", "play_music", "music_control"),
    ("skip this track", "control_playback", "music_control"),
    ("pause the music", "control_playback", "music_control"),
    # ── NEWS ────────────────────────────────────────────────────
    ("whats in the news today", "get_news_headlines", "news"),
]


def _route(text: str, decomposition: RouteDecomposition | None = None) -> str:
    """Route one query and return the CANONICAL capability (alias-resolved)."""
    runtime = get_runtime()
    chunk = RequestChunk(text=text, index=0)
    match = route_chunk(chunk, runtime=runtime, decomposition=decomposition)
    # Aliases like "get_forecast" resolve to "get_weather" via the registry.
    # Tests compare canonical capabilities so alias labels don't look like misses.
    return runtime.resolve_capability(match.capability)


def _score_corpus(with_decomposer: bool) -> tuple[int, int, list[tuple[str, str, str]]]:
    """Route every corpus query and return (correct, total, misses).

    misses is a list of (query, expected, actual) tuples for diagnostics.
    """
    correct = 0
    misses: list[tuple[str, str, str]] = []
    for query, expected, need_hint in ROUTING_CORPUS:
        decomp = None
        if with_decomposer:
            decomp = RouteDecomposition(
                capability_need=need_hint,
                source="llm",  # authoritative — full boost
            )
        actual = _route(query, decomp)
        if actual == expected:
            correct += 1
        else:
            misses.append((query, expected, actual))
    return correct, len(ROUTING_CORPUS), misses


class TestRoutingCoverage(unittest.TestCase):
    """End-to-end routing accuracy."""

    def test_minilm_only_baseline_accuracy(self):
        """Baseline: MiniLM alone must correctly route at least 50% of held-out queries.

        This is a floor — not a ceiling. Regressions below 50% mean the
        corpus drifted or a capability lost examples. Intentional
        improvements should raise this floor.
        """
        correct, total, misses = _score_corpus(with_decomposer=False)
        accuracy = correct / total
        # Print diagnostics so pytest -v shows which queries mis-routed
        # when the test fails.
        print(f"\n[MiniLM-only] {correct}/{total} = {accuracy:.1%}")
        for query, expected, actual in misses:
            print(f"  MISS: '{query}' expected={expected} got={actual}")
        self.assertGreaterEqual(
            accuracy, 0.50,
            f"MiniLM-only accuracy {accuracy:.1%} below 50% floor",
        )

    def test_decomposer_prior_improves_accuracy(self):
        """With oracle decomposer, accuracy should meaningfully exceed baseline."""
        baseline_correct, total, _ = _score_corpus(with_decomposer=False)
        with_correct, _, misses = _score_corpus(with_decomposer=True)
        baseline_acc = baseline_correct / total
        with_acc = with_correct / total
        print(f"\n[With decomposer] {with_correct}/{total} = {with_acc:.1%}")
        print(f"[Improvement] +{(with_acc - baseline_acc):.1%} vs MiniLM-only")
        for query, expected, actual in misses:
            print(f"  MISS: '{query}' expected={expected} got={actual}")
        self.assertGreater(
            with_acc, baseline_acc,
            f"Decomposer prior ({with_acc:.1%}) did NOT improve over MiniLM baseline ({baseline_acc:.1%})",
        )

    def test_decomposer_prior_hits_floor(self):
        """With oracle decomposer, accuracy must clear 75% — this is what
        the integration is *for*."""
        correct, total, _ = _score_corpus(with_decomposer=True)
        accuracy = correct / total
        self.assertGreaterEqual(
            accuracy, 0.75,
            f"With-decomposer accuracy {accuracy:.1%} below 75% floor — "
            "registry corpus + decomposer boost insufficient",
        )

    def test_medical_queries_route_correctly_with_decomposer(self):
        """Medical queries route to *any* medical-aware handler.

        knowledge_query, look_up_symptom, and check_medication all now
        probe the medical ZIM archives (MDWiki/WikEM) first and fall
        back to MedlinePlus/RxNorm online — so any of them is a
        correct destination. MiniLM disambiguates between drug vs.
        symptom vs. general within the family on its own.
        """
        medical_handlers = {
            "knowledge_query", "look_up_symptom", "check_medication",
        }
        medical = [q for q in ROUTING_CORPUS if q[2] == "medical"]
        correct = 0
        misses: list[tuple[str, str]] = []
        for query, _expected, need_hint in medical:
            decomp = RouteDecomposition(capability_need=need_hint, source="llm")
            actual = _route(query, decomp)
            if actual in medical_handlers:
                correct += 1
            else:
                misses.append((query, actual))
        accuracy = correct / len(medical) if medical else 1.0
        print(f"\n[Medical with decomposer] {correct}/{len(medical)} = {accuracy:.1%}")
        for query, actual in misses:
            print(f"  MISS: '{query}' routed to non-medical handler: {actual}")
        self.assertGreaterEqual(
            accuracy, 0.80,
            f"Medical routing {accuracy:.1%} below 80% floor",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
