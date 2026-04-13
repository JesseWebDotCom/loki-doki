"""currency adapters backed by Frankfurter ECB exchange rates."""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

import httpx

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.skills._runner import AdapterResult, run_mechanisms

API = "https://api.frankfurter.app/latest"

_CURRENCY_ALIASES = {
    "usd": "USD",
    "dollar": "USD",
    "dollars": "USD",
    "us dollar": "USD",
    "eur": "EUR",
    "euro": "EUR",
    "euros": "EUR",
    "gbp": "GBP",
    "pound": "GBP",
    "pounds": "GBP",
    "british pound": "GBP",
    "jpy": "JPY",
    "yen": "JPY",
    "cad": "CAD",
    "canadian dollar": "CAD",
    "aud": "AUD",
    "australian dollar": "AUD",
}


@dataclass(slots=True)
class _FrankfurterSkill:
    async def execute_mechanism(self, method: str, parameters: dict[str, Any]) -> MechanismResult:
        if method != "frankfurter_latest":
            raise ValueError(f"Unknown mechanism: {method}")
        base = str(parameters.get("from_currency") or "").upper()
        target = str(parameters.get("to_currency") or "").upper()
        amount = parameters.get("amount")
        query = {"from": base, "to": target}
        if amount is not None:
            query["amount"] = amount
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(API, params=query, headers={"User-Agent": "LokiDoki/0.2"})
        except httpx.HTTPError as exc:
            return MechanismResult(success=False, error=f"network error: {exc}")
        if response.status_code != 200:
            return MechanismResult(success=False, error=f"http {response.status_code}")
        try:
            payload = response.json()
        except ValueError as exc:
            return MechanismResult(success=False, error=f"bad json: {exc}")
        rates = payload.get("rates") or {}
        if target not in rates:
            return MechanismResult(success=False, error=f"missing rate for {target}")
        rate = float(rates[target])
        converted_amount = float(amount) * rate if amount is not None else None
        return MechanismResult(
            success=True,
            data={
                "base": base,
                "target": target,
                "rate": rate,
                "amount": amount,
                "converted_amount": converted_amount,
                "date": payload.get("date") or "",
            },
            source_url=str(response.request.url),
            source_title=f"Frankfurter {base}->{target}",
        )


_SKILL = _FrankfurterSkill()


def _find_currency_codes(text: str) -> list[str]:
    lower = text.lower()
    found: list[tuple[int, str]] = []
    for alias, code in sorted(_CURRENCY_ALIASES.items(), key=lambda item: len(item[0]), reverse=True):
        idx = lower.find(alias)
        if idx >= 0:
            found.append((idx, code))
    found.sort(key=lambda item: item[0])
    out: list[str] = []
    for _, code in found:
        if code not in out:
            out.append(code)
    return out


def _parse_convert_request(payload: dict[str, Any]) -> tuple[float, str, str] | None:
    explicit = payload.get("params") or {}
    if explicit.get("amount") and explicit.get("from") and explicit.get("to"):
        try:
            return float(explicit["amount"]), str(explicit["from"]).upper(), str(explicit["to"]).upper()
        except (TypeError, ValueError):
            return None
    text = str(payload.get("chunk_text") or "")
    amount_match = re.search(r"(-?\d+(?:\.\d+)?)", text.replace(",", ""))
    codes = _find_currency_codes(text)
    if not amount_match or len(codes) < 2:
        return None
    return float(amount_match.group(1)), codes[0], codes[1]


def _parse_rate_request(payload: dict[str, Any]) -> tuple[str, str] | None:
    explicit = payload.get("params") or {}
    if explicit.get("from") and explicit.get("to"):
        return str(explicit["from"]).upper(), str(explicit["to"]).upper()
    codes = _find_currency_codes(str(payload.get("chunk_text") or ""))
    if len(codes) < 2:
        return None
    return codes[0], codes[1]


def _format_amount(value: float | int | None) -> str:
    if value is None:
        return ""
    if float(value).is_integer():
        return str(int(value))
    return f"{float(value):.2f}".rstrip("0").rstrip(".")


async def convert_currency(payload: dict[str, Any]) -> dict[str, Any]:
    parsed = _parse_convert_request(payload)
    if parsed is None:
        return AdapterResult(
            output_text="I couldn't parse that currency conversion.",
            success=False,
            error="missing amount/from/to",
        ).to_payload()
    amount, from_currency, to_currency = parsed
    result = await run_mechanisms(
        _SKILL,
        [("frankfurter_latest", {"amount": amount, "from_currency": from_currency, "to_currency": to_currency})],
        on_success=lambda mechanism_result, method: (
            f"{_format_amount(mechanism_result.data.get('amount'))} {from_currency} = "
            f"{_format_amount(mechanism_result.data.get('converted_amount'))} {to_currency} "
            f"at a rate of {_format_amount(mechanism_result.data.get('rate'))} on "
            f"{mechanism_result.data.get('date')}."
        ),
        on_all_failed="I couldn't look up that exchange rate right now.",
    )
    return result.to_payload()


async def get_exchange_rate(payload: dict[str, Any]) -> dict[str, Any]:
    parsed = _parse_rate_request(payload)
    if parsed is None:
        return AdapterResult(
            output_text="I couldn't parse that exchange-rate request.",
            success=False,
            error="missing from/to",
        ).to_payload()
    from_currency, to_currency = parsed
    result = await run_mechanisms(
        _SKILL,
        [("frankfurter_latest", {"from_currency": from_currency, "to_currency": to_currency})],
        on_success=lambda mechanism_result, method: (
            f"1 {from_currency} = {_format_amount(mechanism_result.data.get('rate'))} "
            f"{to_currency} on {mechanism_result.data.get('date')}."
        ),
        on_all_failed="I couldn't look up that exchange rate right now.",
    )
    return result.to_payload()


__all__ = ["convert_currency", "get_exchange_rate"]
