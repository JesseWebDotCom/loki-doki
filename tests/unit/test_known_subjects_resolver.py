from lokidoki.core.known_subjects_resolver import build_known_subjects, resolve_known_people


def _person(pid: int, name: str, aliases: list[str] | None = None) -> dict:
    return {
        "id": pid,
        "name": name,
        "aliases": aliases or [],
    }


def _relationship(pid: int, relation: str, name: str) -> dict:
    return {
        "id": pid,
        "person_id": pid,
        "relation": relation,
        "person_name": name,
    }


def test_hi_resolves_zero_people_and_keeps_prompt_sparse():
    known_subjects, resolved = build_known_subjects(
        user_input="hi",
        user_display_name="Jesse",
        people_rows=[_person(1, "Luke"), _person(2, "Carina")],
        relationships=[_relationship(1, "brother", "Luke")],
        relevant_facts=[],
    )

    assert resolved == []
    assert known_subjects["people"] == []


def test_exact_name_match_resolves_person():
    resolved = resolve_known_people(
        user_input="tell Carina I said hi",
        people_rows=[_person(1, "Carina"), _person(2, "Luke")],
        relationships=[],
        relationship_aliases={"mother": ["mom"]},
    )

    assert len(resolved) == 1
    assert resolved[0].name == "Carina"
    assert resolved[0].method == "exact_name"


def test_exact_person_alias_match_resolves_person():
    resolved = resolve_known_people(
        user_input="Luke told me that",
        people_rows=[_person(1, "Anakin Torres", ["Art", "Luke"])],
        relationships=[_relationship(1, "brother", "Anakin Torres")],
        relationship_aliases={"brother": ["bro"]},
    )

    assert len(resolved) == 1
    assert resolved[0].name == "Anakin Torres"
    assert resolved[0].method == "exact_alias"


def test_relationship_alias_returns_candidate_set():
    resolved = resolve_known_people(
        user_input="I should call my mom",
        people_rows=[_person(1, "Jesus M Torres"), _person(2, "Sarah Pericas")],
        relationships=[
            _relationship(1, "mother", "Jesus M Torres"),
            _relationship(2, "mother", "Sarah Pericas"),
        ],
        relationship_aliases={"mother": ["mom", "mommy", "mama"]},
    )

    assert [item.name for item in resolved] == ["Jesus M Torres", "Sarah Pericas"]
    assert all(item.method == "relationship_alias" for item in resolved)


def test_fuzzy_match_is_bounded_to_known_people():
    resolved = resolve_known_people(
        user_input="Arty told me that",
        people_rows=[
            _person(1, "Anakin Torres", ["Art", "Luke"]),
            _person(2, "Robert Smith", ["Rob", "Bobby"]),
        ],
        relationships=[],
        relationship_aliases={},
    )

    assert len(resolved) == 1
    assert resolved[0].name == "Anakin Torres"
    assert resolved[0].method == "fuzzy_alias"


def test_large_people_corpus_stays_bounded():
    people_rows = [_person(i, f"Person {i}") for i in range(1, 619)]
    people_rows.append(_person(999, "Anakin Torres", ["Art", "Luke"]))
    relationships = [_relationship(999, "brother", "Anakin Torres")]

    known_subjects, resolved = build_known_subjects(
        user_input="Luke hates those",
        user_display_name="Jesse",
        people_rows=people_rows,
        relationships=relationships,
        relevant_facts=[],
        max_people=10,
    )

    assert len(resolved) == 1
    assert known_subjects["people"] == ["Anakin Torres (brother)"]
    assert len(known_subjects["people"]) <= 10


def test_build_known_subjects_includes_compact_hints():
    known_subjects, _ = build_known_subjects(
        user_input="my sister Leia would find this funny",
        user_display_name="Jesse",
        people_rows=[_person(1, "Leia")],
        relationships=[_relationship(1, "sister", "Leia")],
        relevant_facts=[],
    )

    hints = known_subjects["hints"]
    assert isinstance(hints, str)
    assert "Leia:sister" in hints
    assert len(hints) < 200
