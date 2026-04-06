import httpx

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

TMDB_SEARCH_URL = "https://api.themoviedb.org/3/search/movie"
TMDB_DETAIL_URL = "https://api.themoviedb.org/3/movie/{movie_id}"


class TMDBSkill(BaseSkill):
    """Fetches movie details from The Movie Database (TMDB) API."""

    def __init__(self, api_key: str = ""):
        self._api_key = api_key
        self._cache: dict[str, dict] = {}

    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method == "tmdb_api":
            return await self._tmdb_api(parameters)
        elif method == "local_cache":
            return self._local_cache(parameters)
        raise ValueError(f"Unknown mechanism: {method}")

    async def _tmdb_api(self, parameters: dict) -> MechanismResult:
        query = parameters.get("query")
        if not query:
            return MechanismResult(success=False, error="Query parameter required")
        if not self._api_key:
            return MechanismResult(success=False, error="TMDB API key not configured")

        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                response = await client.get(
                    TMDB_SEARCH_URL,
                    params={"api_key": self._api_key, "query": query},
                )

            if response.status_code != 200:
                return MechanismResult(success=False, error=f"TMDB error: {response.status_code}")

            results = response.json().get("results", [])
            if not results:
                return MechanismResult(success=False, error="No movies found")

            movie = results[0]
            movie_data = {
                "title": movie.get("title", ""),
                "release_date": movie.get("release_date", ""),
                "overview": movie.get("overview", ""),
                "rating": movie.get("vote_average"),
                "vote_count": movie.get("vote_count"),
            }

            self._cache[query.lower()] = movie_data
            movie_id = movie.get("id", "")

            return MechanismResult(
                success=True,
                data=movie_data,
                source_url=f"https://www.themoviedb.org/movie/{movie_id}",
                source_title=f"TMDB - {movie_data['title']}",
            )
        except Exception as e:
            return MechanismResult(success=False, error=str(e))

    def _local_cache(self, parameters: dict) -> MechanismResult:
        query = parameters.get("query", "").lower()
        cached = self._cache.get(query)
        if cached:
            return MechanismResult(success=True, data=cached)
        return MechanismResult(success=False, error="Cache miss")
