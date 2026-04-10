from lokidoki.evals.phase0 import EVAL_RUBRIC, load_phase0_eval_corpus


def test_phase0_eval_corpus_loads_expected_categories():
    corpus = load_phase0_eval_corpus()

    categories = {case["category"] for case in corpus}
    assert len(corpus) >= 8
    assert {
        "greeting",
        "fact_sharing",
        "emotional",
        "relationship",
        "current_data",
        "recommendation",
        "pronoun_followup",
        "correction",
    }.issubset(categories)


def test_phase0_eval_rubric_covers_baseline_scoring_dimensions():
    assert EVAL_RUBRIC["answer_first_behavior"]
    assert EVAL_RUBRIC["non_echo_behavior"]
    assert EVAL_RUBRIC["memory_relevance"]
    assert EVAL_RUBRIC["repetition"]
    assert EVAL_RUBRIC["grounding_freshness"]
    assert EVAL_RUBRIC["latency"]
