"""Dictionary skill — dictionaryapi.dev (free, no key)."""
from __future__ import annotations

import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

API = "https://api.dictionaryapi.dev/api/v2/entries/en/{word}"


class DictionarySkill(BaseSkill):
    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method != "dictionaryapi_dev":
            raise ValueError(f"Unknown mechanism: {method}")
        word = (parameters.get("word") or parameters.get("query") or "").strip()
        if not word:
            return MechanismResult(success=False, error="no word provided")
        url = API.format(word=httpx.QueryParams({"w": word}).get("w"))
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                resp = await client.get(url)
        except httpx.HTTPError as exc:
            return MechanismResult(success=False, error=f"network error: {exc}")
        if resp.status_code == 404:
            return MechanismResult(success=False, error=f"no definition found for '{word}'")
        if resp.status_code != 200:
            return MechanismResult(success=False, error=f"http {resp.status_code}")
        try:
            payload = resp.json()
        except ValueError:
            return MechanismResult(success=False, error="malformed response")
        if not payload or not isinstance(payload, list):
            return MechanismResult(success=False, error="empty response")
        entry = payload[0]
        meanings = []
        for m in entry.get("meanings", [])[:3]:
            defs = [d.get("definition", "") for d in m.get("definitions", [])[:2]]
            meanings.append({"part_of_speech": m.get("partOfSpeech", ""), "definitions": defs})
        phonetic = entry.get("phonetic") or next(
            (p.get("text") for p in entry.get("phonetics", []) if p.get("text")),
            "",
        )
        return MechanismResult(
            success=True,
            data={"word": entry.get("word", word), "phonetic": phonetic, "meanings": meanings},
            source_url=f"https://dictionaryapi.dev/",
            source_title="dictionaryapi.dev",
        )
