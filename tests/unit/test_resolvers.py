"""Unit tests for v2 resolvers and adapters (Phase 3)."""
from __future__ import annotations

from tests.fixtures.seed_people import SEED_ROSTER
from lokidoki.orchestrator.adapters.conversation_memory import ConversationMemoryAdapter
from lokidoki.orchestrator.adapters.home_assistant import HomeAssistantAdapter
from lokidoki.orchestrator.adapters.movie_context import MovieContextAdapter
from lokidoki.orchestrator.adapters.people_db import PeopleDBAdapter, PersonRecord
from lokidoki.orchestrator.core.types import ChunkExtraction, RequestChunk, RouteMatch
from lokidoki.orchestrator.resolution.device_resolver import resolve_device
from lokidoki.orchestrator.resolution.media_resolver import resolve_media
from lokidoki.orchestrator.resolution.people_resolver import resolve_people
from lokidoki.orchestrator.resolution.pronoun_resolver import resolve_pronouns


# ---- people resolver --------------------------------------------------------
#
# The in-memory PeopleDBAdapter's production default is an EMPTY roster
# (so the live dev tool pipeline can never surface fictional people).
# Unit tests that need a deterministic family graph pass SEED_ROSTER
# explicitly — never relying on a baked-in default.


def test_people_db_default_constructor_is_empty():
    """Production guarantee: PeopleDBAdapter() must not invent identities."""
    db = PeopleDBAdapter()
    assert db.all() == ()
    assert db.resolve("mom") is None
    assert db.resolve("sister") is None


def test_people_db_resolves_alias_to_record():
    db = PeopleDBAdapter(records=SEED_ROSTER)
    match = db.resolve("mom")
    assert match is not None
    assert match.record.name == "Padme"
    assert match.record.relationship == "mother"
    assert match.matched_alias == "mom"


def test_people_db_returns_none_for_unknown_mention():
    db = PeopleDBAdapter(records=SEED_ROSTER)
    assert db.resolve("zorblax") is None


def test_people_resolver_binds_named_entity_to_record():
    db = PeopleDBAdapter(records=SEED_ROSTER)
    chunk = RequestChunk(text="text Anakin", index=0)
    extraction = ChunkExtraction(
        chunk_index=0,
        entities=[("Anakin", "PERSON")],
        subject_candidates=["Anakin"],
    )
    route = RouteMatch(chunk_index=0, capability="send_text_message", confidence=0.9)

    result = resolve_people(chunk, extraction, route, db)

    assert result is not None
    assert result.source == "people_db"
    assert result.params["person_name"] == "Anakin"
    assert result.params["matched_alias"] in {"anakin", "Anakin"}


def test_people_resolver_flags_missing_person():
    db = PeopleDBAdapter(records=SEED_ROSTER)
    chunk = RequestChunk(text="text", index=0)
    extraction = ChunkExtraction(chunk_index=0)
    route = RouteMatch(chunk_index=0, capability="send_text_message", confidence=0.9)

    result = resolve_people(chunk, extraction, route, db)

    assert result is not None
    assert result.source == "missing_person"
    assert result.unresolved == ["person:missing"]


def test_people_resolver_flags_ambiguous_person():
    db = PeopleDBAdapter(
        records=[
            PersonRecord(id="p1", name="Sarah", relationship="coworker", aliases=["sarah"], priority=40),
            PersonRecord(id="p2", name="Sarah", relationship="friend", aliases=["sarah"], priority=40),
        ]
    )
    chunk = RequestChunk(text="text Sarah", index=0)
    extraction = ChunkExtraction(
        chunk_index=0,
        entities=[("Sarah", "PERSON")],
        subject_candidates=["Sarah"],
    )
    route = RouteMatch(chunk_index=0, capability="send_text_message", confidence=0.9)

    result = resolve_people(chunk, extraction, route, db)

    assert result is not None
    assert result.source == "ambiguous_person"
    assert result.unresolved == ["person_ambiguous:sarah"]
    assert set(result.candidate_values) == {"Sarah"}


