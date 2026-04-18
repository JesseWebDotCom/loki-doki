from __future__ import annotations

from typing import Any

import pytest


class _FakeResponse:
    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self._payload = payload
        self.request = type("Req", (), {"url": "https://example.test"})()

    def json(self) -> Any:
        return self._payload


class _FakeClient:
    def __init__(self, responses: list[_FakeResponse]) -> None:
        self._responses = responses
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def get(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append((url, kwargs))
        return self._responses.pop(0)


@pytest.mark.anyio
async def test_people_fact_uses_wikidata_chain(monkeypatch):
    from lokidoki.orchestrator.skills import people_facts

    fake = _FakeClient([
        _FakeResponse(200, {"search": [{"id": "Q42", "label": "Douglas Adams"}]}),
        _FakeResponse(200, {"entities": {"Q42": {"claims": {"P27": [{"mainsnak": {"datavalue": {"value": {"id": "Q145"}}}}]}}}}),
        _FakeResponse(200, {"entities": {"Q145": {"labels": {"en": {"value": "United Kingdom"}}}}}),
    ])
    monkeypatch.setattr(people_facts.httpx, "AsyncClient", lambda **kwargs: fake)

    result = await people_facts.lookup_fact({"chunk_text": "what is Douglas Adams nationality"})

    assert "United Kingdom" in result["output_text"]


def _disable_zim_engine(monkeypatch):
    """Force ``get_search_engine`` to return None so the health skills'
    ZIM-first probe cleanly misses and falls through to the mocked
    HTTP path. Needed because a dev box may have real medical ZIMs
    downloaded (WikEM etc.) and the skill would otherwise return
    genuine offline content instead of hitting the fake httpx client.
    """
    import lokidoki.archives.search as archives_search
    monkeypatch.setattr(archives_search, "get_search_engine", lambda: None)


@pytest.mark.anyio
async def test_health_medication_uses_rxnorm(monkeypatch):
    from lokidoki.orchestrator.skills import health

    _disable_zim_engine(monkeypatch)
    fake = _FakeClient([
        _FakeResponse(200, {"approximateGroup": {"candidate": [{"rxcui": "860975"}]}}),
        _FakeResponse(200, {"propConceptGroup": {"propConcept": [{"propValue": "Metformin 500 MG Oral Tablet"}]}}),
    ])
    monkeypatch.setattr(health.httpx, "AsyncClient", lambda **kwargs: fake)

    result = await health.check_medication({"chunk_text": "what is metformin for"})

    assert "Metformin" in result["output_text"]


@pytest.mark.anyio
async def test_health_symptom_uses_medline_search(monkeypatch):
    from lokidoki.orchestrator.skills import health

    _disable_zim_engine(monkeypatch)
    fake = _FakeClient([
        _FakeResponse(200, {"spellingCorrection": None, "list": {"document": [{"title": "Knee Injuries and Disorders"}]}}),
    ])
    monkeypatch.setattr(health.httpx, "AsyncClient", lambda **kwargs: fake)

    result = await health.look_up_symptom({"chunk_text": "sharp pain behind the knee"})

    assert "Knee Injuries and Disorders" in result["output_text"]


@pytest.mark.anyio
async def test_tv_schedule_reports_airtime(monkeypatch):
    from lokidoki.orchestrator.skills import tv_show

    class _FakeTVSkill:
        async def execute_mechanism(self, method: str, parameters: dict[str, Any]):
            from lokidoki.core.skill_executor import MechanismResult

            if method == "tvmaze_api":
                return MechanismResult(
                    success=True,
                    data={
                        "name": "Grey's Anatomy",
                        "status": "Running",
                        "network": "ABC",
                        "schedule_days": ["Thursday"],
                        "schedule_time": "22:00",
                    },
                )
            return MechanismResult(success=False, error="miss")

    monkeypatch.setattr(tv_show, "_TVMAZE", _FakeTVSkill(), raising=True)

    result = await tv_show.get_schedule({"chunk_text": "when is Grey's Anatomy on tonight"})

    assert "Thursday" in result["output_text"]
    assert "ABC" in result["output_text"]
