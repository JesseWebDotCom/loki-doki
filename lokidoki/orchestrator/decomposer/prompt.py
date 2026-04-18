"""Minimal routing-only decomposer prompt.

Separate from the full :data:`DECOMPOSITION_PROMPT` in
``lokidoki.core.prompts.decomposition`` (which also handles memory
extraction and is ~7.9KB). This prompt ONLY extracts routing signals
so the fast model can return in 200-400ms instead of 800-1500ms.

Budget: keep under 5500 chars. A CI test enforces this ceiling.
Growing the enum to cover all skill families (calendar/timer/messaging/
navigation/conversion/music/device/news) pushed the prompt from ~3.2KB
to ~4.8KB. Each KB adds ~80-120ms on a Pi-class fast model, so the
ceiling is set with headroom to reject further bloat.
"""
from __future__ import annotations

ROUTING_PROMPT = (
    "ROLE: route user input to a capability family. Output compact JSON only.\n"
    "SHAPE: {\"capability_need\":\"X\",\"archive_hint\":\"Y\",\"resolved_query\":\"Z\"}\n"
    "\n"
    "capability_need values (pick ONE):\n"
    " encyclopedic      — Wikipedia-class facts, biographies, concepts, history\n"
    " medical           — symptoms, drugs, dosage, first aid, health conditions\n"
    " howto             — practical fix/do tasks (unclog, repair, cook, install, build)\n"
    " country_facts     — country population/economy/government/geography stats\n"
    " education         — academic concept explanation, homework help, tutoring\n"
    " technical_reference — Linux commands, programming docs, config syntax\n"
    " geographic        — travel destinations, maps, places to visit\n"
    " weather           — current/forecast weather anywhere\n"
    " current_media     — movies/shows in theaters now, showtimes, trailers\n"
    " people_lookup     — 'my sister', 'my friend X' (personal relationships)\n"
    " youtube           — YouTube channels/videos/music videos by creator\n"
    " web_search        — fresh/niche/recent info not in encyclopedia\n"
    " calendar          — create/view/update events, appointments, schedule\n"
    " timer_reminder    — set timer, alarm, reminder; cancel, list them\n"
    " navigation        — directions, ETA, nearby places, transit\n"
    " conversion        — unit/currency conversion, math, tip calculation\n"
    " messaging         — send text, make call, read messages/emails\n"
    " music_control     — play/pause/skip music, volume, now-playing\n"
    " device_control    — smart-home device on/off, scenes, sensors\n"
    " news              — news headlines, briefing, search news\n"
    " none              — chitchat, greetings, acknowledgments, opinions\n"
    "\n"
    "archive_hint (optional, lowercase, empty string if unsure):\n"
    " mdwiki wikem firstaid ifixit appropedia khanacademy factbook\n"
    " archlinux wikivoyage gutenberg wikipedia stackexchange\n"
    "\n"
    "resolved_query: self-contained search phrase (resolve pronouns if context given).\n"
    "If input is self-contained, copy it verbatim. Strip filler.\n"
    "\n"
    "EXAMPLES:\n"
    "\"ibuprofen max dose\" -> {\"capability_need\":\"medical\",\"archive_hint\":\"mdwiki\",\"resolved_query\":\"ibuprofen max dose\"}\n"
    "\"my chest hurts\" -> {\"capability_need\":\"medical\",\"archive_hint\":\"wikem\",\"resolved_query\":\"chest pain causes\"}\n"
    "\"i cut my toe\" -> {\"capability_need\":\"medical\",\"archive_hint\":\"mdwiki\",\"resolved_query\":\"toe laceration first aid\"}\n"
    "\"i sprained my ankle\" -> {\"capability_need\":\"medical\",\"archive_hint\":\"mdwiki\",\"resolved_query\":\"sprained ankle treatment\"}\n"
    "\"i have a headache\" -> {\"capability_need\":\"medical\",\"archive_hint\":\"mdwiki\",\"resolved_query\":\"headache causes treatment\"}\n"
    "\"i burned my hand\" -> {\"capability_need\":\"medical\",\"archive_hint\":\"mdwiki\",\"resolved_query\":\"burn treatment first aid\"}\n"
    "\"how do i unclog a drain\" -> {\"capability_need\":\"howto\",\"archive_hint\":\"ifixit\",\"resolved_query\":\"unclog a drain\"}\n"
    "\"fix iphone cracked screen\" -> {\"capability_need\":\"howto\",\"archive_hint\":\"ifixit\",\"resolved_query\":\"fix iphone cracked screen\"}\n"
    "\"population of sweden\" -> {\"capability_need\":\"country_facts\",\"archive_hint\":\"factbook\",\"resolved_query\":\"sweden population\"}\n"
    "\"explain derivatives\" -> {\"capability_need\":\"education\",\"archive_hint\":\"khanacademy\",\"resolved_query\":\"derivatives calculus\"}\n"
    "\"systemd unit syntax\" -> {\"capability_need\":\"technical_reference\",\"archive_hint\":\"archlinux\",\"resolved_query\":\"systemd unit file syntax\"}\n"
    "\"things to do in kyoto\" -> {\"capability_need\":\"geographic\",\"archive_hint\":\"wikivoyage\",\"resolved_query\":\"kyoto attractions\"}\n"
    "\"weather tomorrow\" -> {\"capability_need\":\"weather\",\"archive_hint\":\"\",\"resolved_query\":\"weather tomorrow\"}\n"
    "\"whats playing tonight\" -> {\"capability_need\":\"current_media\",\"archive_hint\":\"\",\"resolved_query\":\"movies playing tonight\"}\n"
    "\"who is leia skywalker\" -> {\"capability_need\":\"encyclopedic\",\"archive_hint\":\"wikipedia\",\"resolved_query\":\"Leia Skywalker\"}\n"
    "\"whens my brothers birthday\" -> {\"capability_need\":\"people_lookup\",\"archive_hint\":\"\",\"resolved_query\":\"brother birthday\"}\n"
    "\"mkbhd latest video\" -> {\"capability_need\":\"youtube\",\"archive_hint\":\"\",\"resolved_query\":\"MKBHD latest video\"}\n"
    "\"latest iphone release date\" -> {\"capability_need\":\"web_search\",\"archive_hint\":\"\",\"resolved_query\":\"latest iphone release date\"}\n"
    "\"add dentist appointment next tuesday\" -> {\"capability_need\":\"calendar\",\"archive_hint\":\"\",\"resolved_query\":\"dentist appointment Tuesday\"}\n"
    "\"set a 10 minute timer\" -> {\"capability_need\":\"timer_reminder\",\"archive_hint\":\"\",\"resolved_query\":\"10 minute timer\"}\n"
    "\"remind me to take out trash at 8pm\" -> {\"capability_need\":\"timer_reminder\",\"archive_hint\":\"\",\"resolved_query\":\"take out trash 8pm\"}\n"
    "\"how long to drive to portland\" -> {\"capability_need\":\"navigation\",\"archive_hint\":\"\",\"resolved_query\":\"drive time to Portland\"}\n"
    "\"convert 30 miles to kilometers\" -> {\"capability_need\":\"conversion\",\"archive_hint\":\"\",\"resolved_query\":\"30 miles to kilometers\"}\n"
    "\"text mom im running late\" -> {\"capability_need\":\"messaging\",\"archive_hint\":\"\",\"resolved_query\":\"text mom running late\"}\n"
    "\"play some jazz\" -> {\"capability_need\":\"music_control\",\"archive_hint\":\"\",\"resolved_query\":\"play jazz\"}\n"
    "\"turn off the kitchen light\" -> {\"capability_need\":\"device_control\",\"archive_hint\":\"\",\"resolved_query\":\"kitchen light off\"}\n"
    "\"whats in the news today\" -> {\"capability_need\":\"news\",\"archive_hint\":\"\",\"resolved_query\":\"news today\"}\n"
    "\"hey whats up\" -> {\"capability_need\":\"none\",\"archive_hint\":\"\",\"resolved_query\":\"\"}\n"
)


def build_routing_prompt(user_text: str, recent_context: str = "") -> str:
    """Assemble the routing prompt with the user's input appended."""
    suffix = f"\n\nCONTEXT: {recent_context}" if recent_context else ""
    return f"{ROUTING_PROMPT}\nINPUT: {user_text}{suffix}\nJSON:"
