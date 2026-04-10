from lokidoki.core.humanize import format_memory_block
from lokidoki.core.orchestrator_skills import build_synthesis_prompt
from lokidoki.core.prompt_budget import enforce_prompt_budget
from lokidoki.core.orchestrator import DEFAULT_SYNTHESIS_NUM_CTX, Orchestrator


def _fact(i: int, score: float) -> dict:
    return {
        "id": i,
        "subject": "self",
        "subject_type": "self",
        "predicate": "likes",
        "value": f"very long preference detail number {i} " * 8,
        "created_at": "2026-04-01 12:00:00",
        "score": score,
    }


def _message(i: int) -> dict:
    return {
        "id": i,
        "content": f"older session callback {i} " * 14,
        "created_at": "2026-04-01 12:00:00",
    }


def _build_prompt(*, facts, messages, skill_data, clarify_hint="keep this question", referent_block="RELATIONSHIPS:\n- brother: Artie"):
    return build_synthesis_prompt(
        tone="friendly",
        context="recent turn context",
        skill_data=skill_data,
        query="what should I know right now",
        clarify_hint=clarify_hint,
        wake_up_context="WAKE_UP_CONTEXT:\n- key fact: you likes coffee",
        memory_block=format_memory_block(facts=facts, past_messages=messages),
        referent_block=referent_block,
        character_name="Loki",
    )


def test_prompt_budget_truncates_facts_then_messages_then_skill_detail():
    facts = [_fact(1, 0.9), _fact(2, 0.4), _fact(3, 0.1)]
    messages = [_message(1), _message(2)]
    skill_data = (
        '[src:1] {"lead":"headline","details":"'
        + ("extra detail " * 200)
        + '"}'
    )

    prompt, meta = enforce_prompt_budget(
        build_prompt=_build_prompt,
        facts=facts,
        past_messages=messages,
        skill_data=skill_data,
        num_ctx=1000,
        budget_ratio=0.8,
    )

    assert meta["truncated"] is True
    assert meta["dropped_fact_ids"] == [3, 2, 1]
    assert meta["dropped_message_ids"] == [2, 1]
    assert meta["skill_data_trimmed"] is True
    assert meta["estimated_tokens"] <= meta["max_tokens"]
    assert "keep this question" in prompt
    assert "WAKE_UP_CONTEXT:" in prompt
    assert "[src:1]" in prompt


def test_prompt_budget_keeps_best_scoring_fact_longest():
    facts = [_fact(1, 0.9), _fact(2, 0.3), _fact(3, 0.1)]
    messages = []
    skill_data = '[src:1] {"lead":"brief"}'

    prompt, meta = enforce_prompt_budget(
        build_prompt=_build_prompt,
        facts=facts,
        past_messages=messages,
        skill_data=skill_data,
        num_ctx=900,
        budget_ratio=0.8,
    )

    assert meta["dropped_fact_ids"][:2] == [3, 2]
    assert "preference detail number 1" in prompt


def test_orchestrator_has_independent_synthesis_context_default():
    orch = Orchestrator(
        decomposer=object(),  # type: ignore[arg-type]
        inference_client=object(),  # type: ignore[arg-type]
        memory=object(),  # type: ignore[arg-type]
    )

    assert orch._synthesis_num_ctx == DEFAULT_SYNTHESIS_NUM_CTX
