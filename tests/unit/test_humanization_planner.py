from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.humanization_planner import (
    HumanizationPlan,
    get_global_humanization_hook_cache,
    note_hook_if_used,
    plan_humanization,
)
from lokidoki.core.response_spec import ResponseSpec


def _spec(reply_mode: str, *, followup_policy: str = "after_answer", memory_mode: str = "full") -> ResponseSpec:
    return ResponseSpec(
        reply_mode=reply_mode,
        memory_mode=memory_mode,
        grounding_mode="optional",
        followup_policy=followup_policy,
        style_mode="default",
        citation_policy="optional",
    )


def test_planner_adds_empathy_for_sad_turns():
    decomp = DecompositionResult(
        short_term_memory={"sentiment": "sad", "concern": "job loss"},
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="I had a rough day")],
    )

    plan = plan_humanization(
        user_input="I had a rough day",
        decomposition=decomp,
        response_spec=_spec("full_synthesis"),
        facts_by_bucket={},
        recent_hooks=[],
        recent_assistant_messages=[],
    )

    assert plan.empathy_opener == "I'm sorry you're dealing with that."
    assert plan.followup_slot == "optional_after_answer"
    assert plan.answer_first is True


def test_planner_stays_plain_for_neutral_grounded_turns():
    decomp = DecompositionResult(
        short_term_memory={"sentiment": "neutral", "concern": ""},
        asks=[Ask(
            ask_id="ask_1",
            intent="direct_chat",
            distilled_query="what time is it",
            requires_current_data=True,
        )],
    )

    plan = plan_humanization(
        user_input="what time is it right now",
        decomposition=decomp,
        response_spec=_spec("grounded_direct", followup_policy="none", memory_mode="minimal"),
        facts_by_bucket={},
        recent_hooks=[],
        recent_assistant_messages=["Got it. Here's the answer."],
    )

    assert plan.empathy_opener == ""
    assert plan.personalization_hook == ""
    assert plan.followup_slot == "none"
    assert "got it" in plan.blocked_openers


def test_planner_skips_current_turn_fact_when_picking_hook():
    decomp = DecompositionResult(
        short_term_memory={"sentiment": "neutral", "concern": ""},
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="I like hiking")],
    )

    plan = plan_humanization(
        user_input="I like hiking",
        decomposition=decomp,
        response_spec=_spec("social_ack", memory_mode="sparse"),
        facts_by_bucket={
            "working_context": [
                {"id": 1, "subject": "self", "subject_type": "self", "predicate": "like", "value": "hiking"},
                {"id": 2, "subject": "self", "subject_type": "self", "predicate": "love", "value": "coffee"},
            ]
        },
        recent_hooks=[],
        recent_assistant_messages=[],
    )

    assert plan.personalization_hook == "you love coffee"
    assert plan.personalization_hook_key == "fact:2"
    assert plan.followup_slot == "optional_after_answer"


def test_planner_recommendation_turn_keeps_answer_first_rules():
    decomp = DecompositionResult(
        short_term_memory={"sentiment": "neutral", "concern": ""},
        asks=[Ask(ask_id="ask_1", intent="direct_chat", distilled_query="recommend a movie")],
    )

    plan = plan_humanization(
        user_input="recommend a movie",
        decomposition=decomp,
        response_spec=_spec("full_synthesis"),
        facts_by_bucket={},
        recent_hooks=[],
        recent_assistant_messages=[],
    )

    rendered = plan.render_for_prompt()
    assert plan.followup_slot == "optional_after_answer"
    assert "ANSWER_FIRST:required" in rendered
    assert "FOLLOWUP_RULE:" in rendered
    assert "MEMORY_RULE:" in rendered


def test_recent_hooks_keep_only_last_three_used_hooks():
    cache = get_global_humanization_hook_cache()
    session_id = 99123
    cache.clear(session_id)

    for idx, phrase in enumerate(("coffee", "movies", "hiking", "bread"), start=1):
        note_hook_if_used(
            cache=cache,
            session_id=session_id,
            response=f"We can work with your {phrase} habit.",
            plan=HumanizationPlan(
                personalization_hook=f"you like {phrase}",
                personalization_hook_key=f"fact:{idx}",
            ),
        )

    assert cache.get(session_id) == ["fact:2", "fact:3", "fact:4"]
    cache.clear(session_id)
