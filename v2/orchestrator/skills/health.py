"""Direct health lookups via MedlinePlus and RxNorm-family endpoints."""
from __future__ import annotations

from typing import Any

import httpx

from v2.orchestrator.skills._runner import AdapterResult

_MEDLINE_URL = "https://wsearch.nlm.nih.gov/ws/query"
_RX_APPROX_URL = "https://rxnav.nlm.nih.gov/REST/approximateTerm.json"
_RX_PROPS_URL = "https://rxnav.nlm.nih.gov/REST/rxcui/{rxcui}/allProperties.json"


async def look_up_symptom(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("symptom") or payload.get("chunk_text") or "").strip()
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            response = await client.get(
                _MEDLINE_URL,
                params={"db": "healthTopics", "term": query, "retmax": 1},
                headers={"User-Agent": "LokiDoki/0.2"},
            )
    except httpx.HTTPError as exc:
        return AdapterResult(output_text="I couldn't look up that symptom right now.", success=False, error=str(exc)).to_payload()
    if response.status_code != 200:
        return AdapterResult(output_text="I couldn't look up that symptom right now.", success=False, error=f"http {response.status_code}").to_payload()
    data = response.json()
    docs = (((data.get("list") or {}).get("document")) or [])
    if not docs:
        return AdapterResult(output_text="I couldn't find symptom guidance for that query.", success=False, error="no results").to_payload()
    title = docs[0].get("title") or query
    return AdapterResult(output_text=f"MedlinePlus topic: {title}.", success=True, mechanism_used="medlineplus", data=docs[0]).to_payload()


async def check_medication(payload: dict[str, Any]) -> dict[str, Any]:
    query = str((payload.get("params") or {}).get("name") or payload.get("chunk_text") or "").strip()
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            approx = await client.get(
                _RX_APPROX_URL,
                params={"term": query, "maxEntries": 1},
                headers={"User-Agent": "LokiDoki/0.2"},
            )
            if approx.status_code != 200:
                return AdapterResult(output_text="I couldn't look up that medication right now.", success=False, error=f"http {approx.status_code}").to_payload()
            candidates = (((approx.json().get("approximateGroup") or {}).get("candidate")) or [])
            if not candidates:
                return AdapterResult(output_text="I couldn't find that medication in RxNorm.", success=False, error="no candidate").to_payload()
            rxcui = candidates[0].get("rxcui")
            props = await client.get(_RX_PROPS_URL.format(rxcui=rxcui), headers={"User-Agent": "LokiDoki/0.2"})
            if props.status_code != 200:
                return AdapterResult(output_text="I couldn't look up that medication right now.", success=False, error=f"http {props.status_code}").to_payload()
            concepts = (((props.json().get("propConceptGroup") or {}).get("propConcept")) or [])
            if not concepts:
                return AdapterResult(output_text="I couldn't find medication details for that term.", success=False, error="no properties").to_payload()
            name = concepts[0].get("propValue") or query
    except httpx.HTTPError as exc:
        return AdapterResult(output_text="I couldn't look up that medication right now.", success=False, error=str(exc)).to_payload()
    return AdapterResult(output_text=f"RxNorm match: {name}.", success=True, mechanism_used="rxnorm", data={"name": name, "rxcui": rxcui}).to_payload()
