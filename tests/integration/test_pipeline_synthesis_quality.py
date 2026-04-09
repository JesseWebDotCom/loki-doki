"""End-to-end "does the synthesizer get good data?" tests.

The unit tests in ``tests/unit/test_skill_*.py`` verify each skill
returns a usable ``data["lead"]`` and well-shaped fields. They CANNOT
catch the failure mode we hit on 2026-04-08, where the Fandango skill
returned ``snippet="Now playing"`` on every list entry and the 9B
synthesizer dutifully echoed ``"Now playing Now playing Now playing"``
into the user's chat. The bug lived in the *contract* between the
skill's payload shape and the synthesizer prompt assembly — every unit
was structurally green, but the prompt the LLM saw was full of
duplicated noise.

These tests stub the inference client so we never hit a real LLM, but
they DO run the orchestrator through ``build_synthesis_prompt`` and
capture the exact prompt string that would have been streamed. We
assert on prompt content:

  * the actual movie titles / weather temps / wiki extracts are present
    in ``SKILL_DATA`` (not just shapes), so the LLM has something real
    to work with.
  * known noise patterns ("Now playing Now playing Now playing", repeated
    placeholders, the user's literal query echoed verbatim) do NOT appear.
  * a structured field is present in JSON form so the LLM can parse data
    out of the payload itself rather than relying on a single ``lead``.

Why the LLM-parsing point matters: ``SKILL_DATA`` ships
``json.dumps(result.data)`` to the synthesizer, so the model sees the
full structured payload (titles array, runtimes, addresses) — not just
the one ``lead`` line. The lead exists for the *verbatim fast-path*
that bypasses synthesis entirely; for synthesized turns the LLM is
free to extract whatever field it needs from the JSON. These tests
verify both halves of that contract.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from lokidoki.core import skill_factory
from lokidoki.core import memory_people_ops  # noqa: F401 — installs MemoryProvider.list_people
from lokidoki.core.decomposer import Ask, DecompositionResult
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator import Orchestrator
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor


# ---------- HTML / API fixtures (recorded shapes) ---------------------------

# Realistic Fandango ZIP page: anchors of the form
# /<slug>-<id>/movie-overview with the human title as anchor text.
# Mirrors what fandango.com/<ZIP>_movietimes returns today.
FANDANGO_ZIP_HTML = """
<html><body>
  <a href="/hoppers-2026-241416/movie-overview">Hoppers (2026)</a>
  <a href="/the-super-mario-galaxy-movie-2026-242307/movie-overview">The Super Mario Galaxy Movie (2026)</a>
  <a href="/avatar-fire-and-ash-2026-241099/movie-overview">Avatar: Fire and Ash (2026)</a>
</body></html>
"""

WIKI_DANNY_OK = {
    "query": {
        "search": [{"title": "Danny McBride"}],
        "pages": {"12345": {
            "pageid": 12345, "title": "Danny McBride",
            "extract": "Daniel Richard McBride is an American actor and comedian.",
        }},
    }
}


# ---------- harness ---------------------------------------------------------

class _PromptCapture:
    """Inference stub that records every prompt passed to ``generate_stream``.

    The orchestrator streams tokens out, so we yield a single placeholder
    token to satisfy the contract and stash the prompt for assertions.
    """

    def __init__(self) -> None:
        self.prompts: list[str] = []

    def stream(self, *args, **kwargs):
        prompt = kwargs.get("prompt") or (args[1] if len(args) > 1 else "")
        self.prompts.append(prompt)

        async def _gen():
            yield "ok"

        return _gen()


def _build_orchestrator(
    decomp: DecompositionResult,
    registry: SkillRegistry,
    memory: MemoryProvider,
) -> tuple[Orchestrator, _PromptCapture]:
    capture = _PromptCapture()
    mock_decomposer = AsyncMock()
    mock_decomposer.decompose = AsyncMock(return_value=decomp)
    mock_inference = AsyncMock()
    mock_inference.generate_stream = capture.stream
    orch = Orchestrator(
        decomposer=mock_decomposer,
        inference_client=mock_inference,
        memory=memory,
        model_manager=ModelManager(
            inference_client=mock_inference,
            policy=ModelPolicy(platform="mac"),
        ),
        registry=registry,
        skill_executor=SkillExecutor(),
    )
    return orch, capture


def _synthesis_prompt(capture: _PromptCapture) -> str:
    """Find the synthesis prompt (long, has SKILL_DATA) among captured prompts.

    The orchestrator may invoke the inference client multiple times per
    turn (auto-naming the session, repair loops, etc.). The synthesis
    call is identifiable by the ``SKILL_DATA:`` marker the synthesis
    template emits.
    """
    matches = [p for p in capture.prompts if "SKILL_DATA:" in p]
    assert matches, f"no synthesis prompt captured (got {len(capture.prompts)} prompts)"
    return matches[-1]


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "synth.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.fixture(autouse=True)
def _reset_skill_singletons():
    skill_factory.reset_instances()
    yield
    skill_factory.reset_instances()


def _mk_html_response(text: str, status: int = 200) -> MagicMock:
    response = MagicMock()
    response.status_code = status
    response.text = text
    return response


# ---------- tests -----------------------------------------------------------

async def _seed_fandango_zip(memory: MemoryProvider, uid: int) -> None:
    """Persist the user's default ZIP so the Fandango skill can build a URL."""
    def _do(c):
        c.execute(
            "INSERT OR REPLACE INTO skill_config_user (user_id, skill_id, key, value) "
            "VALUES (?, ?, ?, ?)",
            (uid, "movies_fandango", "default_zip", "06461"),
        )
        c.commit()
    await memory.run_sync(_do)