# ---- device resolver --------------------------------------------------------


def test_home_assistant_resolves_kitchen_light_alias():
    ha = HomeAssistantAdapter()
    match = ha.resolve("kitchen light")
    assert match is not None
    assert match.record.entity_id == "light.kitchen_main"


def test_device_resolver_binds_subject_candidate_to_entity():
    ha = HomeAssistantAdapter()
    chunk = RequestChunk(text="turn off the kitchen light", index=0)
    extraction = ChunkExtraction(
        chunk_index=0,
        subject_candidates=["the kitchen light"],
    )
    route = RouteMatch(chunk_index=0, capability="control_device", confidence=0.92)

    result = resolve_device(chunk, extraction, route, ha)

    assert result is not None
    assert result.source == "home_assistant"
    assert result.params["entity_id"] == "light.kitchen_main"


def test_device_resolver_flags_missing_device():
    ha = HomeAssistantAdapter()
    chunk = RequestChunk(text="turn off", index=0)
    extraction = ChunkExtraction(chunk_index=0)
    route = RouteMatch(chunk_index=0, capability="control_device", confidence=0.7)

    result = resolve_device(chunk, extraction, route, ha)

    assert result is not None
    assert result.source in {"missing_device", "unresolved_device"}
    assert result.unresolved


# ---- media resolver ---------------------------------------------------------


def test_media_resolver_binds_recent_movie():
    memory = ConversationMemoryAdapter({"recent_entities": [{"type": "movie", "name": "Padme"}]})
    movies = MovieContextAdapter(memory)
    chunk = RequestChunk(text="get the rating", index=0)
    extraction = ChunkExtraction(chunk_index=0)
    route = RouteMatch(chunk_index=0, capability="get_movie_rating", confidence=0.9)

    result = resolve_media(chunk, extraction, route, movies)

    assert result is not None
    assert result.source == "recent_context"
    assert result.params["movie_title"] == "Padme"


def test_media_resolver_flags_missing_context():
    memory = ConversationMemoryAdapter({})
    movies = MovieContextAdapter(memory)
    chunk = RequestChunk(text="get the rating", index=0)
    extraction = ChunkExtraction(chunk_index=0)
    route = RouteMatch(chunk_index=0, capability="get_movie_rating", confidence=0.9)

    result = resolve_media(chunk, extraction, route, movies)

    assert result is not None
    assert result.source == "unresolved_context"
    assert result.unresolved == ["recent_media"]


# ---- pronoun resolver -------------------------------------------------------


def test_pronoun_resolver_binds_it_to_recent_movie():
    memory = ConversationMemoryAdapter({"recent_entities": [{"type": "movie", "name": "Rogue One"}]})
    chunk = RequestChunk(text="play it", index=0)
    extraction = ChunkExtraction(chunk_index=0, references=["it"])
    route = RouteMatch(chunk_index=0, capability="play_media", confidence=0.7)

    result = resolve_pronouns(chunk, extraction, route, memory)

    assert result is not None
    assert result.source == "referent"
    assert result.context_value == "Rogue One"


def test_pronoun_resolver_skips_direct_utility_capabilities():
    memory = ConversationMemoryAdapter({"recent_entities": [{"type": "movie", "name": "Rogue One"}]})
    chunk = RequestChunk(text="what time is it", index=0)
    extraction = ChunkExtraction(chunk_index=0, references=["it"])
    route = RouteMatch(chunk_index=0, capability="get_current_time", confidence=0.95)

    assert resolve_pronouns(chunk, extraction, route, memory) is None


def test_pronoun_resolver_flags_missing_referent():
    memory = ConversationMemoryAdapter({})
    chunk = RequestChunk(text="play it", index=0)
    extraction = ChunkExtraction(chunk_index=0, references=["it"])
    route = RouteMatch(chunk_index=0, capability="play_media", confidence=0.6)

    result = resolve_pronouns(chunk, extraction, route, memory)

    assert result is not None
    assert result.source == "unresolved_referent"
    assert result.unresolved == ["referent:it"]
