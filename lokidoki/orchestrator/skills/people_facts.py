"""Structured people-fact lookups — parallel Wikidata + web search.

Wikidata provides precise structured claims (nationality, birth date,
occupation, etc.). Web search (DuckDuckGo via shared
``web_search_source``) provides a generic secondary that catches people
Wikidata doesn't index or returns richer biographical context.
"""
from __future__ import annotations

from typing import Any

import httpx

from lokidoki.orchestrator.skills._runner import (
    AdapterResult,
    run_sources_parallel_scored,
    score_subject_coverage,
    web_search_source,
)

_SEARCH_URL = "https://www.wikidata.org/w/api.php"
_ENTITY_URL = "https://www.wikidata.org/wiki/Special:EntityData/{entity_id}.json"

MIN_SUBJECT_COVERAGE = 0.5

_FACT_TO_PROPERTY = {
    # Identity & origin
    "nationality": "P27",
    "country": "P27",
    "citizenship": "P27",
    "born": "P569",
    "birthday": "P569",
    "birth date": "P569",
    "date of birth": "P569",
    "birthplace": "P19",
    "birth place": "P19",
    "born in": "P19",
    "died": "P570",
    "death date": "P570",
    "date of death": "P570",
    "death place": "P20",
    "cause of death": "P509",
    # Career & work
    "occupation": "P106",
    "job": "P106",
    "profession": "P106",
    "employer": "P108",
    "works for": "P108",
    "educated at": "P69",
    "education": "P69",
    "university": "P69",
    "school": "P69",
    "alma mater": "P69",
    "award": "P166",
    "awards": "P166",
    "member of": "P463",
    "political party": "P102",
    "party": "P102",
    "position": "P39",
    "office": "P39",
    # Personal
    "spouse": "P26",
    "married to": "P26",
    "wife": "P26",
    "husband": "P26",
    "child": "P40",
    "children": "P40",
    "father": "P22",
    "mother": "P25",
    "sibling": "P3373",
    "height": "P2048",
    "religion": "P140",
    "language": "P1412",
    "languages spoken": "P1412",
}


def _extract_person_and_fact(text: str) -> tuple[str, str]:
    lower = text.lower()
    for fact in _FACT_TO_PROPERTY:
        if fact in lower:
            person = lower.replace("what is", "").replace("who is", "").replace(fact, "").strip(" ?")
            return person.title(), fact
    return text.strip().title(), "nationality"


async def _search_entity(client: httpx.AsyncClient, name: str) -> str | None:
    response = await client.get(
        _SEARCH_URL,
        params={
            "action": "wbsearchentities",
            "format": "json",
            "language": "en",
            "type": "item",
            "search": name,
        },
        headers={"User-Agent": "LokiDoki/0.2"},
    )
    if response.status_code != 200:
        return None
    results = response.json().get("search") or []
    return results[0].get("id") if results else None


async def _entity_label(client: httpx.AsyncClient, entity_id: str) -> str | None:
    response = await client.get(_ENTITY_URL.format(entity_id=entity_id), headers={"User-Agent": "LokiDoki/0.2"})
    if response.status_code != 200:
        return None
    entity = (response.json().get("entities") or {}).get(entity_id) or {}
    return (((entity.get("labels") or {}).get("en") or {}).get("value"))


async def _wikidata_source(person: str, fact: str, prop: str) -> AdapterResult:
    """Wikidata structured-claim source."""
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            entity_id = await _search_entity(client, person)
            if not entity_id:
                return AdapterResult(
                    output_text="", success=False,
                    error="person not found in Wikidata",
                )
            response = await client.get(
                _ENTITY_URL.format(entity_id=entity_id),
                headers={"User-Agent": "LokiDoki/0.2"},
            )
            if response.status_code != 200:
                return AdapterResult(
                    output_text="", success=False,
                    error=f"http {response.status_code}",
                )
            entity = ((response.json().get("entities") or {}).get(entity_id) or {})
            claims = entity.get("claims") or {}
            statements = claims.get(prop) or []
            if not statements:
                return AdapterResult(
                    output_text="", success=False,
                    error="missing claim",
                )
            value = statements[0].get("mainsnak", {}).get("datavalue", {}).get("value")
            if isinstance(value, dict) and value.get("id"):
                label = await _entity_label(client, value["id"])
                answer = label or value["id"]
            elif isinstance(value, dict) and "time" in value:
                answer = str(value["time"]).lstrip("+").split("T", 1)[0]
            else:
                answer = str(value)
    except httpx.HTTPError as exc:
        return AdapterResult(
            output_text="", success=False, error=str(exc),
        )
    return AdapterResult(
        output_text=f"{person} {fact} is {answer}.",
        success=True,
        mechanism_used="wikidata",
        data={"person": person, "fact": fact, "value": answer},
        source_url=f"https://www.wikidata.org/wiki/{entity_id}",
        source_title=f"Wikidata — {person}",
    )


async def lookup_fact(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    text = str(payload.get("chunk_text") or "")
    person_param = params.get("person")
    person_from_text, fact = _extract_person_and_fact(text)
    person = str(person_param).strip() if person_param else person_from_text
    prop = _FACT_TO_PROPERTY.get(fact, "P27")

    def score(result: AdapterResult) -> float:
        return score_subject_coverage(person, result.output_text)

    result = await run_sources_parallel_scored(
        [
            ("wikidata", _wikidata_source(person, fact, prop)),
            ("web", web_search_source(f"{person} {fact}")),
        ],
        score=score,
        threshold=MIN_SUBJECT_COVERAGE,
        fallback_text=f"I couldn't find information about {person}.",
    )
    return result.to_payload()
