from __future__ import annotations

import os

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters import resolve_adapter
from lokidoki.orchestrator.adapters.movies_fandango import FandangoShowtimesAdapter
from lokidoki.orchestrator.adapters.movies_tmdb import TMDBAdapter
from lokidoki.orchestrator.adapters.movies_wiki import WikiMoviesAdapter
from lokidoki.orchestrator.adapters.people_lookup import PeopleLookupAdapter
from lokidoki.orchestrator.adapters.recipes import RecipeMealDBAdapter
from lokidoki.orchestrator.adapters.smarthome_mock import SmartHomeMockAdapter
from lokidoki.orchestrator.adapters.tvshows import TVMazeAdapter
from lokidoki.orchestrator.adapters.youtube import YouTubeAdapter


SKILLS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "lokidoki",
    "skills",
)


# ---- movies_fandango ----------------------------------------------------


def test_fandango_adapter_happy_path_showtimes():
    data = {
        "location": "98101",
        "date": "2026-04-21",
        "lead": "3 showings of Dune Part Two near you tonight",
        "showtimes": [
            {
                "title": "Dune Part Two",
                "slug": "dune-part-two",
                "url": "https://fandango.example/dune-part-two",
                "theaters": [
                    {"name": "Starlight Seattle 14", "times": ["6:00 PM", "7:30 PM"]},
                ],
                "snippet": "Starlight Seattle 14: 6:00 PM, 7:30 PM",
            },
            {
                "title": "Rogue Squadron",
                "slug": "rogue-squadron",
                "url": "https://fandango.example/rogue-squadron",
                "theaters": [
                    {"name": "Galaxy Cinemas", "times": ["8:15 PM"]},
                ],
                "snippet": "Galaxy Cinemas: 8:15 PM",
            },
        ],
    }
    output = FandangoShowtimesAdapter().adapt(MechanismResult(success=True, data=data))
    assert output.summary_candidates == ("3 showings of Dune Part Two near you tonight",)
    assert output.facts[0].startswith("Dune Part Two — Starlight Seattle 14")
    assert len(output.sources) == 2
    assert output.sources[0].url == "https://fandango.example/dune-part-two"
    assert output.media == ()


def test_fandango_adapter_gracefully_handles_empty_data():
    output = FandangoShowtimesAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.summary_candidates == ()
    assert output.raw == {}


def test_fandango_adapter_movie_overview_shape():
    data = {
        "title": "Rogue Squadron",
        "lead": "Rogue Squadron — PG-13 · 128 min",
        "slug": "rogue-squadron",
    }
    output = FandangoShowtimesAdapter().adapt(
        MechanismResult(
            success=True,
            data=data,
            source_url="https://fandango.example/rogue-squadron/movie-overview",
        )
    )
    assert output.summary_candidates == ("Rogue Squadron — PG-13 · 128 min",)
    assert output.sources[0].url == "https://fandango.example/rogue-squadron/movie-overview"


# ---- movies_tmdb --------------------------------------------------------


def test_tmdb_adapter_happy_path_with_poster():
    output = TMDBAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "title": "Rogue Squadron",
                "release_date": "2026-05-15",
                "overview": "A band of pilots defends the galaxy.",
                "rating": 7.9,
                "runtime": 128,
                "cast": ["Leia Organa", "Luke Skywalker", "Han Solo"],
                "poster_path": "/abc123.jpg",
            },
            source_url="https://www.themoviedb.org/movie/42",
            source_title="TMDB - Rogue Squadron",
        )
    )
    assert output.summary_candidates == ("A band of pilots defends the galaxy.",)
    assert "Released: 2026" in output.facts
    assert "Runtime: 128 min" in output.facts
    assert "Cast: Leia Organa, Luke Skywalker" in output.facts
    assert output.sources[0].title == "TMDB: Rogue Squadron"
    assert output.media[0]["kind"] == "poster"
    assert output.media[0]["url"].endswith("/abc123.jpg")


def test_tmdb_adapter_gracefully_handles_empty_data():
    output = TMDBAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.summary_candidates == ()
    assert output.raw == {}


