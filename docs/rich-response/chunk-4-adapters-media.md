# Chunk 4 — Retrofit media-heavy skills via adapters

## Goal

Adapt the remaining skills — `movies_fandango`, `movies_tmdb`, `movies_wiki`, `recipes`, `tvshows`, `people_lookup`, `youtube`, `smarthome_mock`, plus any others present — so every skill in the codebase produces `AdapterOutput`. These are the media-heavy / multi-card skills, so they exercise the `media` and `artifact_candidates` fields. After this chunk, `resolve_adapter(skill_id)` returns a real adapter for every registered skill.

## Files

- `lokidoki/orchestrator/adapters/movies_fandango.py` — new.
- `lokidoki/orchestrator/adapters/movies_tmdb.py` — new.
- `lokidoki/orchestrator/adapters/movies_wiki.py` — new.
- `lokidoki/orchestrator/adapters/recipes.py` — new.
- `lokidoki/orchestrator/adapters/tvshows.py` — new.
- `lokidoki/orchestrator/adapters/people_lookup.py` — new.
- `lokidoki/orchestrator/adapters/youtube.py` — new.
- `lokidoki/orchestrator/adapters/smarthome_mock.py` — new (discovered during the skills-dir sweep this chunk requires).
- `lokidoki/orchestrator/adapters/__init__.py` — register the eight new adapters.
- `tests/unit/test_adapters_media.py` — new.

Read-only: each skill's `skill.py`, `lokidoki/orchestrator/media/augmentor.py` (for the youtube media-card shape), prior adapters as reference.

## Actions

Before starting, `ls lokidoki/skills/` and confirm every skill directory has a corresponding adapter after this chunk. If a skill exists that isn't in the list above, add it here (update `## Files` and this list, don't push it to a later chunk).

1. **`FandangoShowtimesAdapter`** (`skill_id = "movies_fandango"`):
   - `summary_candidates`: short phrasing (`"3 showings of Dune Part Two near you tonight"`).
   - `facts`: one per showing (theater, time, format).
   - `sources`: one `Source(title=<theater name + movie>, url=<showtime url>, kind="web")` per showing.
   - `media`: empty — showtimes are text-first.
   - `follow_up_candidates`: `("Show tomorrow", "Filter by IMAX")` only if backed by data.

2. **`TMDBAdapter`** (`skill_id = "movies_tmdb"`):
   - `summary_candidates`: one paragraph overview.
   - `facts`: release year, runtime, rating, top 2 cast members.
   - `sources`: one `Source(title="TMDB: <title>", url=<tmdb url>, kind="web")`.
   - `media`: a `kind: "poster"` dict if the skill returned a poster URL (shape TBD — use the same dict discriminator pattern `augment_with_media` uses today; include the URL as-is, offline-safety is enforced at render time in chunk 11).

3. **`WikiMoviesAdapter`** (`skill_id = "movies_wiki"`):
   - Same as `WikipediaAdapter` in shape; `sources` point to the movie's wiki page.

4. **`RecipeMealDBAdapter`** (`skill_id = "recipes"`):
   - `summary_candidates`: recipe title + one-line description.
   - `facts`: ingredient list (up to 12) + cooking time + cuisine.
   - `sources`: one `Source(title="MealDB: <recipe>", url=<recipe url>, kind="web")`.
   - `actions`: `({"kind": "print_recipe", "recipe_id": ...},)` as a future-shape placeholder; no consumer reads this yet.

5. **`TVMazeAdapter`** (`skill_id = "tvshows"`):
   - Similar to TMDB — overview, facts (seasons, status, genre, network), one source.

6. **`PeopleLookupAdapter`** (`skill_id = "people_lookup"`):
   - `summary_candidates`: one short bio-like sentence.
   - `facts`: role/occupation, notable works, years active.
   - `sources`: whichever source the skill cited.

7. **`YouTubeAdapter`** (`skill_id = "youtube"`):
   - `summary_candidates`: empty — for youtube the media is the payload, not the prose.
   - `media`: pass through the existing `MediaCard` discriminator shape (`kind: "youtube_video"` / `kind: "youtube_channel"`) unchanged. The shape is already canonical in `frontend/src/lib/api-types.ts:88`; do not invent a new shape.
   - `sources`: one `Source(title=<video/channel>, url=<youtube url>, kind="web")` per item.
   - `follow_up_candidates`: `("Show more like this",)` only if the skill returned related items.

8. **Register all seven** in `adapters/__init__.py`.

9. **Coverage invariant**: add a single test `test_all_skills_have_adapters` that iterates over `os.listdir("lokidoki/skills/")` (skipping `__pycache__`, `__init__.py`, and any test fixtures) and asserts `resolve_adapter(skill_id)` returns a non-`None` adapter for each.

10. **Tests** — per adapter: happy path + empty/malformed input + media passthrough preserves the `kind` discriminator exactly.

## Verify

```
pytest tests/unit/test_adapters_media.py tests/unit/test_adapters_simple.py tests/unit/test_adapters_sourced.py tests/unit/test_adapter_framework.py -v
```

All tests pass, including `test_all_skills_have_adapters`.

## Commit message

```
feat(adapters): retrofit movies/tv/recipes/people/youtube skills

Every skill in lokidoki/skills/ now emits AdapterOutput. The media
field preserves the existing MediaCard discriminator shape so the
UI keeps rendering the same cards while the rest of the payload
becomes consumable by the upcoming block planner.

A coverage test enforces that every future skill ships with an
adapter.

Refs docs/rich-response/PLAN.md chunk 4.
```

## Deferrals

<!-- Append specifics here if this chunk surfaced work that belongs in a later chunk. -->
