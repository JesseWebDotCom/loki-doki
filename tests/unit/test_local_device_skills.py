from __future__ import annotations

import json
from pathlib import Path

from lokidoki.orchestrator.skills import (
    alarms_local,
    calendar_local,
    contacts_local,
    fitness,
    music,
    notes_local,
)


def _store_path(name: str) -> Path:
    return Path("lokidoki/orchestrator/data") / f"{name}.json"


def _reset(name: str) -> None:
    path = _store_path(name)
    if path.exists():
        path.unlink()


def test_calendar_local_round_trip():
    _reset("calendar")
    created = calendar_local.create_event({"chunk_text": "add dentist appointment 2026-05-01 3pm"})
    listed = calendar_local.get_events({"chunk_text": "what's on my calendar"})

    assert "Created event" in created["output_text"]
    assert "dentist appointment" in listed["output_text"].lower()


def test_alarms_local_round_trip():
    _reset("alarms")
    alarms_local.set_alarm({"chunk_text": "set an alarm for 7am"})
    listed = alarms_local.list_alarms({})

    assert "7AM" in listed["output_text"]


def test_contacts_local_message_and_email_round_trip():
    _reset("communications")
    sent = contacts_local.send_text_message({"params": {"person_name": "Leia", "body": "Running late"}})
    read = contacts_local.read_messages({"params": {"person": "Leia"}})
    emails = contacts_local.read_emails({"chunk_text": "emails from Luke"})

    assert "Sent text to Leia" in sent["output_text"]
    assert "Running late" in read["output_text"]
    assert "Luke" in emails["output_text"]


def test_notes_local_round_trip():
    _reset("notes")
    notes_local.create_note({"params": {"title": "Paris Trip", "body": "Pack chargers"}})
    notes_local.append_to_list({"params": {"list_name": "grocery list", "items": ["milk", "eggs"]}})
    found = notes_local.search_notes({"chunk_text": "paris"})
    listed = notes_local.read_list({"params": {"list_name": "grocery list"}})

    assert "Paris Trip" in found["output_text"]
    assert "milk" in listed["output_text"]


def test_music_local_state_round_trip():
    _reset("music")
    music.play_music({"params": {"query": "The Imperial March"}})
    music.set_volume({"chunk_text": "volume 40"})
    current = music.get_now_playing({})

    assert "Imperial March" in current["output_text"]
    data = json.loads(_store_path("music").read_text())
    assert data["volume"] == 40


def test_fitness_local_round_trip():
    _reset("fitness")
    fitness.log_workout({"chunk_text": "log a 30 minute run"})
    summary = fitness.get_fitness_summary({})

    assert "30 minute run" in summary["output_text"].lower()