def test_tmdb_adapter_no_poster_when_missing():
    output = TMDBAdapter().adapt(
        MechanismResult(
            success=True,
            data={"title": "Plain Movie", "overview": "No poster here."},
        )
    )
    assert output.media == ()


# ---- movies_wiki --------------------------------------------------------


def test_wiki_movies_adapter_happy_path():
    output = WikiMoviesAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "title": "Rogue Squadron",
                "overview": "Rogue Squadron is a 2026 space opera film.",
                "release_date": "2026-05-15",
                "runtime_min": 128,
                "genre": "space opera film",
                "lead": "Rogue Squadron (2026) — runs 2h 8m — space opera film.",
            },
            source_url="https://en.wikipedia.org/wiki/Rogue_Squadron",
        )
    )
    assert output.summary_candidates[0].startswith("Rogue Squadron (2026)")
    assert "Released: 2026" in output.facts
    assert "Runtime: 128 min" in output.facts
    assert output.sources[0].url == "https://en.wikipedia.org/wiki/Rogue_Squadron"


def test_wiki_movies_adapter_gracefully_handles_empty_data():
    output = WikiMoviesAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.summary_candidates == ()
    assert output.raw == {}


# ---- recipes ------------------------------------------------------------


def test_recipe_adapter_happy_path():
    output = RecipeMealDBAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "query": "chicken soup",
                "recipes": [
                    {
                        "name": "Jedi Chicken Soup",
                        "area": "Naboo",
                        "category": "Soup",
                        "ingredients": ["1 cup broth", "2 carrots", "1 onion"],
                        "source": "https://www.themealdb.com/meal/12345",
                        "id": "12345",
                    }
                ],
            },
        )
    )
    assert output.summary_candidates == ("Jedi Chicken Soup — Soup · Naboo",)
    assert "Ingredients: 1 cup broth, 2 carrots, 1 onion" in output.facts
    assert output.sources[0].url == "https://www.themealdb.com/meal/12345"
    assert output.actions[0] == {"kind": "print_recipe", "recipe_id": "12345"}


def test_recipe_adapter_gracefully_handles_empty_data():
    output = RecipeMealDBAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.summary_candidates == ()
    assert output.raw == {}


def test_recipe_adapter_caps_ingredients_at_twelve():
    ingredients = [f"ingredient {i}" for i in range(20)]
    output = RecipeMealDBAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "recipes": [
                    {"name": "Big Soup", "ingredients": ingredients, "area": "Naboo"}
                ],
            },
        )
    )
    fact = [f for f in output.facts if f.startswith("Ingredients:")][0]
    assert fact.count(",") == 11  # 12 ingredients → 11 commas


# ---- tvshows ------------------------------------------------------------


def test_tvmaze_adapter_happy_path():
    output = TVMazeAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "name": "Galactic Voyage",
                "status": "Running",
                "premiered": "2024-09-01",
                "rating": 8.5,
                "genres": ["Drama", "Sci-Fi"],
                "summary": "A crew explores deep space.",
                "network": "Republic Broadcasting",
            },
            source_url="https://www.tvmaze.com/shows/42/galactic-voyage",
            source_title="TVMaze - Galactic Voyage",
        )
    )
    assert output.summary_candidates == ("A crew explores deep space.",)
    assert "Premiered: 2024" in output.facts
    assert "Status: Running" in output.facts
    assert "Genre: Drama, Sci-Fi" in output.facts
    assert "Network: Republic Broadcasting" in output.facts
    assert output.sources[0].title == "TVMaze: Galactic Voyage"


def test_tvmaze_adapter_gracefully_handles_empty_data():
    output = TVMazeAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.summary_candidates == ()
    assert output.raw == {}


# ---- people_lookup ------------------------------------------------------


def test_people_lookup_adapter_happy_path():
    output = PeopleLookupAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "lead": "Your sister: Leia Organa",
                "matches": [
                    {"id": 1, "name": "Leia Organa", "relations": ["sister"], "bucket": "family"},
                ],
                "match_count": 1,
            },
        )
    )
    assert output.summary_candidates == ("Your sister: Leia Organa",)
    assert output.facts[0] == "Leia Organa (sister, family)"


