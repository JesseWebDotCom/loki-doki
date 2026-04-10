from __future__ import annotations

from lokidoki.core.prosody_planner import (
    SpeechSegment,
    build_silence_pcm,
    plan_prosody,
)


def test_single_sentence_defaults_to_one_segment():
    segments = plan_prosody("That sounds good.")
    assert segments == [SpeechSegment(text="That sounds good.", length_scale=1.0, post_silence_s=0.0)]


def test_question_and_topic_shift_get_distinct_pauses():
    text = "The short answer is yes. Also, we can revisit it tomorrow. What do you think?"
    segments = plan_prosody(text)

    assert [segment.text for segment in segments] == [
        "The short answer is yes.",
        "Also, we can revisit it tomorrow.",
        "What do you think?",
    ]
    assert segments[0].length_scale == 1.0
    assert segments[1].length_scale == 0.95
    assert segments[1].post_silence_s == 0.4
    assert segments[2].post_silence_s == 0.0


def test_list_items_get_uniform_pacing():
    segments = plan_prosody("1. Pack snacks.\n2. Bring water.\n3. Leave early.")
    assert len(segments) == 3
    assert all(segment.length_scale == 1.0 for segment in segments)
    assert segments[0].post_silence_s == 0.3
    assert segments[1].post_silence_s == 0.3
    assert segments[2].post_silence_s == 0.0


def test_build_silence_pcm_matches_sample_rate_and_duration():
    pcm = build_silence_pcm(sample_rate=22050, duration_s=0.4)
    assert len(pcm) == int(22050 * 0.4) * 2
    assert pcm == b"\x00" * len(pcm)
