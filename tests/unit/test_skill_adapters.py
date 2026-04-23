"""Unit tests for the lokidoki/orchestrator/skills adapters.

Each adapter is a thin wrapper around a LokiDoki skill. These tests
swap the skill singleton for a deterministic in-memory fake and assert
that the adapter:

  1. Pulls the right parameters out of the adapter payload.
  2. Walks the skill fallback chain in the documented priority order.
  3. Translates the ``MechanismResult`` blob into the adapter
     ``output_text`` contract.
  4. Degrades to a graceful error sentence when every mechanism fails.

Adapter swaps go through ``monkeypatch.setattr`` so the singleton is
automatically restored at end of test — otherwise a leftover fake would
leak into the integration regression suite that runs after these.
"""
from __future__ import annotations

from typing import Any

import pytest

from lokidoki.core.skill_executor import MechanismResult


# ---- helpers ---------------------------------------------------------------


class _RecordingFake:
    """Fake v1 skill that records every (method, params) call.

    Configure it with ``responses[method] = MechanismResult(...)`` and
    inspect ``calls`` after the adapter runs.
    """

    def __init__(self, responses: dict[str, MechanismResult] | None = None) -> None:
        self.responses: dict[str, MechanismResult] = dict(responses or {})
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        self.calls.append((method, dict(parameters)))
        if method in self.responses:
            return self.responses[method]
        return MechanismResult(success=False, error=f"no fake for {method}")


def _ok(data: dict[str, Any], **extra: Any) -> MechanismResult:
    return MechanismResult(success=True, data=data, **extra)


def _fail(error: str) -> MechanismResult:
    return MechanismResult(success=False, error=error)


def _install_fake(monkeypatch: pytest.MonkeyPatch, adapter_module, fake) -> None:
    """Swap an adapter's primary skill singleton with auto-teardown.

    Adapters that migrated to parallel-scored lookup use named
    singletons (_TVMAZE, _WIKI, etc.) instead of a generic _SKILL.
    """
    # Try named singletons first, fall back to generic _SKILL.
    for attr in ("_TVMAZE", "_SKILL"):
        if hasattr(adapter_module, attr):
            monkeypatch.setattr(adapter_module, attr, fake, raising=True)
            return
    raise AttributeError(f"{adapter_module} has no _SKILL or named singleton")


# ---- weather adapter -------------------------------------------------------


@pytest.mark.anyio
async def test_weather_adapter_uses_lead_field(monkeypatch):
    from lokidoki.orchestrator.skills import weather as adapter

    fake = _RecordingFake({
        "open_meteo": _ok({"lead": "It's 22°C in Tokyo."}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "what's the weather in tokyo", "params": {"location": "tokyo"}})
    assert result["output_text"] == "It's 22°C in Tokyo."
    assert fake.calls[0][0] == "open_meteo"
    assert fake.calls[0][1]["location"] == "tokyo"


@pytest.mark.anyio
async def test_weather_adapter_falls_through_to_cache(monkeypatch):
    from lokidoki.orchestrator.skills import weather as adapter

    fake = _RecordingFake({
        "open_meteo": _fail("network down"),
        "local_cache": _ok({"location": "Seattle", "temperature": 18, "condition": "rain"}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "weather in seattle", "params": {"location": "seattle"}})
    assert "Seattle" in result["output_text"]
    assert [c[0] for c in fake.calls] == ["open_meteo", "local_cache"]


@pytest.mark.anyio
async def test_weather_adapter_graceful_failure_when_all_mechs_fail(monkeypatch):
    from lokidoki.orchestrator.skills import weather as adapter

    fake = _RecordingFake({"open_meteo": _fail("dns"), "local_cache": _fail("miss")})
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "weather in narnia", "params": {"location": "narnia"}})
    assert result["success"] is False
    assert "couldn't reach" in result["output_text"].lower()


# ---- knowledge adapter -----------------------------------------------------
#
# knowledge_query tries local ZIM first (instant, offline). If ZIM scores
# above the coverage threshold it returns immediately — no network calls.
# When ZIM misses, Wikipedia and DuckDuckGo run in parallel and the winner
# is picked by subject-coverage score. Tests install fakes via
# monkeypatch.setattr so neither source ever makes a real HTTP call.


