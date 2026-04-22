from __future__ import annotations

from lokidoki.core.skill_executor import MechanismResult
from lokidoki.orchestrator.adapters.datetime_local import DateTimeAdapter
from lokidoki.orchestrator.adapters.dictionary import DictionaryAdapter
from lokidoki.orchestrator.adapters.jokes import JokesAdapter
from lokidoki.orchestrator.adapters.unit_conversion import UnitConversionAdapter


def test_datetime_adapter_happy_path():
    output = DateTimeAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "datetime": "2026-04-21T15:42:00-04:00",
                "timezone": "America/New_York",
                "lead": "It is 3:42 PM on Tuesday.",
            },
        )
    )
    assert output.summary_candidates == ("It is 3:42 PM on Tuesday.",)
    assert output.facts == ("2026-04-21T15:42:00-04:00", "America/New_York")


def test_datetime_adapter_gracefully_handles_empty_data():
    output = DateTimeAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.summary_candidates == ()
    assert output.raw == {}


def test_dictionary_adapter_happy_path():
    output = DictionaryAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "word": "ephemeral",
                "meanings": [
                    {"part_of_speech": "adjective", "definitions": ["lasting a short time"]},
                    {"part_of_speech": "noun", "definitions": ["something short-lived"]},
                ],
            },
            source_url="https://dictionaryapi.dev/",
            source_title="dictionaryapi.dev",
        )
    )
    assert len(output.summary_candidates) == 2
    assert output.facts[0] == "adjective: lasting a short time"
    assert output.sources[0].title == "dictionaryapi.dev"


def test_dictionary_adapter_gracefully_handles_missing_meanings():
    output = DictionaryAdapter().adapt(
        MechanismResult(success=True, data={"word": "ephemeral"})
    )
    assert output.summary_candidates == ()
    assert output.raw == {"word": "ephemeral"}


def test_unit_conversion_adapter_happy_path():
    output = UnitConversionAdapter().adapt(
        MechanismResult(
            success=True,
            data={
                "value": 5,
                "from_unit": "miles",
                "result": 8.047,
                "to_unit": "kilometers",
            },
        )
    )
    assert output.summary_candidates == ("5 miles = 8.047 kilometers",)


def test_unit_conversion_adapter_gracefully_handles_missing_fields():
    output = UnitConversionAdapter().adapt(
        MechanismResult(success=True, data={"value": 5})
    )
    assert output.summary_candidates == ()
    assert output.raw == {"value": 5}


def test_jokes_adapter_happy_path():
    output = JokesAdapter().adapt(
        MechanismResult(
            success=True,
            data={"joke": "Why did the droid cross the road?"},
            source_url="https://icanhazdadjoke.com/",
            source_title="icanhazdadjoke",
        )
    )
    assert output.summary_candidates == ("Why did the droid cross the road?",)
    assert output.sources[0].title == "icanhazdadjoke"


def test_jokes_adapter_gracefully_handles_missing_joke():
    output = JokesAdapter().adapt(MechanismResult(success=True, data={}))
    assert output.summary_candidates == ()
    assert output.raw == {}