def test_people_lookup_adapter_clarification_flow():
    output = PeopleLookupAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "needs_clarification": True,
                "clarification_prompt": "I don't know your cousin yet. What's their name?",
                "matches": [],
            },
        )
    )
    assert output.summary_candidates == (
        "I don't know your cousin yet. What's their name?",
    )


def test_people_lookup_adapter_gracefully_handles_empty_data():
    output = PeopleLookupAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.summary_candidates == ()
    assert output.raw == {}


# ---- youtube ------------------------------------------------------------


def test_youtube_adapter_video_passthrough():
    output = YouTubeAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "type": "video",
                "video_id": "abc123xyz00",
                "title": "Rogue Squadron Trailer",
                "channel": "StarWars",
                "url": "https://www.youtube.com/watch?v=abc123xyz00",
            },
            source_url="https://www.youtube.com/watch?v=abc123xyz00",
        )
    )
    assert output.media[0]["kind"] == "youtube_video"
    assert output.media[0]["video_id"] == "abc123xyz00"
    assert output.media[0]["title"] == "Rogue Squadron Trailer"
    assert output.media[0]["url"] == "https://www.youtube.com/watch?v=abc123xyz00"
    assert output.sources[0].url == "https://www.youtube.com/watch?v=abc123xyz00"
    assert output.summary_candidates == ()


def test_youtube_adapter_channel_passthrough():
    output = YouTubeAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "type": "channel",
                "channel_name": "Mandalorian Cooking",
                "channel_url": "https://www.youtube.com/@mandocooking",
                "handle": "@mandocooking",
                "featured_video_id": "feat001",
            },
        )
    )
    assert output.media[0]["kind"] == "youtube_channel"
    assert output.media[0]["handle"] == "@mandocooking"
    assert output.media[0]["featured_video_id"] == "feat001"
    assert output.media[0]["url"] == "https://www.youtube.com/@mandocooking"


def test_youtube_adapter_gracefully_handles_empty_data():
    output = YouTubeAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.media == ()
    assert output.raw == {}


def test_youtube_adapter_follow_up_only_when_related_present():
    base = {
        "type": "video",
        "video_id": "abc123xyz00",
        "title": "Rogue Squadron Trailer",
        "url": "https://www.youtube.com/watch?v=abc123xyz00",
    }
    no_related = YouTubeAdapter().adapt(MechanismResult(success=True, data=base))
    with_related = YouTubeAdapter().adapt(
        MechanismResult(success=True, data={**base, "related": [{"id": "rel1"}]})
    )
    assert no_related.follow_up_candidates == ()
    assert with_related.follow_up_candidates == ("Show more like this",)


# ---- smarthome_mock -----------------------------------------------------


def test_smarthome_mock_adapter_status_shape():
    output = SmartHomeMockAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "device_id": "living_room_light",
                "name": "Living Room Light",
                "type": "light",
                "state": "on",
                "brightness": 75,
            },
        )
    )
    assert output.summary_candidates == ("Living Room Light is on",)
    assert "State: on" in output.facts
    assert "Brightness: 75" in output.facts


def test_smarthome_mock_adapter_action_shape():
    output = SmartHomeMockAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "device_id": "reading_lamp",
                "name": "Reading Lamp",
                "action": "off",
                "state": "off",
                "type": "light",
            },
        )
    )
    assert output.summary_candidates == ("Reading Lamp: off → off",)


def test_smarthome_mock_adapter_gracefully_handles_empty_data():
    output = SmartHomeMockAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.summary_candidates == ()
    assert output.raw == {}


# ---- coverage invariant -------------------------------------------------


def _skill_dirs() -> list[str]:
    ignored = {"__pycache__", "__init__.py"}
    entries = []
    for name in os.listdir(SKILLS_DIR):
        if name in ignored:
            continue
        if name.startswith("_") or name.startswith("."):
            continue
        path = os.path.join(SKILLS_DIR, name)
        if not os.path.isdir(path):
            continue
        entries.append(name)
    return entries


def test_all_skills_have_adapters():
    missing: list[str] = []
    for skill_id in _skill_dirs():
        if resolve_adapter(skill_id) is None:
            missing.append(skill_id)
    assert not missing, (
        f"Every skill under lokidoki/skills/ must ship with a response adapter; "
        f"missing: {missing}"
    )