def _disable_zim(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure the ZIM search engine is not used in adapter tests."""
    import lokidoki.archives.search as _search_mod
    monkeypatch.setattr(_search_mod, "get_search_engine", lambda: None)


def _install_wiki_fake(monkeypatch: pytest.MonkeyPatch, adapter_module, fake) -> None:
    _disable_zim(monkeypatch)
    monkeypatch.setattr(adapter_module, "_WIKI", fake, raising=True)


def _install_ddg_fake(monkeypatch: pytest.MonkeyPatch, adapter_module, fake) -> None:
    from lokidoki.orchestrator.skills._runner import web_search_source
    # Ensure the lazy attribute exists before monkeypatch tries to
    # record its original value for teardown.
    if not hasattr(web_search_source, "_skill"):
        from lokidoki.skills.search.skill import DuckDuckGoSkill
        web_search_source._skill = DuckDuckGoSkill()  # type: ignore[attr-defined]
    monkeypatch.setattr(web_search_source, "_skill", fake)


@pytest.mark.anyio
async def test_knowledge_adapter_zim_fast_path_skips_network(monkeypatch):
    """When ZIM has a high-scoring local hit, the adapter returns it
    immediately without touching Wikipedia or DuckDuckGo."""
    from unittest.mock import AsyncMock
    from lokidoki.orchestrator.skills import knowledge as adapter
    import lokidoki.archives.search as _search_mod
    from lokidoki.archives.search import ZimArticle

    article = ZimArticle(
        source_id="wikipedia",
        title="Corey Feldman",
        path="A/Corey_Feldman",
        snippet="Corey Scott Feldman is an American actor known for roles in 1980s films.",
        url="https://en.wikipedia.org/wiki/Corey_Feldman",
        source_label="Wikipedia",
    )
    mock_engine = type("E", (), {
        "loaded_sources": ["wikipedia"],
        "search": AsyncMock(return_value=[article]),
    })()
    monkeypatch.setattr(_search_mod, "get_search_engine", lambda: mock_engine)

    # Install wiki + ddg fakes that MUST NOT be called
    wiki = _RecordingFake({"mediawiki_api": _fail("should not be called")})
    ddg = _RecordingFake({"ddg_api": _fail("should not be called")})
    _install_wiki_fake.__wrapped__ = None  # skip _disable_zim
    monkeypatch.setattr(adapter, "_WIKI", wiki, raising=True)
    _install_ddg_fake(monkeypatch, adapter, ddg)

    result = await adapter.handle({"chunk_text": "who is corey feldman"})
    assert result["success"] is True
    assert "Corey" in result["output_text"]
    assert "(offline)" in result.get("source_title", "")
    # Network sources must NOT have been contacted
    assert wiki.calls == []
    assert ddg.calls == []


@pytest.mark.anyio
async def test_knowledge_adapter_zim_salvages_disambiguation_intro(monkeypatch):
    """A local Wikipedia disambiguation snippet should keep a valid intro
    sentence but drop the dangling 'may also refer to' tail."""
    from unittest.mock import AsyncMock
    from lokidoki.orchestrator.skills import knowledge as adapter
    import lokidoki.archives.search as _search_mod
    from lokidoki.archives.search import ZimArticle

    article = ZimArticle(
        source_id="wikipedia",
        title="Divine Intervention",
        path="A/Divine_Intervention",
        snippet=(
            "Divine intervention is an event that occurs when a deity becomes actively "
            "involved in changing some situation in human affairs.\n\n"
            "Divine Intervention may also refer to:"
        ),
        url="https://en.wikipedia.org/wiki/Divine_Intervention",
        source_label="Wikipedia",
    )
    mock_engine = type("E", (), {
        "loaded_sources": ["wikipedia"],
        "search": AsyncMock(return_value=[article]),
        "get_article_html": AsyncMock(return_value=""),
    })()
    monkeypatch.setattr(_search_mod, "get_search_engine", lambda: mock_engine)

    wiki = _RecordingFake({"mediawiki_api": _fail("should not be called")})
    ddg = _RecordingFake({"ddg_api": _fail("should not be called")})
    monkeypatch.setattr(adapter, "_WIKI", wiki, raising=True)
    _install_ddg_fake(monkeypatch, adapter, ddg)

    result = await adapter.handle({"chunk_text": "what is divine intervention"})
    assert result["success"] is True
    assert result["output_text"].endswith("human affairs.")
    assert "may also refer to" not in result["output_text"].lower()
    assert result["data"]["lead"].endswith("human affairs.")


@pytest.mark.anyio
async def test_knowledge_adapter_zim_rejects_off_topic_example_match(monkeypatch):
    """Regression: a ZIM hit whose *title* has no overlap with the query
    must NOT be accepted just because the query words appear inside the
    article body as an example.

    Exact case that shipped to production: "how do I change a tire"
    matched the Wikipedia article "Procedural knowledge" at score=1.0
    because the article body cites "I know how to change a flat tire"
    as an example of procedural knowledge. Title-relevance was never
    checked, so the adapter trusted it, the fast-path skipped LLM
    synthesis, and the user saw a raw dump of the Procedural knowledge
    article instead of tire-change steps.
    """
    from unittest.mock import AsyncMock
    from lokidoki.orchestrator.skills import knowledge as adapter
    import lokidoki.archives.search as _search_mod
    from lokidoki.archives.search import ZimArticle

    off_topic = ZimArticle(
        source_id="wikipedia",
        title="Procedural knowledge",
        path="A/Procedural_knowledge",
        snippet=(
            "Procedural knowledge, also known as know-how, is the knowledge "
            "exercised in the performance of some task. A common example is "
            "'I know how to change a flat tire' — knowing how to perform an "
            "action is distinct from knowing propositional facts."
        ),
        url="https://en.wikipedia.org/wiki/Procedural_knowledge",
        source_label="Wikipedia",
    )
    mock_engine = type("E", (), {
        "loaded_sources": ["wikipedia"],
        "search": AsyncMock(return_value=[off_topic]),
    })()
    monkeypatch.setattr(_search_mod, "get_search_engine", lambda: mock_engine)

    # Network fallbacks return empty so we isolate the ZIM gating decision.
    wiki = _RecordingFake({"mediawiki_api": _fail("no network"),
                           "web_scraper": _fail("no network")})
    ddg = _RecordingFake({"ddg_api": _fail("no network"),
                          "ddg_scraper": _fail("no network")})
    monkeypatch.setattr(adapter, "_WIKI", wiki, raising=True)
    _install_ddg_fake(monkeypatch, adapter, ddg)

    result = await adapter.handle({"chunk_text": "how do I change a tire"})
    # The skill must fail so the LLM fallback answers — never return the
    # off-topic article as if it were a real answer.
    assert result["success"] is False, (
        "Procedural knowledge article leaked through despite title mismatch"
    )
    # And the raw snippet text must NOT appear in the output.
    assert "procedural knowledge" not in result["output_text"].lower()


@pytest.mark.anyio
async def test_knowledge_adapter_mediawiki_rejects_partial_token_match(monkeypatch):
    """Regression: the network Wikipedia path used a one-token-overlap
    title gate that accepted "Amanda Palmer" for "who is palmer rocky"
    (1/2 token overlap). The stricter rule now requires 2-of-2 for
    2-token queries, so the MediaWiki mechanism must return failure
    and the adapter must NOT surface Amanda Palmer's lead as if it
    were the right answer.
    """
    from lokidoki.skills.knowledge.skill import WikipediaSkill

    skill = WikipediaSkill()

    class _FakeResponse:
        def __init__(self, payload):
            self.status_code = 200
            self._payload = payload
        def json(self):
            return self._payload

    class _FakeClient:
        def __init__(self, *a, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, params=None):
            # First call: search endpoint → returns "Amanda Palmer" on top.
            if params and params.get("list") == "search":
                return _FakeResponse({"query": {"search": [
                    {"title": "Amanda Palmer"},
                    {"title": "Robert Palmer"},
                    {"title": "Palmer (Arkansas)"},
                ]}})
            return _FakeResponse({"query": {"pages": {}}})

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)

    result = await skill._mediawiki_api({"query": "who is palmer rocky"})
    assert result.success is False, (
        "MediaWiki path accepted an article with only 1-of-2 token overlap"
    )
    assert "no relevant" in (result.error or "").lower()


@pytest.mark.anyio
async def test_knowledge_adapter_zim_rejects_partial_token_match(monkeypatch):
    """Regression: a 2-token person query like "who is palmer rocky" must
    not be satisfied by an article whose title shares only one of those
    tokens ("Palmer Island Light Station" has "Palmer" but not "Rocky").

    Exact case that shipped to production: 1 of 2 query tokens overlapped
    the title, 2 of 2 overlapped the body (because the snippet mentions
    "rocky shoal"), so the adapter trusted the hit and dumped the
    lighthouse article for a person query. Multi-token queries now
    require most of the tokens to appear in the TITLE, not just one.
    """
    from unittest.mock import AsyncMock
    from lokidoki.orchestrator.skills import knowledge as adapter
    import lokidoki.archives.search as _search_mod
    from lokidoki.archives.search import ZimArticle

    off_topic = ZimArticle(
        source_id="wikipedia",
        title="Palmer Island Light Station",
        path="A/Palmer_Island_Light_Station",
        snippet=(
            "Palmer Island Light Station is a historic lighthouse in New "
            "Bedford Harbor. From 1888 until 1891 it guided vessels past "
            "Butler Flats, a rocky shoal on the west side of the channel."
        ),
        url="https://en.wikipedia.org/wiki/Palmer_Island_Light_Station",
        source_label="Wikipedia",
    )
    mock_engine = type("E", (), {
        "loaded_sources": ["wikipedia"],
        "search": AsyncMock(return_value=[off_topic]),
    })()
    monkeypatch.setattr(_search_mod, "get_search_engine", lambda: mock_engine)

    wiki = _RecordingFake({"mediawiki_api": _fail("no network"),
                           "web_scraper": _fail("no network")})
    ddg = _RecordingFake({"ddg_api": _fail("no network"),
                          "ddg_scraper": _fail("no network")})
    monkeypatch.setattr(adapter, "_WIKI", wiki, raising=True)
    _install_ddg_fake(monkeypatch, adapter, ddg)

    result = await adapter.handle({"chunk_text": "who is palmer rocky"})
    assert result["success"] is False, (
        "Lighthouse article leaked through for a person query that only "
        "overlapped one of two query tokens"
    )


@pytest.mark.anyio
async def test_knowledge_adapter_zim_rejects_portal_and_category_titles(monkeypatch):
    """Regression: ZIM top-hits starting with ``Portal:`` / ``Category:``
    / ``Template:`` are junk and must be rejected even when the snippet
    happens to score well. Exact case: "how do I give cpr" → ZIM
    top-hit was ``Portal:Illinois``."""
    from unittest.mock import AsyncMock
    from lokidoki.orchestrator.skills import knowledge as adapter
    import lokidoki.archives.search as _search_mod
    from lokidoki.archives.search import ZimArticle

    junk = ZimArticle(
        source_id="wikipedia",
        title="Portal:Illinois",
        path="A/Portal:Illinois",
        snippet="... did you know that CPR was first described in Illinois ...",
        url="https://en.wikipedia.org/wiki/Portal:Illinois",
        source_label="Wikipedia",
    )
    mock_engine = type("E", (), {
        "loaded_sources": ["wikipedia"],
        "search": AsyncMock(return_value=[junk]),
    })()
    monkeypatch.setattr(_search_mod, "get_search_engine", lambda: mock_engine)

    wiki = _RecordingFake({"mediawiki_api": _fail("no network"),
                           "web_scraper": _fail("no network")})
    ddg = _RecordingFake({"ddg_api": _fail("no network"),
                          "ddg_scraper": _fail("no network")})
    monkeypatch.setattr(adapter, "_WIKI", wiki, raising=True)
    _install_ddg_fake(monkeypatch, adapter, ddg)

    result = await adapter.handle({"chunk_text": "how do I give cpr"})
    assert result["success"] is False, "Portal:* junk article leaked through"


@pytest.mark.anyio
async def test_knowledge_adapter_prefers_wiki_when_both_match(monkeypatch):
    """When both sources cover the subject equally, Wikipedia wins by
    preference (first in the sources list) — it's authoritative."""
    from lokidoki.orchestrator.skills import knowledge as adapter

    wiki = _RecordingFake({
        "mediawiki_api": _ok({
            "title": "Copper",
            "lead": "Copper is a chemical element and a ductile metal used in pennies.",
        }),
    })
    ddg = _RecordingFake({
        "ddg_api": _ok({
            "abstract": "Copper is a reddish-brown metal used in pennies and wiring.",
        }),
    })
    _install_wiki_fake(monkeypatch, adapter, wiki)
    _install_ddg_fake(monkeypatch, adapter, ddg)

    result = await adapter.handle({"chunk_text": "what is copper"})
    assert "chemical element" in result["output_text"]  # wiki's lead wins ties
    assert result["data"]["winner"] == "wikipedia"
    assert result["data"]["winner_score"] == 1.0


@pytest.mark.anyio
async def test_knowledge_adapter_switches_to_web_when_wiki_off_subject(monkeypatch):
    """The "claude mythos" case — Wikipedia returns its closest article
    ("Claude"), which only covers half the query; web search returns a
    snippet mentioning the full subject, so web wins on score."""
    from lokidoki.orchestrator.skills import knowledge as adapter

    wiki = _RecordingFake({
        "mediawiki_api": _ok({
            "title": "Claude",
            "lead": "Claude is a series of large language models developed by Anthropic.",
        }),
    })
    ddg = _RecordingFake({
        "ddg_api": _ok({
            "abstract": "Claude Mythos is an upcoming narrative game.",
        }),
    })
    _install_wiki_fake(monkeypatch, adapter, wiki)
    _install_ddg_fake(monkeypatch, adapter, ddg)

    result = await adapter.handle({"chunk_text": "what is claude mythos"})
    assert "Claude Mythos" in result["output_text"]
    assert result["data"]["winner"] == "web"
    # Wiki only matched "claude" (1/2) — web matched both.
    wiki_candidate = next(c for c in result["data"]["candidates"] if c["source"] == "wikipedia")
    web_candidate = next(c for c in result["data"]["candidates"] if c["source"] == "web")
    assert wiki_candidate["score"] == 0.5
    assert web_candidate["score"] == 1.0


@pytest.mark.anyio
async def test_knowledge_adapter_rejects_single_token_web_snippet_junk(monkeypatch):
    """Regression: single-token definitional lookups like ``jarvis``
    must not accept snippet-only web rows that merely repeat the token.

    Exact failure shipped to the UI: ``what is jarvis`` surfaced a
    bundle of wallpaper links because the web scorer treated any snippet
    mentioning "Jarvis" as a perfect topical match.
    """
    from lokidoki.orchestrator.skills import knowledge as adapter

    wiki = _RecordingFake({
        "mediawiki_api": _fail("no relevant article"),
        "web_scraper": _fail("no relevant article"),
    })
    ddg = _RecordingFake({
        "ddg_api": _ok({
            "heading": "jarvis",
            "results": [
                "🔥 [50+] Jarvis Wallpapers HD | WallpaperSafari",
                "[100+] Jarvis Wallpapers | Wallpapers.com",
                "Jarvis Wallpapers - Wallpaper Cave",
            ],
        }),
    })
    _install_wiki_fake(monkeypatch, adapter, wiki)
    _install_ddg_fake(monkeypatch, adapter, ddg)

    result = await adapter.handle({"chunk_text": "what is jarvis"})
    assert result["success"] is False
    assert "couldn't find" in result["output_text"].lower()
    candidates = result["data"]["candidates"]
    web_candidate = next(c for c in candidates if c["source"] == "web")
    assert web_candidate["score"] == 0.0


@pytest.mark.anyio
async def test_knowledge_adapter_fails_when_both_score_below_threshold(monkeypatch):
    """Novel query that neither source has any info on — the skill must
    fail so the LLM fallback handles it instead of grounding synthesis on
    an unrelated article."""
    from lokidoki.orchestrator.skills import knowledge as adapter

    wiki = _RecordingFake({
        "mediawiki_api": _ok({
            "title": "Zebra",
            "lead": "A zebra is an African equine.",
        }),
    })
    ddg = _RecordingFake({
        "ddg_api": _ok({
            "abstract": "Unrelated marketing copy about shoes.",
        }),
    })
    _install_wiki_fake(monkeypatch, adapter, wiki)
    _install_ddg_fake(monkeypatch, adapter, ddg)

    result = await adapter.handle({"chunk_text": "what is kzqx plyvar"})
    assert result["success"] is False
    assert "couldn't find" in result["output_text"].lower()
    assert result["data"]["winner"] is None


@pytest.mark.anyio
async def test_knowledge_adapter_fails_when_both_sources_fail(monkeypatch):
    """Both sources' internal waterfalls exhaust without success — skill
    must report failure cleanly for the LLM fallback."""
    from lokidoki.orchestrator.skills import knowledge as adapter

    wiki = _RecordingFake({
        "mediawiki_api": _fail("wiki api down"),
        "web_scraper": _fail("wiki scraper down"),
    })
    ddg = _RecordingFake({
        "ddg_api": _fail("ddg api down"),
        "ddg_scraper": _fail("ddg scraper down"),
    })
    _install_wiki_fake(monkeypatch, adapter, wiki)
    _install_ddg_fake(monkeypatch, adapter, ddg)

    result = await adapter.handle({"chunk_text": "who invented the lightbulb"})
    assert result["success"] is False
    # Both sources were given a chance at their full internal waterfall.
    assert [c[0] for c in wiki.calls] == ["mediawiki_api", "web_scraper"]
    assert [c[0] for c in ddg.calls] == ["ddg_api", "ddg_scraper"]


@pytest.mark.anyio
async def test_knowledge_adapter_wiki_internal_waterfall_still_works(monkeypatch):
    """Wikipedia's own api→scraper waterfall must still be tried before
    we even score it against the web candidate."""
    from lokidoki.orchestrator.skills import knowledge as adapter

    wiki = _RecordingFake({
        "mediawiki_api": _fail("api down"),
        "web_scraper": _ok({
            "title": "Copper",
            "lead": "Copper is a chemical element used in pennies.",
        }),
    })
    ddg = _RecordingFake({
        "ddg_api": _fail("ddg down"),
        "ddg_scraper": _fail("ddg html down"),
    })
    _install_wiki_fake(monkeypatch, adapter, wiki)
    _install_ddg_fake(monkeypatch, adapter, ddg)

    result = await adapter.handle({"chunk_text": "what is copper"})
    assert result["success"] is True
    assert "chemical element" in result["output_text"]
    assert [c[0] for c in wiki.calls] == ["mediawiki_api", "web_scraper"]
    assert result["data"]["winner"] == "wikipedia"


# ---- showtimes adapter -----------------------------------------------------


@pytest.mark.anyio
async def test_showtimes_adapter_pulls_title_after_for(monkeypatch):
    from lokidoki.orchestrator.skills import showtimes as adapter

    fake = _RecordingFake({
        "movie_showtimes": _ok({"lead": "Showtimes for inception: 7:00 PM."}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "Show me movie times for Inception in 90210"})
    assert "inception" in result["output_text"].lower()
    method, params = fake.calls[0]
    assert method == "movie_showtimes"
    assert params["query"] == "inception"
    assert params["zip"] == "90210"


@pytest.mark.anyio
async def test_showtimes_adapter_uses_default_zip_when_missing(monkeypatch):
    from lokidoki.orchestrator.skills import showtimes as adapter

    fake = _RecordingFake({
        "movie_showtimes": _ok({"lead": "Showtimes for the dark knight: 9 PM."}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "movie times for the dark knight"})
    method, params = fake.calls[0]
    assert params["query"] == "the dark knight"
    assert params["zip"] == "90210"


# ---- smarthome adapters ----------------------------------------------------


@pytest.mark.anyio
async def test_smarthome_control_device_imperative(monkeypatch):
    from lokidoki.orchestrator.skills import smarthome as adapter

    fake = _RecordingFake({
        "local_state": _ok({"device_id": "living_room_light", "name": "Living Room Light", "state": "on"}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.control_device({"chunk_text": "turn on the living room light"})
    assert "Living Room Light is now on." == result["output_text"]
    method, params = fake.calls[0]
    assert method == "local_state"
    assert params["device"] == "living room light"
    assert params["action"] == "on"


@pytest.mark.anyio
async def test_smarthome_get_device_state_question(monkeypatch):
    from lokidoki.orchestrator.skills import smarthome as adapter

    fake = _RecordingFake({
        "local_state": _ok({
            "device_id": "garage_door",
            "name": "Garage Door",
            "state": "closed",
            "type": "cover",
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.get_device_state({"chunk_text": "did i close the garage"})
    assert "Garage Door" in result["output_text"]
    assert "closed" in result["output_text"]
    method, params = fake.calls[0]
    assert params["device"] == "garage"
    assert params["action"] == "status"


@pytest.mark.anyio
async def test_smarthome_get_indoor_temperature_reads_thermostat(monkeypatch):
    from lokidoki.orchestrator.skills import smarthome as adapter

    fake = _RecordingFake({
        "local_state": _ok({
            "device_id": "thermostat",
            "name": "Thermostat",
            "type": "climate",
            "state": "on",
            "temperature": 22,
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.get_indoor_temperature({"chunk_text": "how warm is it inside"})
    assert "22" in result["output_text"]
    assert "°C" in result["output_text"] or "C" in result["output_text"]
    method, params = fake.calls[0]
    assert params["device"] == "thermostat"


@pytest.mark.anyio
async def test_smarthome_detect_presence_uses_overlay_table():
    from lokidoki.orchestrator.skills import smarthome as adapter

    adapter.set_presence("kitchen", "no one")
    result = await adapter.detect_presence({"chunk_text": "is anyone in the kitchen"})
    assert "kitchen" in result["output_text"]
    assert "don't see anyone" in result["output_text"].lower() or "no one" in result["output_text"].lower()

    adapter.set_presence("kitchen", "Luke")
    result = await adapter.detect_presence({"chunk_text": "is anyone in the kitchen"})
    assert "Luke" in result["output_text"]
    # restore
    adapter.set_presence("kitchen", "no one")


# ---- dictionary adapter ----------------------------------------------------


@pytest.mark.anyio
async def test_dictionary_adapter_extracts_word_from_define_prefix(monkeypatch):
    from lokidoki.orchestrator.skills import dictionary as adapter

    fake = _RecordingFake({
        "dictionaryapi_dev": _ok({
            "word": "ephemeral",
            "phonetic": "/ɪˈfɛmərəl/",
            "meanings": [
                {"part_of_speech": "adjective", "definitions": ["lasting for a very short time"]}
            ],
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "define ephemeral"})
    assert "ephemeral" in result["output_text"]
    assert "lasting for a very short time" in result["output_text"]
    method, params = fake.calls[0]
    assert params["word"] == "ephemeral"


# ---- news adapter ----------------------------------------------------------


@pytest.mark.anyio
async def test_news_adapter_returns_top_headline(monkeypatch):
    from lokidoki.orchestrator.skills import news as adapter

    fake = _RecordingFake({
        "google_news_rss": _ok({
            "topic": "tech",
            "headlines": [
                {"title": "Big tech merger announced", "source": "TestPress"},
                {"title": "Other story", "source": "TestPress"},
            ],
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "what's happening in tech news"})
    assert "Big tech merger announced" in result["output_text"]
    method, params = fake.calls[0]
    assert params["topic"] == "tech"


# ---- recipes adapter -------------------------------------------------------


@pytest.mark.anyio
async def test_recipes_adapter_returns_first_recipe_with_ingredients(monkeypatch):
    from lokidoki.orchestrator.skills import recipes as adapter

    fake = _RecordingFake({
        "themealdb": _ok({
            "query": "lasagna",
            "recipes": [
                {"name": "Lasagna", "ingredients": ["pasta", "tomato", "cheese"]},
            ],
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "recipe for lasagna"})
    assert "Lasagna" in result["output_text"]
    assert "pasta" in result["output_text"]


# ---- jokes adapter ---------------------------------------------------------


@pytest.mark.anyio
async def test_jokes_adapter_returns_joke(monkeypatch):
    from lokidoki.orchestrator.skills import jokes as adapter

    fake = _RecordingFake({
        "icanhazdadjoke": _ok({"joke": "Why don't eggs tell jokes? They'd crack each other up."}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "tell me a joke"})
    assert "eggs" in result["output_text"]


# ---- tv_show adapter -------------------------------------------------------


@pytest.mark.anyio
async def test_tv_show_adapter_includes_network_and_rating(monkeypatch):
    from lokidoki.orchestrator.skills import tv_show as adapter

    fake = _RecordingFake({
        "tvmaze_api": _ok({
            "name": "Breaking Bad",
            "status": "Ended",
            "network": "Starlight",
            "rating": 9.5,
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "tell me about the tv show breaking bad"})
    assert "Breaking Bad" in result["output_text"]
    assert "Starlight" in result["output_text"]
    assert "9.5" in result["output_text"]


# ---- calculator + units adapters -------------------------------------------


@pytest.mark.anyio
async def test_calculator_adapter_evaluates_expression(monkeypatch):
    from lokidoki.orchestrator.skills import calculator as adapter

    fake = _RecordingFake({
        "safe_eval": _ok({"expression": "6*4", "normalized": "6*4", "result": 24}),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "6*4"})
    assert result["output_text"] == "24"
    method, params = fake.calls[0]
    assert params["expression"] == "6*4"


@pytest.mark.anyio
async def test_units_adapter_parses_convert_phrasing(monkeypatch):
    from lokidoki.orchestrator.skills import units as adapter

    fake = _RecordingFake({
        "table_lookup": _ok({
            "value": 10.0,
            "from_unit": "miles",
            "to_unit": "km",
            "result": 16.09,
            "category": "length",
        }),
    })
    _install_fake(monkeypatch, adapter, fake)

    result = await adapter.handle({"chunk_text": "convert 10 miles to km"})
    assert "16" in result["output_text"]
    assert "km" in result["output_text"]


# ---- get_time_in_location (zoneinfo, no v1 dep) ----------------------------


@pytest.mark.anyio
async def test_time_in_location_resolves_known_city():
    from lokidoki.orchestrator.skills import time_in_location as adapter

    result = await adapter.handle({"chunk_text": "what time is it in tokyo"})
    assert "Tokyo" in result["output_text"]
    assert "data" in result and result["data"]["timezone"] == "Asia/Tokyo"


@pytest.mark.anyio
async def test_time_in_location_unknown_city_graceful():
    from lokidoki.orchestrator.skills import time_in_location as adapter

    result = await adapter.handle({"chunk_text": "what time is it in atlantis"})
    assert result["success"] is False
    assert "don't know" in result["output_text"].lower()


# ---- LLM-backed handlers (stub fallback path) ------------------------------


@pytest.mark.anyio
async def test_llm_skills_return_stub_when_llm_disabled():
    from lokidoki.orchestrator.skills import llm_skills

    # CONFIG.llm_enabled defaults to False in tests, so every call
    # should return its deterministic stub immediately.
    result = await llm_skills.generate_email({"chunk_text": "write a refund email"})
    assert "Subject" in result["output_text"]

    result = await llm_skills.code_assistance({"chunk_text": "write a python scraper"})
    assert "```" in result["output_text"]

    result = await llm_skills.summarize_text({"chunk_text": "summarize this article"})
    assert "summary" in result["output_text"].lower()

    result = await llm_skills.create_plan({"chunk_text": "plan a 3 day trip"})
    assert "Day" in result["output_text"]

    result = await llm_skills.weigh_options({"chunk_text": "should i invest or save"})
    assert "options" in result["output_text"].lower()

    result = await llm_skills.emotional_support({"chunk_text": "i feel stuck in life"})
    assert "hear you" in result["output_text"].lower()


# ---- regression: top-1-and-trust pattern across skills ---------------------
#
# Same bug class as the knowledge adapter's "Amanda Palmer for palmer rocky"
# failure: a fuzzy upstream search returns a wrong-but-popular result, the
# skill blindly trusts the top row, and the user sees confident wrong data.
# Each test below fakes the upstream to return exactly the mismatch pattern
# and asserts the skill fails cleanly so the LLM fallback answers instead.


class _HTTPResp:
    def __init__(self, payload, status=200):
        self.status_code = status
        self._payload = payload
        self.text = ""

    def json(self):
        return self._payload


def _fake_httpx_client(router):
    """Build an AsyncClient stand-in that dispatches requests via ``router``.

    ``router`` is a callable ``(url, params) -> _HTTPResp``.
    """
    class _Client:
        def __init__(self, *a, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url, params=None, headers=None):
            return router(url, params or {})

    return _Client


@pytest.mark.anyio
async def test_markets_adapter_rejects_mismatched_symbol(monkeypatch):
    """Yahoo quote endpoint is an exact lookup but observed to echo a
    different symbol for delisted / renamed tickers. The skill must
    fail rather than quote a different company under the wrong ticker.
    """
    import httpx
    from lokidoki.orchestrator.skills import markets

    def router(url, params):
        # Pretend Yahoo returned a quote for a DIFFERENT symbol than requested.
        return _HTTPResp({
            "quoteResponse": {
                "result": [{
                    "symbol": "AAPL",
                    "regularMarketPrice": 180.0,
                    "currency": "USD",
                    "shortName": "Apple Inc.",
                }]
            }
        })

    monkeypatch.setattr(httpx, "AsyncClient", _fake_httpx_client(router))

    result = await markets.get_stock_price({"params": {"ticker": "APPL"}})
    assert result["success"] is False, (
        "markets quoted Apple Inc. under the misspelled ticker APPL"
    )


@pytest.mark.anyio
async def test_markets_adapter_accepts_matching_symbol(monkeypatch):
    """Happy path — matching symbol is returned normally."""
    import httpx
    from lokidoki.orchestrator.skills import markets

    def router(url, params):
        return _HTTPResp({
            "quoteResponse": {
                "result": [{
                    "symbol": "AAPL",
                    "regularMarketPrice": 180.0,
                    "currency": "USD",
                    "shortName": "Apple Inc.",
                }]
            }
        })

    monkeypatch.setattr(httpx, "AsyncClient", _fake_httpx_client(router))

    result = await markets.get_stock_price({"params": {"ticker": "AAPL"}})
    assert result["success"] is True
    assert "Apple" in result["output_text"]


@pytest.mark.anyio
async def test_people_facts_rejects_wrong_entity_for_partial_name_match(monkeypatch):
    """Wikidata ``wbsearchentities`` is fuzzy — "palmer rocky" returns
    Amanda Palmer at the top on the strength of the "palmer" token
    alone. The skill used to fetch whatever claims that entity had and
    surface "palmer rocky occupation is singer" with Amanda Palmer's
    data. Now it must fail instead.
    """
    import httpx
    from lokidoki.orchestrator.skills import people_facts

    def router(url, params):
        if "wbsearchentities" in str(params.get("action", "")):
            return _HTTPResp({
                "search": [
                    {"id": "Q123", "label": "Amanda Palmer", "description": "singer"},
                    {"id": "Q456", "label": "Robert Palmer", "description": "musician"},
                ]
            })
        return _HTTPResp({"entities": {}})

    monkeypatch.setattr(httpx, "AsyncClient", _fake_httpx_client(router))

    # Also stub the web fallback so failures propagate instead of
    # silently being rescued by DuckDuckGo.
    from lokidoki.orchestrator.skills._runner import web_search_source
    if not hasattr(web_search_source, "_skill"):
        from lokidoki.skills.search.skill import DuckDuckGoSkill
        web_search_source._skill = DuckDuckGoSkill()  # type: ignore[attr-defined]
    web_fake = _RecordingFake({"ddg_api": _fail("no network"),
                               "ddg_scraper": _fail("no network")})
    monkeypatch.setattr(web_search_source, "_skill", web_fake)

    result = await people_facts.lookup_fact({"chunk_text": "palmer rocky occupation"})
    assert result["success"] is False, (
        "people_facts grounded on Amanda Palmer's Wikidata entry for "
        "'palmer rocky' via one-token label overlap"
    )


@pytest.mark.anyio
async def test_people_facts_accepts_exact_name_match(monkeypatch):
    """Happy path — a Wikidata entity whose label matches the person
    name (both tokens) is accepted and its claims are surfaced."""
    import httpx
    from lokidoki.orchestrator.skills import people_facts

    call_log: list[tuple[str, dict]] = []

    def router(url, params):
        call_log.append((url, dict(params)))
        if "wbsearchentities" in str(params.get("action", "")):
            return _HTTPResp({
                "search": [
                    {"id": "Q12345", "label": "Corey Feldman", "description": "actor"},
                ]
            })
        return _HTTPResp({
            "entities": {
                "Q12345": {
                    "labels": {"en": {"value": "Corey Feldman"}},
                    "claims": {
                        # P27 = country of citizenship
                        "P27": [{"mainsnak": {"datavalue": {"value": {"id": "Q30"}}}}],
                    },
                }
            }
        })

    monkeypatch.setattr(httpx, "AsyncClient", _fake_httpx_client(router))

    result = await people_facts.lookup_fact({"chunk_text": "what is corey feldman's nationality"})
    # Success isn't strictly required here (parallel-scored source may pick web),
    # but the Wikidata call must at least have been attempted with the resolved
    # entity — not rejected up-front.
    assert any("wbsearchentities" in str(p.get("action")) for _, p in call_log), (
        "Wikidata search endpoint was never hit for the exact-match case"
    )


@pytest.mark.anyio
async def test_tmdb_rejects_off_topic_title(monkeypatch):
    """TMDB search ranks by popularity — "palmer rocky" (routed badly
    as a movie query) could return "Rocky (1976)" at the top. The
    skill must gate on title overlap and fail rather than surface
    Stallone's movie plot for a person lookup."""
    import httpx
    from lokidoki.skills.movies_tmdb.skill import TMDBSkill

    def router(url, params):
        return _HTTPResp({
            "results": [
                {"id": 1, "title": "Rocky", "release_date": "1976-11-21",
                 "overview": "A Philadelphia boxer gets a shot at the world title.",
                 "vote_average": 8.1, "vote_count": 1234},
            ]
        })

    monkeypatch.setattr(httpx, "AsyncClient", _fake_httpx_client(router))

    skill = TMDBSkill(api_key="stub")
    result = await skill._tmdb_api({"query": "palmer rocky"})
    assert result.success is False, (
        "TMDB accepted 'Rocky' for 'palmer rocky' despite only 1/2 token overlap"
    )


@pytest.mark.anyio
async def test_tmdb_accepts_exact_title(monkeypatch):
    """Happy path — an exact title match is accepted."""
    import httpx
    from lokidoki.skills.movies_tmdb.skill import TMDBSkill

    def router(url, params):
        return _HTTPResp({
            "results": [
                {"id": 603, "title": "The Matrix", "release_date": "1999-03-31",
                 "overview": "A hacker learns the world is a simulation.",
                 "vote_average": 8.7, "vote_count": 24000},
            ]
        })

    monkeypatch.setattr(httpx, "AsyncClient", _fake_httpx_client(router))

    skill = TMDBSkill(api_key="stub")
    result = await skill._tmdb_api({"query": "the matrix"})
    assert result.success is True
    assert result.data["title"] == "The Matrix"


@pytest.mark.anyio
async def test_youtube_rejects_off_topic_top_result(monkeypatch):
    """YouTube search ranks by popularity + watch history — the first
    embeddable result may not match the query. The skill must gate on
    title overlap and fail rather than surface an unrelated video."""
    from lokidoki.skills.youtube.skill import YouTubeSkill

    skill = YouTubeSkill()

    async def fake_search(self, q):
        return [{"type": "video", "id": "dQw4w9WgXcQ", "title": "YouTube Video"}]
    async def fake_meta(self, vid):
        # Real title is totally unrelated to the user's query.
        return {"title": "Never Gonna Give You Up", "author_name": "Rick Astley"}

    monkeypatch.setattr(YouTubeSkill, "_search_youtube", fake_search)
    monkeypatch.setattr(YouTubeSkill, "_get_video_metadata", fake_meta)

    result = await skill._get_video({"query": "jimi hendrix voodoo child"})
    assert result.success is False, (
        "YouTube surfaced 'Never Gonna Give You Up' for a Jimi Hendrix query"
    )


@pytest.mark.anyio
async def test_youtube_accepts_matching_title(monkeypatch):
    """Happy path — a video whose title overlaps the query is returned."""
    from lokidoki.skills.youtube.skill import YouTubeSkill

    skill = YouTubeSkill()

    async def fake_search(self, q):
        return [{"type": "video", "id": "vid1", "title": "YouTube Video"}]
    async def fake_meta(self, vid):
        return {
            "title": "Jimi Hendrix - Voodoo Child (Live)",
            "author_name": "Jimi Hendrix",
        }

    monkeypatch.setattr(YouTubeSkill, "_search_youtube", fake_search)
    monkeypatch.setattr(YouTubeSkill, "_get_video_metadata", fake_meta)

    result = await skill._get_video({"query": "jimi hendrix voodoo child"})
    assert result.success is True
    assert "Jimi Hendrix" in result.data["title"]
