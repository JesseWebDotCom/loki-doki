from __future__ import annotations

import asyncio
import statistics
import time
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from lokidoki.auth.dependencies import current_user, get_memory
from lokidoki.auth.users import User
from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.humanization_planner import (
    HumanizationPlan,
    get_global_humanization_hook_cache,
    plan_humanization,
)
from lokidoki.main import app


@pytest.fixture(autouse=True)
async def _isolated_memory(tmp_path):
    from lokidoki.core.memory_provider import MemoryProvider

    mp = MemoryProvider(db_path=str(tmp_path / "phase3_humanization.db"))
    await mp.initialize()
    uid = await mp.get_or_create_user("tester")

    fake_user = User(
        id=uid,
        username="tester",
        role="admin",
        status="active",
        last_password_auth_at=None,
    )

    async def _override_user():
        return fake_user

    async def _override_memory():
        return mp

    app.dependency_overrides[current_user] = _override_user
    app.dependency_overrides[get_memory] = _override_memory
    yield {"memory": mp, "user_id": uid}
    app.dependency_overrides.clear()
    await mp.close()


class _FakeDecomposer:
    def __init__(self, *args, **kwargs):
        self._num_ctx = 8192

    async def decompose(self, user_input: str, **kwargs):
        sentiment = "neutral"
        if "rough" in user_input.lower():
            sentiment = "sad"
        if user_input.lower().startswith("i like "):
            return DecompositionResult(
                overall_reasoning_complexity="fast",
                short_term_memory={"sentiment": sentiment, "concern": ""},
                long_term_memory=[{
                    "subject_type": "self",
                    "predicate": "like",
                    "value": user_input[7:],
                    "kind": "preference",
                    "category": "preference",
                }],
                asks=[Ask(ask_id="ask_ack", intent="direct_chat", distilled_query=user_input)],
                model="gemma4:e2b",
                latency_ms=1.0,
            )
        return DecompositionResult(
            overall_reasoning_complexity="fast",
            short_term_memory={"sentiment": sentiment, "concern": ""},
            asks=[Ask(ask_id="ask_full", intent="direct_chat", distilled_query=user_input)],
            model="gemma4:e2b",
            latency_ms=1.0,
        )


def _prompt_value(prompt: str, label: str) -> str:
    needle = f"{label}:"
    for line in prompt.splitlines():
        if line.startswith(needle):
            return line[len(needle):].strip()
    return ""


class _PlannerAwareInferenceClient:
    async def generate(self, *args, **kwargs):
        return "Session Title"

    def generate_stream(self, *args, **kwargs):
        prompt = kwargs.get("prompt", "")
        blocked = {piece.strip().lower() for piece in _prompt_value(prompt, "OPENER_BLOCKLIST").split("|") if piece.strip()}
        opener_candidates = ["Sounds good", "Happy to", "Let me think"]
        opener = next((cand for cand in opener_candidates if cand.lower() not in blocked), opener_candidates[-1])
        hook = _prompt_value(prompt, "PERSONALIZATION_HOOK")
        followup_slot = _prompt_value(prompt, "FOLLOWUP_SLOT")
        empathy = _prompt_value(prompt, "EMPATHY_OPENER")

        if hook and hook != "none":
            response = f"{opener}, here's the answer. I remember {hook}."
        elif empathy and empathy != "none":
            response = f"{empathy} Here's the answer."
        else:
            response = f"{opener}, here's the answer."

        if followup_slot.endswith("after_answer"):
            response = f"{response} Want another option?"

        async def _gen():
            await asyncio.sleep(0.005)
            yield response

        return _gen()

    async def close(self):
        return None


class _SlowPlannerAwareInferenceClient(_PlannerAwareInferenceClient):
    def generate_stream(self, *args, **kwargs):
        prompt = kwargs.get("prompt", "")
        base = super().generate_stream(*args, **kwargs)

        async def _gen():
            await asyncio.sleep(0.01)
            async for chunk in base:
                await asyncio.sleep(0.005)
                yield chunk

        return _gen()


def _parse_sse_events(body: str) -> list[dict]:
    import json

    events = []
    for line in body.strip().split("\n"):
        line = line.strip()
        if line.startswith("data: "):
            events.append(json.loads(line[6:]))
    return events


async def _chat(ac: AsyncClient, message: str, session_id: int | None = None) -> list[dict]:
    payload = {"message": message}
    if session_id is not None:
        payload["session_id"] = session_id
    response = await ac.post("/api/v1/chat", json=payload)
    assert response.status_code == 200
    return _parse_sse_events(response.text)