def _patch_fandango_html(html: str):
    """Patch ``httpx.AsyncClient`` so the Fandango skill sees ``html``."""
    client = MagicMock()
    client.get = AsyncMock(return_value=_mk_html_response(html))
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=client)
    cm.__aexit__ = AsyncMock(return_value=None)
    return patch("httpx.AsyncClient", return_value=cm)


async def _drain(orch: Orchestrator, query: str, uid: int, sid: int) -> list:
    events = []
    async for event in orch.process(query, user_id=uid, session_id=sid):
        events.append(event)
    return events


@pytest.mark.anyio
async def test_fandango_open_ended_fast_path_response_is_clean(memory):
    """Regression for the 'Now playing Now playing Now playing' bug.

    Open-ended ask (no referent anchor) → grounded fast path fires →
    the user sees ``data["lead"]`` verbatim. Verifies that lead:

      * names multiple real movie titles
      * does NOT contain duplicated 'now playing' phrases (the noise
        signature the synthesizer used to amplify when the field was
        repeated per list entry)
      * carries the [src:1] citation marker so the UI shows a source pill
    """
    registry = SkillRegistry()
    registry.scan()
    assert "movies_fandango" in registry.skills

    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    await _seed_fandango_zip(memory, uid)

    decomp = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        asks=[Ask(
            ask_id="ask_001",
            intent="direct_chat",
            distilled_query="movies playing nearby",
            parameters={},
            response_shape="synthesized",
            requires_current_data=True,
            knowledge_source="web",
            capability_need="current_media",
            referent_type="media",
            referent_scope=["media"],
            referent_anchor="",  # open-ended → fast path
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )

    orch, capture = _build_orchestrator(decomp, registry, memory)
    with _patch_fandango_html(FANDANGO_ZIP_HTML):
        events = await _drain(orch, "what movies are playing by me", uid, sid)

    synth_done = [e for e in events if e.phase == "synthesis" and e.status == "done"]
    assert synth_done, "synthesis phase never completed"
    response = synth_done[0].data["response"]

    # Real titles, no duplicated noise, citation marker present.
    assert "Hoppers (2026)" in response
    assert "Avatar: Fire and Ash (2026)" in response
    assert "The Super Mario Galaxy Movie (2026)" in response
    nowplaying = response.lower().count("now playing")
    assert nowplaying == 1, (
        f"'now playing' appears {nowplaying} times in response — "
        f"duplicated noise. Response: {response!r}"
    )
    assert "[src:1]" in response, "citation marker missing from fast-path response"

    # Fast-path was the actual code path (we did NOT call the LLM).
    assert synth_done[0].data.get("fast_path") is True
    assert synth_done[0].data.get("grounded_fast_path") is True
    assert len(capture.prompts) == 0, (
        f"open-ended fast-path should NOT call the LLM, got "
        f"{len(capture.prompts)} prompts"
    )


@pytest.mark.anyio
async def test_fandango_anchored_query_routes_through_synthesizer(memory):
    """When the user names a SPECIFIC movie ('is Hoppers playing?'),
    the orchestrator should bypass the grounded fast path and let the
    LLM filter the listing. This is the 'leverage the LLM to parse data
    out of SKILL_DATA' contract — we don't want a one-size-fits-all
    lead dump when the user is asking about one title in particular.

    Asserts:
      * the LLM was actually invoked (prompt captured)
      * SKILL_DATA contains the full structured listing as JSON, so
        the LLM can find Hoppers without us pre-filtering
      * the noise signature ('now playing now playing') is absent
      * the [src:1] marker is in the prompt for the LLM to copy
    """
    registry = SkillRegistry()
    registry.scan()

    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)
    await _seed_fandango_zip(memory, uid)

    decomp = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        asks=[Ask(
            ask_id="ask_001",
            intent="direct_chat",
            distilled_query="is Hoppers playing",
            parameters={},
            response_shape="synthesized",
            requires_current_data=True,
            knowledge_source="web",
            capability_need="current_media",
            referent_type="media",
            referent_scope=["media"],
            referent_anchor="Hoppers",  # anchored → synthesis path
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )

    orch, capture = _build_orchestrator(decomp, registry, memory)
    with _patch_fandango_html(FANDANGO_ZIP_HTML):
        events = await _drain(orch, "is Hoppers playing", uid, sid)

    synth_done = [e for e in events if e.phase == "synthesis" and e.status == "done"]
    assert synth_done
    # Anchored ask must NOT take the fast path.
    assert synth_done[0].data.get("fast_path") is not True
    assert synth_done[0].data["model"] != "fast_path"

    prompt = _synthesis_prompt(capture)

    # The LLM must see the actual movie titles AND the slug-bearing
    # JSON payload so it can parse out Hoppers without us pre-filtering.
    assert "Hoppers (2026)" in prompt
    assert "Avatar: Fire and Ash (2026)" in prompt
    assert "hoppers-2026-241416" in prompt, "slug missing from JSON payload"
    assert '"showtimes"' in prompt, "structured listing array missing"

    # No duplicated 'now playing' noise.
    assert "now playing now playing" not in prompt.lower()
    nowplaying = prompt.lower().count("now playing")
    assert nowplaying <= 2, (
        f"'now playing' duplicated {nowplaying}x in prompt"
    )
    # NOTE: ``[src:N]`` markers are stripped by ``compress_text`` before
    # the prompt assembly (compression.py treats them as noise). The
    # citation reaches the user via the ``sources`` event payload, not
    # via the synthesis prompt itself — so we don't assert it here.


@pytest.mark.anyio
async def test_wiki_synthesis_prompt_has_extract_text(memory):
    """The synthesizer must see the actual Wikipedia extract, not just
    a title field. Without the extract in SKILL_DATA the model has
    nothing to ground on and either makes things up or refuses."""
    registry = SkillRegistry()
    registry.scan()

    decomp = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        asks=[Ask(
            ask_id="ask_001",
            intent="knowledge_wiki.search_knowledge",
            distilled_query="Danny McBride",
            parameters={},
            response_shape="synthesized",
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )

    orch, capture = _build_orchestrator(decomp, registry, memory)
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = WIKI_DANNY_OK

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=mock_response):
        async for _ in orch.process(
            "Tell me about Danny McBride", user_id=uid, session_id=sid
        ):
            pass

    prompt = _synthesis_prompt(capture)
    assert "Danny McBride" in prompt
    # The extract is the load-bearing field — must be in the prompt
    # verbatim so the LLM can parse "actor and comedian" out of it.
    assert "American actor and comedian" in prompt, (
        "wiki extract missing from synthesis prompt — model has nothing to ground on"
    )


@pytest.mark.anyio
async def test_grounded_ask_emits_source_payload(memory):
    """Every successful grounded ask must surface a ``sources`` entry on
    the routing event so the frontend renders a clickable source pill,
    even though the literal ``[src:N]`` marker gets stripped from the
    synthesis prompt during caveman compression. The source URL + title
    flow through the routing payload, not the prompt text.
    """
    registry = SkillRegistry()
    registry.scan()

    decomp = DecompositionResult(
        is_course_correction=False,
        overall_reasoning_complexity="fast",
        asks=[Ask(
            ask_id="ask_001",
            intent="knowledge_wiki.search_knowledge",
            distilled_query="Danny McBride",
            parameters={},
            response_shape="synthesized",
        )],
        model="gemma4:e2b",
        latency_ms=10.0,
    )

    orch, capture = _build_orchestrator(decomp, registry, memory)
    uid = await memory.get_or_create_user("default")
    sid = await memory.create_session(uid)

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = WIKI_DANNY_OK

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=mock_response):
        events = await _drain(orch, "Who is Danny McBride", uid, sid)

    synth_done = [e for e in events if e.phase == "synthesis" and e.status == "done"]
    assert synth_done
    sources = synth_done[0].data.get("sources") or []
    assert sources, "no sources surfaced on synthesis payload"
    assert any("wikipedia" in (s.get("url") or "").lower() for s in sources), (
        f"wikipedia source missing from sources payload: {sources}"
    )
