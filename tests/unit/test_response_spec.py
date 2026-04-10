from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.response_spec import plan_response_spec


def test_shadow_response_spec_prefers_social_ack_for_short_fact_turn():
    decomp = DecompositionResult(
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="I like hiking")],
    )

    spec = plan_response_spec(
        user_input="I like hiking",
        decomposition=decomp,
        write_reports=[{"action": "created", "fact_id": 1}],
        resolved_asks=decomp.asks,
    )

    assert spec.reply_mode == "social_ack"


def test_shadow_response_spec_prefers_grounded_direct_for_current_data_turn():
    ask = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="who is the president",
        requires_current_data=True,
    )
    decomp = DecompositionResult(asks=[ask])

    spec = plan_response_spec(
        user_input="who is the president right now",
        decomposition=decomp,
        write_reports=[],
        resolved_asks=[ask],
    )

    assert spec.reply_mode == "grounded_direct"


def test_response_spec_marks_referent_only_memory_for_grounded_direct_turns():
    ask = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="is it still playing near me",
        requires_current_data=True,
        needs_referent_resolution=True,
    )
    decomp = DecompositionResult(asks=[ask])

    spec = plan_response_spec(
        user_input="is it still playing near me",
        decomposition=decomp,
        write_reports=[],
        resolved_asks=[ask],
    )

    assert spec.reply_mode == "grounded_direct"
    assert spec.memory_mode == "referent_only"
    assert spec.grounding_mode == "required"
    assert spec.followup_policy == "none"
    assert spec.citation_policy == "required"


def test_response_spec_prefers_full_synthesis_for_mixed_reasoning_turn():
    grounded = Ask(
        ask_id="ask_1",
        intent="direct_chat",
        distilled_query="who is the president",
        requires_current_data=True,
    )
    reflective = Ask(
        ask_id="ask_2",
        intent="direct_chat",
        distilled_query="and what do you think that means for the next election",
    )
    decomp = DecompositionResult(asks=[grounded, reflective])

    spec = plan_response_spec(
        user_input="who is the president right now and what do you think that means for the next election",
        decomposition=decomp,
        write_reports=[],
        resolved_asks=[grounded, reflective],
    )

    assert spec.reply_mode == "full_synthesis"
    assert spec.memory_mode == "full"
    assert spec.followup_policy == "after_answer"
    assert spec.style_mode == "default"
