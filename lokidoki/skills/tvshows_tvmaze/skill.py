import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

TVMAZE_SEARCH_URL = "https://api.tvmaze.com/singlesearch/shows"
TVMAZE_EPISODES_URL = "https://api.tvmaze.com/shows/{show_id}/episodes"


class TVMazeSkill(BaseSkill):
    """Fetches TV show details and episodes from TVMaze public API."""

    def __init__(self):
        self._cache: dict[str, dict] = {}

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method == "tvmaze_api":
            return await self._tvmaze_api(parameters)
        elif method == "local_cache":
            return self._local_cache(parameters)
        raise ValueError(f"Unknown mechanism: {method}")

    async def _tvmaze_api(self, parameters: dict) -> MechanismResult:
        query = parameters.get("query")
        if not query:
            return MechanismResult(success=False, error="Query parameter required")

        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                response = await client.get(
                    TVMAZE_SEARCH_URL,
                    params={"q": query, "embed": "episodes"},
                )

            if response.status_code == 404:
                return MechanismResult(success=False, error="Show not found")
            if response.status_code != 200:
                return MechanismResult(success=False, error=f"TVMaze error: {response.status_code}")

            show = response.json()
            show_data = {
                "name": show.get("name", ""),
                "status": show.get("status", ""),
                "premiered": show.get("premiered", ""),
                "rating": show.get("rating", {}).get("average"),
                "genres": show.get("genres", []),
                "summary": (show.get("summary") or "").replace("<p>", "").replace("</p>", "").strip(),
                "network": (show.get("network") or {}).get("name", ""),
            }

            # Extract episodes if embedded
            episodes = []
            embedded = show.get("_embedded", {}).get("episodes", [])
            for ep in embedded[-10:]:  # last 10 episodes
                episodes.append({
                    "season": ep.get("season"),
                    "number": ep.get("number"),
                    "name": ep.get("name", ""),
                    "airdate": ep.get("airdate", ""),
                })
            show_data["recent_episodes"] = episodes

            self._cache[query.lower()] = show_data

            return MechanismResult(
                success=True,
                data=show_data,
                source_url=show.get("url", f"https://www.tvmaze.com/search?q={query}"),
                source_title=f"TVMaze - {show_data['name']}",
            )
        except Exception as e:
            return MechanismResult(success=False, error=str(e))

    def _local_cache(self, parameters: dict) -> MechanismResult:
        query = parameters.get("query", "").lower()
        cached = self._cache.get(query)
        if cached:
            return MechanismResult(success=True, data=cached)
        return MechanismResult(success=False, error="Cache miss")
