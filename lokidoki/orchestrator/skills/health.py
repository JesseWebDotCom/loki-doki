"""Health lookups — ZIM archives first, MedlinePlus/RxNorm as fallback.

The old implementation was web-only, so offline turns + any transient
API outage produced "I couldn't look up that..." errors that bubbled
up to the synthesis model as vague chit-chat. Now both handlers probe
the local medical ZIM archives (MDWiki, WikEM) first and only fall back
to the upstream APIs when the offline search genuinely misses.
"""
from __future__ import annotations

from typing import Any

import httpx

from lokidoki.orchestrator.skills._runner import AdapterResult, score_subject_coverage

_MEDLINE_URL = "https://wsearch.nlm.nih.gov/ws/query"
_RX_APPROX_URL = "https://rxnav.nlm.nih.gov/REST/approximateTerm.json"
_RX_PROPS_URL = "https://rxnav.nlm.nih.gov/REST/rxcui/{rxcui}/allProperties.json"

# Minimum fraction of query tokens that must appear in a ZIM snippet
# before we trust it as a useful offline answer. Mirrors the value used
# by the knowledge adapter.
MIN_SUBJECT_COVERAGE = 0.4


async def _zim_medical_lookup(query: str, hint: str) -> AdapterResult | None:
    """Try the offline medical ZIMs (MDWiki, WikEM). Returns None on miss.

    ``hint`` narrows the ZIM search to the medical source family via
    :mod:`lokidoki.archives.hint_map`. When the user's installed set
    doesn't include any medical archives we return ``None`` and the
    caller falls back to the web API.
    """
    try:
        from lokidoki.archives.hint_map import filter_to_loaded, sources_for_hint
        from lokidoki.archives.search import get_search_engine

        engine = get_search_engine()
        if engine is None or not engine.loaded_sources:
            return None
        scoped = filter_to_loaded(
            sources_for_hint(hint, "medical"),
            engine.loaded_sources,
        )
        if not scoped:
            return None

        results = await engine.search(query, sources=scoped, max_results=3)
        if not results:
            return None
        best = max(
            results,
            key=lambda r: score_subject_coverage(query, r.snippet),
        )
        if score_subject_coverage(query, best.snippet) < MIN_SUBJECT_COVERAGE:
            return None
        return AdapterResult(
            output_text=best.snippet,
            success=True,
            mechanism_used=f"zim:{best.source_id}",
            source_url=best.url,
            source_title=f"{best.source_label} (offline) — {best.title}",
        )
    except Exception:  # noqa: BLE001 — ZIM faults must never crash the skill
        return None


async def look_up_symptom(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(
        (payload.get("params") or {}).get("symptom")
        or payload.get("chunk_text")
        or "",
    ).strip()
    if not query:
        return AdapterResult(
            output_text="What symptom would you like to look up?",
            success=False, error="missing query",
        ).to_payload()

    # 1. Offline-first: MDWiki / WikEM via the ZIM engine.
    zim_result = await _zim_medical_lookup(query, hint="mdwiki")
    if zim_result is not None:
        return zim_result.to_payload()

    # 2. Fall back to the MedlinePlus public search.
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            response = await client.get(
                _MEDLINE_URL,
                params={"db": "healthTopics", "term": query, "retmax": 1},
                headers={"User-Agent": "LokiDoki/0.2"},
            )
    except httpx.HTTPError as exc:
        return AdapterResult(
            output_text="I couldn't look up that symptom right now.",
            success=False, error=str(exc),
        ).to_payload()
    if response.status_code != 200:
        return AdapterResult(
            output_text="I couldn't look up that symptom right now.",
            success=False, error=f"http {response.status_code}",
        ).to_payload()
    data = response.json()
    docs = (((data.get("list") or {}).get("document")) or [])
    if not docs:
        return AdapterResult(
            output_text="I couldn't find symptom guidance for that query.",
            success=False, error="no results",
        ).to_payload()
    title = docs[0].get("title") or query
    url = docs[0].get("url") or "https://medlineplus.gov/"
    return AdapterResult(
        output_text=f"MedlinePlus topic: {title}.",
        success=True,
        mechanism_used="medlineplus",
        data=docs[0],
        source_url=url,
        source_title=f"MedlinePlus — {title}",
    ).to_payload()


async def check_medication(payload: dict[str, Any]) -> dict[str, Any]:
    query = str(
        (payload.get("params") or {}).get("name")
        or payload.get("chunk_text")
        or "",
    ).strip()
    if not query:
        return AdapterResult(
            output_text="Which medication would you like to check?",
            success=False, error="missing query",
        ).to_payload()

    # 1. Offline-first: MDWiki has drug monographs for most common meds.
    zim_result = await _zim_medical_lookup(query, hint="mdwiki")
    if zim_result is not None:
        return zim_result.to_payload()

    # 2. Fall back to RxNorm's public approximateTerm + allProperties.
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            approx = await client.get(
                _RX_APPROX_URL,
                params={"term": query, "maxEntries": 1},
                headers={"User-Agent": "LokiDoki/0.2"},
            )
            if approx.status_code != 200:
                return AdapterResult(
                    output_text="I couldn't look up that medication right now.",
                    success=False, error=f"http {approx.status_code}",
                ).to_payload()
            candidates = (((approx.json().get("approximateGroup") or {}).get("candidate")) or [])
            if not candidates:
                return AdapterResult(
                    output_text="I couldn't find that medication in RxNorm.",
                    success=False, error="no candidate",
                ).to_payload()
            rxcui = candidates[0].get("rxcui")
            props = await client.get(
                _RX_PROPS_URL.format(rxcui=rxcui),
                headers={"User-Agent": "LokiDoki/0.2"},
            )
            if props.status_code != 200:
                return AdapterResult(
                    output_text="I couldn't look up that medication right now.",
                    success=False, error=f"http {props.status_code}",
                ).to_payload()
            concepts = (((props.json().get("propConceptGroup") or {}).get("propConcept")) or [])
            if not concepts:
                return AdapterResult(
                    output_text="I couldn't find medication details for that term.",
                    success=False, error="no properties",
                ).to_payload()
            name = concepts[0].get("propValue") or query
    except httpx.HTTPError as exc:
        return AdapterResult(
            output_text="I couldn't look up that medication right now.",
            success=False, error=str(exc),
        ).to_payload()
    return AdapterResult(
        output_text=f"RxNorm match: {name}.",
        success=True,
        mechanism_used="rxnorm",
        data={"name": name, "rxcui": rxcui},
        source_url=f"https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm={rxcui}",
        source_title=f"RxNorm — {name}",
    ).to_payload()
