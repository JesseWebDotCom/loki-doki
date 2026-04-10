from __future__ import annotations

import time

from lokidoki.core.text_normalizer import normalize_for_speech


def test_plain_conversational_text_passes_through_cleanly():
    text = "I think that sounds good. We can try again tomorrow."
    assert normalize_for_speech(text) == text


def test_normalizes_real_world_mixed_message():
    text = (
        "Dr. Kim said the follow-up is on 04/09/2026 at 3:30 PM. "
        "Budget is $3.50 and we're 85% done. "
        "Email me at user@example.com or check https://example.com/docs. "
        "Room #4 is approx. 2 km away."
    )

    spoken = normalize_for_speech(text)

    assert "Doctor Kim" in spoken
    assert "April ninth, twenty twenty-six" in spoken
    assert "three thirty PM" in spoken
    assert "three dollars and fifty cents" in spoken
    assert "eighty-five percent" in spoken
    assert "user at example dot com" in spoken
    assert "link" in spoken
    assert "number four" in spoken
    assert "approximately" in spoken
    assert "two kilometers" in spoken


def test_phone_numbers_stay_digit_by_digit():
    spoken = normalize_for_speech("Call me at 555-1234 tomorrow.")
    assert "five five five, one two three four" in spoken


def test_iso_date_and_symbols_are_spoken_naturally():
    spoken = normalize_for_speech("Meeting is 2026-04-09, and R&D + QA = 2 teams.")
    assert "April ninth, twenty twenty-six" in spoken
    assert "and" in spoken
    assert "plus" in spoken
    assert "equals" in spoken


def test_strips_emoji_and_residual_markdown_artifacts():
    spoken = normalize_for_speech("**Great job** 😄 [src:1] (https://example.com)")
    assert spoken == "Great job"


def test_temperatures_are_spoken_naturally_in_weather_style_text():
    spoken = normalize_for_speech("It's 9.4°C (49°F) in Milford, US — no rain right now (clear sky).")
    assert "nine point four degrees Celsius" in spoken
    assert "forty-nine degrees Fahrenheit" in spoken
    assert "clear sky" in spoken


def test_normalization_is_fast_on_realistic_chat_samples():
    samples = [
        "Hey, can you remind me if Dr. Shah said the 04/09/2026 check-in is at 3:30 PM or 4 PM?",
        "I'm about 85% sure the budget is $42.50, but check https://example.com/budget if you want.",
        "Text my brother at 555-1234 and tell him room #7 is 2 km past the gate.",
        "The package says approx. 16 oz, and the backup option is 1.5 lbs.",
        "It's 9.4°C (49°F) in Milford, US — no rain right now (clear sky).",
    ]

    started = time.perf_counter()
    for _ in range(200):
        for sample in samples:
            normalize_for_speech(sample)
    elapsed_ms = (time.perf_counter() - started) * 1000

    assert elapsed_ms < 500
