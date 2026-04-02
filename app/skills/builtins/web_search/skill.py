"""Built-in web search skill."""

from __future__ import annotations

from typing import Any

from app.skills.base import BaseSkill
from app.skills.local_runtime import parse_search_context
from app.subsystems.text.web_search import SEARCH_EMPTY, SEARCH_ERROR, search_web


class WebSearchSkill(BaseSkill):
    """Search the web through the existing local web-search helper."""

    manifest: dict[str, Any] = {}

    async def execute(self, action: str, ctx: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        """Execute the requested search action."""
        del ctx
        self.validate_action(action)
        if action != "search":
            raise ValueError(f"Unhandled action: {action}")
        query = str(kwargs.get("query", "")).strip()
        num_results = int(kwargs.get("num_results", 5) or 5)
        result = search_web(query)
        if result.context in {SEARCH_EMPTY, SEARCH_ERROR}:
            return {
                "ok": False,
                "skill": "web_search",
                "action": "search",
                "data": {"query": query, "results": []},
                "meta": {"source": result.source},
                "presentation": {"type": "search_results"},
                "errors": ["Search results are unavailable right now."],
            }
        items = parse_search_context(result.context, source=result.source, max_results=num_results)
        return {
            "ok": True,
            "skill": "web_search",
            "action": "search",
            "data": {
                "query": result.query,
                "results": items,
            },
            "meta": {"source": result.source, "cache_hit": False},
            "presentation": {
                "type": "search_results",
                "max_voice_items": 1,
                "max_screen_items": num_results,
            },
            "errors": [],
        }
