# Chunk 3 — Retrofit sourced skills via adapters

## Goal

Bring the source-heavy skills online: `knowledge` (Wikipedia), `search` (DuckDuckGo), `news` (RSS), `weather_openmeteo`. These skills produce citations and freshness-sensitive facts, so they exercise every non-trivial `AdapterOutput` field (`facts`, `sources`, `follow_up_candidates`) and make the shared `Source` model do real work.

## Files

- `lokidoki/orchestrator/adapters/knowledge.py` — new.
- `lokidoki/orchestrator/adapters/search.py` — new.
- `lokidoki/orchestrator/adapters/news.py` — new.
- `lokidoki/orchestrator/adapters/weather_openmeteo.py` — new.
- `lokidoki/orchestrator/adapters/__init__.py` — register the four new adapters.
- `tests/unit/test_adapters_sourced.py` — new.

Read-only: `lokidoki/skills/knowledge/skill.py`, `lokidoki/skills/search/skill.py`, `lokidoki/skills/news/skill.py`, `lokidoki/skills/weather_openmeteo/skill.py`, `lokidoki/orchestrator/adapters/base.py`, prior adapters as reference.

## Actions

1. **`WikipediaAdapter`** (`skill_id = "knowledge"`):
   - `summary_candidates`: one string from the skill's extract/summary field.
   - `facts`: up to 5 short bullets parsed from the article's lead if the skill provides them; otherwise empty.
   - `sources`: one `Source(title=<page title>, url=<wikipedia url>, kind="web", snippet=<first sentence of extract>)`.
   - `follow_up_candidates`: `("See related topics",)` only if the skill surfaces a related-topics list.

2. **`DuckDuckGoAdapter`** (`skill_id = "search"`):
   - `summary_candidates`: optional — only populate if the skill returns an abstract/instant-answer. Otherwise empty.
   - `sources`: one `Source` per result, up to 8. Fields: `title`, `url`, `kind="web"`, `snippet` from the result preview, `relevance` from the skill's ranking if available.
   - `follow_up_candidates`: derive from search suggestions the skill returns, up to 3; skip entirely if the skill doesn't provide them (do not fabricate).

3. **`NewsAdapter`** (`skill_id = "news"`):
   - `summary_candidates`: one string combining the top-article headline + one-sentence summary.
   - `facts`: one per top-5 headline.
   - `sources`: one per article (`title`, `url`, `kind="web"`, `snippet`, `published_at`, `author`).
   - `follow_up_candidates`: empty — news pages don't generate useful follow-ups mechanically.

4. **`OpenMeteoAdapter`** (`skill_id = "weather_openmeteo"`):
   - `summary_candidates`: one string (`"Currently 68°F in Oakland, sunny; 75°F high, 58°F low"`).
   - `facts`: `("Current: 68°F", "High: 75°F", "Low: 58°F", "Precipitation: 0%")` built deterministically from the skill payload.
   - `sources`: one `Source(title="Open-Meteo", url="https://open-meteo.com", kind="web")`. URL is constant attribution, allowed because this is a bootstrap-configured dependency, not a runtime CDN.
   - `follow_up_candidates`: `("Show the 7-day forecast", "Show hourly")` only if the skill returned the data to back them up.

5. **Register all four** in `adapters/__init__.py`.

6. **Tests** — for each adapter:
   - Happy path with a realistic fixture payload.
   - Empty/malformed data — returns empty `AdapterOutput(raw=data)` without raising.
   - Source list length capped at the documented limits (8 for search, 5 for news).
   - No fabricated URLs: if the fixture omits `url`, the adapter must not invent one.

7. **Grep invariant**: no adapter may import from `frontend/`, `lokidoki/orchestrator/synthesis` (future), or `lokidoki/orchestrator/blocks` (future). Adapters are pure transforms.

## Verify

```
pytest tests/unit/test_adapters_sourced.py tests/unit/test_adapter_framework.py tests/unit/test_adapters_simple.py -v
```

All tests pass.

## Commit message

```
feat(adapters): retrofit knowledge, search, news, weather_openmeteo

Four source-heavy skills now emit normalized AdapterOutput with
populated Source objects, facts, and follow-up candidates. The
shared Source model now sees real traffic across web/news/weather
payloads.

Refs docs/rich-response/PLAN.md chunk 3.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
