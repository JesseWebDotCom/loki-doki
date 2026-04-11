"""Translation adapter using MyMemory's public translation API."""
from __future__ import annotations

from typing import Any

import httpx

from v2.orchestrator.skills._runner import AdapterResult

_LANGS = {
    "french": "fr",
    "spanish": "es",
    "german": "de",
    "italian": "it",
    "portuguese": "pt",
    "japanese": "ja",
}


async def handle(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params") or {}
    text = str(params.get("text") or payload.get("chunk_text") or "").strip()
    target = str(params.get("target_lang") or "french").lower()
    lang = _LANGS.get(target, target[:2])
    if not text:
        return AdapterResult(output_text="Tell me what text to translate.", success=False, error="missing text").to_payload()
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            response = await client.get(
                "https://api.mymemory.translated.net/get",
                params={"q": text, "langpair": f"en|{lang}"},
                headers={"User-Agent": "LokiDoki/0.2"},
            )
    except httpx.HTTPError as exc:
        return AdapterResult(output_text="I couldn't translate that right now.", success=False, error=str(exc)).to_payload()
    if response.status_code != 200:
        return AdapterResult(output_text="I couldn't translate that right now.", success=False, error=f"http {response.status_code}").to_payload()
    translated = (response.json().get("responseData") or {}).get("translatedText")
    if not translated:
        return AdapterResult(output_text="I couldn't translate that right now.", success=False, error="missing translation").to_payload()
    return AdapterResult(output_text=f"{target.title()}: {translated}", success=True, mechanism_used="mymemory", data={"translated": translated, "target_lang": lang}).to_payload()
