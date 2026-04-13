"""Unit tests for the v2 spaCy-backed splitter and extractor."""
from __future__ import annotations

from lokidoki.orchestrator.pipeline.extractor import extract_chunk_data
from lokidoki.orchestrator.pipeline.parser import parse_text
from lokidoki.orchestrator.pipeline.splitter import split_requests


def test_splitter_keeps_coordinated_adjectives_together():
    parsed = parse_text("is that movie scary and gory")
    chunks = split_requests(parsed)
    assert [chunk.text for chunk in chunks] == ["is that movie scary and gory"]
    assert chunks[0].role == "primary_request"


def test_splitter_splits_distinct_speech_acts():
    parsed = parse_text("hello and how do you spell necessary")
    chunks = split_requests(parsed)
    assert [chunk.text for chunk in chunks] == [
        "hello",
        "how do you spell necessary",
    ]


def test_splitter_separates_subordinate_clause_as_supporting_context():
    parsed = parse_text("what time is it because im late")
    chunks = split_requests(parsed)
    roles = [chunk.role for chunk in chunks]
    assert "supporting_context" in roles
    primary_chunks = [chunk for chunk in chunks if chunk.role == "primary_request"]
    assert primary_chunks
    assert "what time is it" in primary_chunks[0].text


def test_splitter_does_not_split_movie_attribute_query():
    parsed = parse_text("is that movie rated r and what time is it playing")
    chunks = split_requests(parsed)
    primary_texts = [chunk.text for chunk in chunks if chunk.role == "primary_request"]
    # Two distinct speech acts (rating + showtime), both contain verbs/aux.
    assert len(primary_texts) == 2


def test_extractor_pulls_pronouns_from_doc():
    parsed = parse_text("play it for me")
    chunks = split_requests(parsed)
    extractions = extract_chunk_data(chunks, parsed)
    assert "it" in extractions[0].references


def test_extractor_pulls_named_entities_from_doc():
    parsed = parse_text("text Luke tomorrow")
    chunks = split_requests(parsed)
    extractions = extract_chunk_data(chunks, parsed)
    person_entities = [ent for ent in extractions[0].entities if ent[1] == "PERSON"]
    assert person_entities
