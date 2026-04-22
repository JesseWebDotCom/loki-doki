"""Map ``capability_need`` enum values to target capability IDs.

Each ``capability_need`` value lists the capabilities it should boost
in the router, in preference order. The router applies
:data:`PRIMARY_BOOST` to the first capability in the list and
:data:`SECONDARY_BOOST` to the rest — so the LLM's first-choice skill
gets the biggest nudge but related skills still benefit.
"""
from __future__ import annotations

# Boost magnitudes applied on top of cosine similarity when the
# decomposer's capability_need names this capability. Small enough
# that a confident MiniLM mismatch (cosine gap > 0.15) still wins,
# but big enough to lift a borderline match above ROUTE_FLOOR (0.55).
PRIMARY_BOOST: float = 0.15
SECONDARY_BOOST: float = 0.08

# Ordered preference: first entry is the canonical target, rest are
# acceptable alternatives that also get a (smaller) boost.
CAPABILITY_BOOSTS: dict[str, tuple[str, ...]] = {
    "encyclopedic": ("knowledge_query", "lookup_definition", "lookup_fact"),
    # knowledge_query is primary for medical because it's ZIM-backed via
    # hint_map (MDWiki / WikEM offline). ``look_up_symptom`` is a web-only
    # MedlinePlus wrapper and fails on every offline turn — keep it as a
    # secondary so it only wins when knowledge_query scores lower.
    "medical": ("knowledge_query", "look_up_symptom", "check_medication"),
    "howto": ("knowledge_query", "find_recipe"),
    "country_facts": ("knowledge_query", "lookup_fact"),
    "education": ("knowledge_query",),
    "technical_reference": ("knowledge_query", "code_assistance"),
    "geographic": ("knowledge_query", "find_nearby", "get_directions"),
    "weather": ("get_weather",),
    "current_media": ("get_movie_showtimes", "lookup_movie", "search_movies"),
    "people_lookup": ("lookup_person_birthday", "lookup_relationship", "list_family", "search_contacts"),
    "youtube": ("get_youtube_channel", "get_video", "get_music_video"),
    "web_search": ("search_web", "knowledge_query"),
    "calendar": ("create_event", "get_events", "update_event", "delete_event"),
    "timer_reminder": ("set_timer", "set_alarm", "set_reminder", "cancel_alarm", "list_alarms"),
    "navigation": ("get_directions", "get_eta", "find_nearby", "get_transit"),
    "conversion": ("convert_units", "convert_currency", "calculate", "calculate_tip"),
    "messaging": ("send_text_message", "make_call", "read_messages", "read_emails"),
    "music_control": ("play_music", "control_playback", "set_volume", "get_now_playing"),
    "device_control": ("control_device", "set_scene", "get_device_state"),
    "news": ("get_news_headlines", "search_news", "get_briefing"),
    "none": (),
}


def capabilities_for_need(capability_need: str) -> tuple[str, ...]:
    """Return the ordered capability preference for a ``capability_need`` value."""
    return CAPABILITY_BOOSTS.get(capability_need, ())


def capability_boost(capability_need: str, capability: str) -> float:
    """Return the score boost to add to ``capability`` given ``capability_need``.

    ``PRIMARY_BOOST`` for the first-preference capability, ``SECONDARY_BOOST``
    for any subsequent preferences, 0.0 otherwise.
    """
    preferences = CAPABILITY_BOOSTS.get(capability_need, ())
    if not preferences:
        return 0.0
    if capability == preferences[0]:
        return PRIMARY_BOOST
    if capability in preferences[1:]:
        return SECONDARY_BOOST
    return 0.0
