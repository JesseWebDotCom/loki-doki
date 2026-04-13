"""Live stock market adapters using Yahoo Finance quote endpoints."""
from __future__ import annotations

import re
from typing import Any

import httpx

from v2.orchestrator.skills._runner import AdapterResult

_URL = "https://query1.finance.yahoo.com/v7/finance/quote"


def _extract_ticker(payload: dict[str, Any]) -> str:
    """Read the ticker from structured params (NER-derived in C05).

    Falls back to regex on chunk_text only for uppercase ticker symbols
    (e.g. "AAPL") which spaCy tags as ORG and the derivation pipeline
    maps to the ``ticker`` param. The company-name alias table remains
    as a safety net for common names the NER might miss.
    """
    params = payload.get("params") or {}
    if params.get("ticker"):
        return str(params["ticker"]).upper()
    # Ticker symbols are machine-recognizable patterns (\b[A-Z]{1,5}\b),
    # fine to regex per CLAUDE.md.
    text = str(payload.get("chunk_text") or "")
    match = re.search(r"\b[A-Z]{1,5}\b", text)
    if match:
        return match.group(0)
    return ""


async def _quote(ticker: str) -> dict[str, Any] | None:
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(_URL, params={"symbols": ticker}, headers={"User-Agent": "LokiDoki/0.2"})
    if response.status_code != 200:
        return None
    results = (response.json().get("quoteResponse") or {}).get("result") or []
    return results[0] if results else None


async def get_stock_price(payload: dict[str, Any]) -> dict[str, Any]:
    ticker = _extract_ticker(payload)
    if not ticker:
        return AdapterResult(output_text="Tell me which ticker to look up.", success=False, error="missing ticker").to_payload()
    quote = await _quote(ticker)
    if quote is None:
        return AdapterResult(output_text="I couldn't look up that stock price right now.", success=False, error="missing quote").to_payload()
    price = quote.get("regularMarketPrice")
    currency = quote.get("currency") or "USD"
    name = quote.get("shortName") or ticker
    return AdapterResult(
        output_text=f"{name} ({ticker}) is at {price} {currency}.",
        success=True,
        mechanism_used="yahoo_quote",
        data=quote,
        source_url=f"https://finance.yahoo.com/quote/{ticker}",
        source_title=f"Yahoo Finance — {ticker}",
    ).to_payload()


async def get_stock_info(payload: dict[str, Any]) -> dict[str, Any]:
    ticker = _extract_ticker(payload)
    if not ticker:
        return AdapterResult(output_text="Tell me which ticker to look up.", success=False, error="missing ticker").to_payload()
    quote = await _quote(ticker)
    if quote is None:
        return AdapterResult(output_text="I couldn't look up that stock right now.", success=False, error="missing quote").to_payload()
    name = quote.get("shortName") or ticker
    exchange = quote.get("fullExchangeName") or quote.get("exchange")
    market_cap = quote.get("marketCap")
    industry_hint = quote.get("quoteType") or "equity"
    return AdapterResult(
        output_text=f"{name} ({ticker}) trades on {exchange}. Market cap: {market_cap}. Type: {industry_hint}.",
        success=True,
        mechanism_used="yahoo_quote",
        data=quote,
        source_url=f"https://finance.yahoo.com/quote/{ticker}",
        source_title=f"Yahoo Finance — {ticker}",
    ).to_payload()