@pytest.mark.anyio
async def test_phase3_chat_path_avoids_repeated_openers_over_three_turns(_isolated_memory):
    with (
        patch("lokidoki.api.routes.chat.Decomposer", _FakeDecomposer),
        patch("lokidoki.api.routes.chat.get_inference_client", return_value=_PlannerAwareInferenceClient()),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            first = await _chat(ac, "recommend a movie")
            session_id = next(e["data"]["session_id"] for e in first if e["phase"] == "session")
            second = await _chat(ac, "recommend a show", session_id=session_id)
            third = await _chat(ac, "recommend a game", session_id=session_id)

    responses = []
    for events in (first, second, third):
        done = next(e for e in events if e["phase"] == "synthesis" and e["status"] == "done")
        responses.append(done["data"]["response"])

    openers = [response.split(",", 1)[0] for response in responses]
    assert len(set(openers)) == 3


@pytest.mark.anyio
async def test_phase3_chat_path_avoids_repeated_personalization_hook_over_three_turns(_isolated_memory):
    hook_cache = get_global_humanization_hook_cache()
    session_id = await _isolated_memory["memory"].create_session(_isolated_memory["user_id"])
    hook_cache.clear(session_id)

    selected = {
        "facts_by_bucket": {
            "working_context": [
                {"id": 1, "subject": "self", "subject_type": "self", "predicate": "love", "value": "coffee"},
                {"id": 2, "subject": "self", "subject_type": "self", "predicate": "like", "value": "movies"},
                {"id": 3, "subject": "self", "subject_type": "self", "predicate": "enjoy", "value": "hiking"},
            ],
            "semantic_profile": [],
            "relational_graph": [],
            "episodic_threads": [],
        },
        "past_messages": [],
    }

    with (
        patch("lokidoki.api.routes.chat.Decomposer", _FakeDecomposer),
        patch("lokidoki.api.routes.chat.get_inference_client", return_value=_PlannerAwareInferenceClient()),
        patch("lokidoki.core.orchestrator.select_memory_context", return_value=selected),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            first = await _chat(ac, "tell me something", session_id=session_id)
            second = await _chat(ac, "tell me something else", session_id=session_id)
            third = await _chat(ac, "one more thing", session_id=session_id)

    responses = [
        next(e for e in events if e["phase"] == "synthesis" and e["status"] == "done")["data"]["response"]
        for events in (first, second, third)
    ]

    assert "you love coffee" in responses[0].lower()
    assert "you like movies" in responses[1].lower()
    assert "you enjoy hiking" in responses[2].lower()
    assert hook_cache.get(session_id) == ["fact:1", "fact:2", "fact:3"]
    hook_cache.clear(session_id)


@pytest.mark.anyio
async def test_phase3_followup_appears_only_after_answer_on_chat_path(_isolated_memory):
    with (
        patch("lokidoki.api.routes.chat.Decomposer", _FakeDecomposer),
        patch("lokidoki.api.routes.chat.get_inference_client", return_value=_PlannerAwareInferenceClient()),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            events = await _chat(ac, "recommend a movie")

    response = next(e for e in events if e["phase"] == "synthesis" and e["status"] == "done")["data"]["response"]
    assert "here's the answer" in response.lower()
    assert response.rstrip().endswith("Want another option?")
    assert response.index("?") > response.lower().index("answer")


@pytest.mark.anyio
async def test_phase3_planner_latency_stays_close_to_control_on_chat_path(_isolated_memory):
    transport = ASGITransport(app=app)
    durations_with_planner = []
    durations_control = []

    async def _run_batch(target: list[float], plan_patch):
        with (
            patch("lokidoki.api.routes.chat.Decomposer", _FakeDecomposer),
            patch("lokidoki.api.routes.chat.get_inference_client", return_value=_SlowPlannerAwareInferenceClient()),
            patch("lokidoki.core.orchestrator.plan_humanization", plan_patch),
        ):
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                for _ in range(4):
                    start = time.perf_counter()
                    response = await ac.post("/api/v1/chat", json={"message": "recommend a movie"})
                    assert response.status_code == 200
                    target.append((time.perf_counter() - start) * 1000)

    await _run_batch(durations_with_planner, plan_humanization)
    await _run_batch(
        durations_control,
        lambda **kwargs: HumanizationPlan(),
    )

    assert statistics.median(durations_with_planner) - statistics.median(durations_control) < 8.0
