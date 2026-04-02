"""Tests for staged prompt compaction strategy previews."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app import db
from app.config import get_app_config
from app.subsystems.character import character_service


def _normalized(text: str) -> str:
    """Return one whitespace-normalized string."""
    return " ".join(text.split()).strip()


def _contains_all_markers(text: str, markers: list[str]) -> bool:
    """Return True when every required marker is present."""
    normalized = _normalized(text).lower()
    return all(_normalized(marker).lower() in normalized for marker in markers)


def _join_unique(parts: list[str]) -> str:
    """Join compacted parts while removing exact duplicate sentences."""
    seen: set[str] = set()
    kept: list[str] = []
    for part in parts:
        normalized = _normalized(part)
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        kept.append(normalized)
    return " ".join(kept).strip()


def _fallback_stage(parts: list[str]) -> str:
    """Return a deterministic stage fallback for already compact prose."""
    return _join_unique(parts)


def _compile_layer_subset(layers: dict[str, str]) -> str:
    """Return the current deterministic fallback for one layer subset."""
    return character_service._compact_base_prompt_fallback(layers)  # noqa: SLF001


def _verified_stage(
    proposed: str,
    *,
    required_markers: list[str],
    fallback_text: str,
) -> str:
    """Accept one proposed compact prompt only when required rules survive."""
    candidate = _normalized(proposed)
    if candidate and _contains_all_markers(candidate, required_markers):
        return candidate
    return _normalized(fallback_text)


def _staged_compaction_preview(
    layers: dict[str, str],
    *,
    pair_outputs: dict[str, str] | None = None,
    group_outputs: dict[str, str] | None = None,
    final_output: str = "",
) -> str:
    """Preview a staged compaction flow with verification after each stage."""
    pair_outputs = pair_outputs or {}
    group_outputs = group_outputs or {}

    one_two_layers = {
        "core_safety_prompt": layers["core_safety_prompt"],
        "account_policy_prompt": layers["account_policy_prompt"],
    }
    three_four_layers = {
        "admin_prompt": layers["admin_prompt"],
        "care_profile_prompt": layers["care_profile_prompt"],
    }
    five_six_layers = {
        "character_prompt": layers["character_prompt"],
        "character_custom_prompt": layers["character_custom_prompt"],
    }
    seven_text = layers["user_prompt"]

    one_two = _verified_stage(
        pair_outputs.get("1_2", ""),
        required_markers=[
            "Never claim you completed a real-world action unless a tool or skill confirmed it.",
            "No swearing allowed.",
        ],
        fallback_text=_compile_layer_subset(one_two_layers),
    )
    three_four = _verified_stage(
        pair_outputs.get("3_4", ""),
        required_markers=[
            "Put the most important next step in the first sentence when giving reminders or plans.",
            "Keep messages safe.",
        ],
        fallback_text=_compile_layer_subset(three_four_layers),
    )
    five_six = _verified_stage(
        pair_outputs.get("5_6", ""),
        required_markers=[
            'Start replies with "NOOOP!"',
            '"YAH bro"',
        ],
        fallback_text=_compile_layer_subset(five_six_layers),
    )

    group_a_fallback = _fallback_stage([one_two, three_four])
    group_b_fallback = _fallback_stage([
        five_six,
        seven_text,
    ])

    group_a = _verified_stage(
        group_outputs.get("a", ""),
        required_markers=[
            "No swearing allowed.",
            "Put the most important next step in the first sentence when giving reminders or plans.",
        ],
        fallback_text=group_a_fallback,
    )
    group_b = _verified_stage(
        group_outputs.get("b", ""),
        required_markers=[
            'Start replies with "NOOOP!"',
            '"YAH bro"',
            "Keep answers short unless I ask for more detail.",
            "If you suggest a plan, include one simple next step.",
        ],
        fallback_text=group_b_fallback,
    )

    return _verified_stage(
        final_output,
        required_markers=[
            "No swearing allowed.",
            "Keep answers short unless I ask for more detail.",
            "If you suggest a plan, include one simple next step.",
            'Start replies with "NOOOP!"',
            '"YAH bro"',
        ],
        fallback_text=_fallback_stage([group_a, group_b]),
    )


class PromptCompactionStrategyTests(unittest.TestCase):
    """Verify staged prompt-compaction previews preserve required rules."""

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        database_path = Path(self.tempdir.name) / "lokidoki.db"
        self.conn = db.connect(database_path)
        db.initialize_database(self.conn)
        self.config = get_app_config()
        self.user = db.create_user(
            self.conn,
            username="jesse",
            display_name="Jesse",
            password_hash="hashed",
        )
        character_service.initialize(self.conn, self.config)
        character_service.update_prompt_policy(
            self.conn,
            "default-account",
            {
                "account_policy_prompt": (
                    "Never claim you completed a real-world action unless a tool or skill confirmed it. "
                    "Keep household-assistant responses concise, practical, and honest about uncertainty.\n\n"
                    "No swearing allowed."
                ),
            },
        )
        character_service.update_user_overrides(
            self.conn,
            self.user["id"],
            {
                "admin_prompt": (
                    "Speak to this user in a calm, reassuring tone. "
                    "Put the most important next step in the first sentence when giving reminders or plans."
                ),
            },
        )
        character_service.update_user_settings(
            self.conn,
            self.user["id"],
            {
                "care_profile_id": "standard",
                "user_prompt": (
                    "Call me Jesse. Keep answers short unless I ask for more detail. "
                    "If you suggest a plan, include one simple next step."
                ),
                "character_customizations": {
                    "lokidoki": (
                        'Start replies with "NOOOP!". '
                        'When you end a reply, append "YAH bro".'
                    ),
                },
            },
        )

    def tearDown(self) -> None:
        self.conn.close()
        self.tempdir.cleanup()

    def test_current_bad_one_shot_output_drops_required_rules(self) -> None:
        bad_output = (
            "You are LokiDoki, a cheerful, grounded, privacy-first household assistant running on Jesse's own "
            "device. Be honest about uncertainty and Speak to Jesse in a calm, reassuring tone, keeping responses "
            "concise, practical, and honest about uncertainty. Label: Adult Standard; Tone:"
        )

        self.assertFalse(
            _contains_all_markers(
                bad_output,
                [
                    "No swearing allowed.",
                    'Start replies with "NOOOP!"',
                    '"YAH bro"',
                ],
            )
        )

    def test_staged_preview_falls_back_when_stage_outputs_drop_rules(self) -> None:
        state = character_service.resolve_prompt_state(self.conn, self.user)
        preview = _staged_compaction_preview(
            state["non_empty_layers"],
            pair_outputs={
                "1_2": "You are LokiDoki on Jesse's device. Be honest about uncertainty.",
                "3_4": "Use a calm and helpful tone.",
                "5_6": "You are LokiDoki, cheerful and grounded.",
            },
            group_outputs={
                "a": "Be honest, calm, and concise.",
                "b": "Be playful and direct.",
            },
            final_output="You are LokiDoki. Be helpful.",
        )

        self.assertIn("No swearing allowed.", preview)
        self.assertIn('Start replies with "NOOOP!"', preview)
        self.assertIn('"YAH bro"', preview)
        self.assertIn("Keep answers short unless I ask for more detail.", preview)
        self.assertIn("If you suggest a plan, include one simple next step.", preview)

    def test_staged_preview_accepts_compact_output_when_required_rules_survive(self) -> None:
        state = character_service.resolve_prompt_state(self.conn, self.user)
        preview = _staged_compaction_preview(
            state["non_empty_layers"],
            pair_outputs={
                "1_2": (
                    "You are LokiDoki on Jesse's device. Be honest about uncertainty. "
                    "Never claim you completed a real-world action unless a tool or skill confirmed it. "
                    "No swearing allowed."
                ),
                "3_4": (
                    "Use a calm, reassuring style. Keep messages safe. "
                    "Put the most important next step in the first sentence when giving reminders or plans."
                ),
                "5_6": (
                    "Be cheerful, grounded, and playful when appropriate. "
                    'Start replies with "NOOOP!" and append "YAH bro" at the end.'
                ),
            },
            group_outputs={
                "a": (
                    "You are LokiDoki on Jesse's device. Be honest about uncertainty, never invent completed "
                    "actions, never swear, keep messages safe, and put the most important next step first."
                ),
                "b": (
                    'Be cheerful, grounded, and playful when appropriate. Start replies with "NOOOP!", append '
                    '"YAH bro" at the end, keep answers short unless I ask for more detail, and include one simple '
                    "next step when you suggest a plan."
                ),
            },
            final_output=(
                "You are LokiDoki on Jesse's device. Be honest about uncertainty, never invent completed actions, "
                "never swear, keep messages safe, and put the most important next step first. Be cheerful, "
                'grounded, and playful when appropriate. Start replies with "NOOOP!", append "YAH bro" at the end, '
                "keep answers short unless I ask for more detail, and include one simple next step when you suggest "
                "a plan."
            ),
        )

        self.assertTrue(
            "never swear" in preview.lower() or "no swearing allowed." in preview.lower()
        )
        self.assertIn('Start replies with "NOOOP!"', preview)
        self.assertIn('"YAH bro"', preview)
        self.assertIn("keep answers short unless i ask for more detail", preview.lower())


if __name__ == "__main__":
    unittest.main()
