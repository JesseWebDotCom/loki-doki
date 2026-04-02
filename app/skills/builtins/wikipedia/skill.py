"""Built-in Wikipedia lookup skill."""

from __future__ import annotations

import re
from typing import Any

import httpx
from bs4 import BeautifulSoup

from app.skills.base import BaseSkill


class WikipediaSkill(BaseSkill):
    """Fetch Wikipedia summaries and infobox details through the built-in skill runtime."""

    manifest: dict[str, Any] = {}

    async def execute(self, action: str, ctx: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        """Execute the requested Wikipedia lookup action."""
        del ctx
        self.validate_action(action)
        if action != "lookup_article":
            raise ValueError(f"Unhandled action: {action}")

        query = str(kwargs.get("query", "")).strip()
        if not query:
            return {
                "ok": False,
                "skill": "wikipedia",
                "action": action,
                "data": {"query": "", "results": []},
                "meta": {"source": "wikipedia"},
                "presentation": {"type": "wikipedia_summary"},
                "errors": ["No query provided for Wikipedia lookup."],
            }
        return await self._lookup_article(query, action=action)

    async def _lookup_article(self, query: str, *, action: str) -> dict[str, Any]:
        formatted_query = query.replace(" ", "_")
        summary_url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{formatted_query}"
        async with httpx.AsyncClient(follow_redirects=True, timeout=8.0) as client:
            try:
                response = await client.get(summary_url)
            except httpx.RequestError as exc:
                return self._failure(query, action, f"Wikipedia request failed: {exc}")

            if response.status_code != 200:
                return self._failure(query, action, f"Could not find a specific Wikipedia article for '{query}'.")

            payload = response.json()
            if payload.get("type") == "disambiguation":
                return self._failure(query, action, f"Could not find a specific Wikipedia article for '{query}'.")

            page_url = str(payload.get("content_urls", {}).get("desktop", {}).get("page", "")).strip()
            infobox = await self._fetch_infobox(client, page_url) if page_url else {}
            clean_data = {
                "title": str(payload.get("title") or query).strip(),
                "description": str(payload.get("description") or "").strip(),
                "extract": str(payload.get("extract") or "").strip(),
                "page_url": page_url,
                "thumbnail": _thumbnail_payload(payload),
                "infobox": infobox,
            }
            return {
                "ok": True,
                "skill": "wikipedia",
                "action": action,
                "data": clean_data,
                "meta": {"source": "wikipedia", "cache_hit": False},
                "presentation": {
                    "type": "wikipedia_summary",
                    "max_voice_items": 1,
                    "max_screen_items": 1,
                    "speak_priority_fields": ["title", "extract"],
                },
                "errors": [],
            }

    async def _fetch_infobox(self, client: httpx.AsyncClient, page_url: str) -> dict[str, str]:
        """Return a cleaned infobox payload when the page has one."""
        try:
            response = await client.get(page_url)
        except httpx.RequestError:
            return {}
        if response.status_code != 200:
            return {}
        return _scrape_infobox(response.text)

    def _failure(self, query: str, action: str, detail: str) -> dict[str, Any]:
        """Return one normalized failure payload."""
        return {
            "ok": False,
            "skill": "wikipedia",
            "action": action,
            "data": {"query": query, "results": []},
            "meta": {"source": "wikipedia"},
            "presentation": {"type": "wikipedia_summary"},
            "errors": [detail],
        }


def _thumbnail_payload(payload: dict[str, Any]) -> dict[str, str]:
    """Return one normalized thumbnail payload."""
    source = str(payload.get("thumbnail", {}).get("source", "")).strip()
    return {"url": source} if source else {}


def _scrape_infobox(html: str) -> dict[str, str]:
    """Parse the right-column Wikipedia infobox into a clean dictionary."""
    soup = BeautifulSoup(html, "html.parser")
    infobox = soup.find("table", {"class": "infobox"})
    if not infobox:
        return {}

    for hidden in infobox.find_all(["sup", "span", "div", "style"]):
        classes = hidden.get("class", [])
        if any(item in ["reference", "noprint", "metadata"] for item in classes):
            hidden.decompose()
            continue
        if hidden.has_attr("style") and "display:none" in hidden.get("style", "").replace(" ", ""):
            hidden.decompose()

    for line_break in infobox.find_all("br"):
        line_break.replace_with(", ")
    for list_item in infobox.find_all("li"):
        list_item.insert_after(", ")
        list_item.unwrap()

    parsed: dict[str, str] = {}
    for row in infobox.find_all("tr"):
        label = row.find("th", {"class": "infobox-label"})
        value = row.find("td", {"class": "infobox-data"})
        if not label or not value:
            continue
        key = re.sub(r"\[.*?\]", "", label.get_text(separator=" ", strip=True)).strip()
        cleaned_value = re.sub(r"\[.*?\]", "", value.get_text(separator=", ", strip=True)).strip(", ")
        cleaned_value = re.sub(r",\s*,", ",", cleaned_value).strip(", ")
        if key and cleaned_value:
            parsed[key] = cleaned_value
    return parsed
