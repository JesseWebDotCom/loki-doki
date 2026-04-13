"""Structured people-fact lookups via Wikidata."""
from __future__ import annotations

from typing import Any

import httpx

from v2.orchestrator.skills._runner import AdapterResult

_SEARCH_URL = "https://www.wikidata.org/w/api.php"
_ENTITY_URL = "https://www.wikidata.org/wiki/Special:EntityData/{entity_id}.json"

_FACT_TO_PROPERTY = {
    "nationality": "P27",
    "country": "P27",
    "citizenship": "P27",
    "birthday": "P569",
    "birth date": "P569",
    "spouse": "P26",
    "height": "P2048",
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


async def lookup_fact(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    text = str(payload.get("chunk_text") or "")
    # Person name: prefer NER-derived param (C05), fall back to text parse
    person_param = params.get("person")
    person_from_text, fact = _extract_person_and_fact(text)
    person = str(person_param).strip() if person_param else person_from_text
    prop = _FACT_TO_PROPERTY.get(fact, "P27")
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            entity_id = await _search_entity(client, person)
            if not entity_id:
                return AdapterResult(output_text="I couldn't find that person in Wikidata.", success=False, error="missing person").to_payload()
            response = await client.get(_ENTITY_URL.format(entity_id=entity_id), headers={"User-Agent": "LokiDoki/0.2"})
            if response.status_code != 200:
                return AdapterResult(output_text="I couldn't look up that fact right now.", success=False, error=f"http {response.status_code}").to_payload()
            entity = ((response.json().get("entities") or {}).get(entity_id) or {})
            claims = entity.get("claims") or {}
            statements = claims.get(prop) or []
            if not statements:
                return AdapterResult(output_text=f"I couldn't find a {fact} fact for {person}.", success=False, error="missing claim").to_payload()
            value = statements[0].get("mainsnak", {}).get("datavalue", {}).get("value")
            if isinstance(value, dict) and value.get("id"):
                label = await _entity_label(client, value["id"])
                answer = label or value["id"]
            elif isinstance(value, dict) and "time" in value:
                answer = str(value["time"]).lstrip("+").split("T", 1)[0]
            else:
                answer = str(value)
    except httpx.HTTPError as exc:
        return AdapterResult(output_text="I couldn't look up that fact right now.", success=False, error=str(exc)).to_payload()
    return AdapterResult(
        output_text=f"{person} {fact} is {answer}.",
        success=True,
        mechanism_used="wikidata",
        data={"person": person, "fact": fact, "value": answer},
        source_url=f"https://www.wikidata.org/wiki/{entity_id}",
        source_title=f"Wikidata — {person}",
    ).to_payload()
