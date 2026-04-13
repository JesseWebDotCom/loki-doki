"""Offline-first visa information adapter.

Country-pair lookup for the largest passport corridors.
Mechanism chain: ``local_visa_kb`` → ``graceful_failure``.
"""
from __future__ import annotations

import re
from typing import Any

from lokidoki.orchestrator.skills._runner import AdapterResult
from lokidoki.orchestrator.skills.travel_flights import _normalize


_VISA_KB: dict[tuple[str, str], str] = {
    ("us", "schengen"): "Visa-free for stays up to 90 days within any 180-day period (ETIAS pre-authorization required from 2025).",
    ("us", "uk"): "Visa-free for stays up to 6 months; ETA pre-authorization required from 2025.",
    ("us", "japan"): "Visa-free for stays up to 90 days as a tourist.",
    ("us", "canada"): "Visa-free; eTA required only when flying in.",
    ("us", "mexico"): "Visa-free for stays up to 180 days; FMM required.",
    ("us", "china"): "Visa required for most stays; 144-hour transit visa-free in select cities.",
    ("us", "india"): "e-Visa required for tourism (apply online before travel).",
    ("us", "brazil"): "Visa-free for stays up to 90 days (e-Visa required from April 2025).",
    ("us", "australia"): "ETA (subclass 601) required for stays up to 3 months.",
    ("us", "thailand"): "Visa-free for stays up to 60 days (as of 2024).",
    ("uk", "us"): "ESTA required under the Visa Waiver Program (90-day max stay).",
    ("uk", "schengen"): "Visa-free for stays up to 90 days within any 180-day period (ETIAS from 2025).",
    ("uk", "japan"): "Visa-free for stays up to 90 days.",
    ("eu", "us"): "ESTA required under the Visa Waiver Program (90-day max stay).",
    ("eu", "uk"): "Visa-free for stays up to 6 months; ETA from 2025.",
    ("eu", "japan"): "Visa-free for stays up to 90 days.",
    ("canada", "us"): "Visa-free; passport (or NEXUS) required at the border.",
    ("canada", "schengen"): "Visa-free for stays up to 90 days; ETIAS from 2025.",
    ("india", "us"): "B1/B2 tourist visa required.",
    ("india", "schengen"): "Schengen visa required.",
    ("china", "us"): "B1/B2 tourist visa required.",
    ("japan", "us"): "ESTA required under the Visa Waiver Program (90-day max stay).",
}

_PASSPORTS: dict[str, str] = {
    "american": "us", "us": "us", "usa": "us", "united states": "us",
    "british": "uk", "uk": "uk", "united kingdom": "uk", "english": "uk",
    "european": "eu", "eu": "eu", "schengen": "eu",
    "canadian": "canada", "canada": "canada",
    "indian": "india", "india": "india",
    "chinese": "china", "china": "china",
    "japanese": "japan", "japan": "japan",
}

_DESTINATIONS: dict[str, str] = {
    "schengen": "schengen", "eu": "schengen", "europe": "schengen",
    "france": "schengen", "germany": "schengen", "italy": "schengen", "spain": "schengen", "netherlands": "schengen",
    "uk": "uk", "england": "uk", "britain": "uk", "united kingdom": "uk",
    "us": "us", "usa": "us", "united states": "us", "america": "us",
    "japan": "japan", "tokyo": "japan",
    "canada": "canada", "toronto": "canada",
    "mexico": "mexico", "cancun": "mexico",
    "china": "china", "beijing": "china",
    "india": "india",
    "brazil": "brazil",
    "australia": "australia",
    "thailand": "thailand",
}

_PASSPORT_PATTERN = re.compile(
    r"\b(american|us|usa|united states|british|uk|english|european|eu|schengen|"
    r"canadian|canada|indian|india|chinese|china|japanese)\s+(?:citizen|national|passport)\b",
    re.IGNORECASE,
)


def _resolve_visa_pair(payload: dict[str, Any]) -> tuple[str | None, str | None]:
    params = payload.get("params") or {}
    passport = params.get("passport")
    dest = params.get("destination")
    if passport and dest:
        return _PASSPORTS.get(_normalize(passport)), _DESTINATIONS.get(_normalize(dest))

    text = _normalize(payload.get("chunk_text") or "")
    found_passport: str | None = None
    remaining = text

    match = _PASSPORT_PATTERN.search(text)
    if match:
        found_passport = _PASSPORTS.get(match.group(1).lower())
        remaining = (text[: match.start()] + " " + text[match.end():]).strip()

    found_dest: str | None = None
    for needle, code in _DESTINATIONS.items():
        if re.search(rf"\b{re.escape(needle)}\b", remaining):
            found_dest = code
            break

    if not found_passport:
        scan_text = remaining
        if found_dest:
            for needle, code in _DESTINATIONS.items():
                if code == found_dest:
                    scan_text = re.sub(rf"\b{re.escape(needle)}\b", " ", scan_text)
        for needle, code in _PASSPORTS.items():
            if re.search(rf"\b{re.escape(needle)}\b", scan_text):
                found_passport = code
                break

    return found_passport, found_dest


def get_visa_info(payload: dict[str, Any]) -> dict[str, Any]:
    passport, dest = _resolve_visa_pair(payload)
    if not passport or not dest:
        return AdapterResult(
            output_text="Tell me both a passport country and a destination so I can look up visa requirements.",
            success=False,
            mechanism_used="local_visa_kb",
            error="missing pair",
        ).to_payload()
    info = _VISA_KB.get((passport, dest))
    if not info:
        return AdapterResult(
            output_text=(
                f"I don't have curated visa info for a {passport.upper()} passport going to {dest.title()}. "
                "Check the destination's official consulate page for the latest rules."
            ),
            success=False,
            mechanism_used="local_visa_kb",
            error="unknown pair",
            data={"passport": passport, "destination": dest},
        ).to_payload()
    return AdapterResult(
        output_text=f"For a {passport.upper()} passport traveling to {dest.title()}: {info}",
        success=True,
        mechanism_used="local_visa_kb",
        data={"passport": passport, "destination": dest, "requirement": info},
    ).to_payload()
