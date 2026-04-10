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
