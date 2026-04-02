"""Tests for remote catalog repository normalization."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from app.config import get_app_config
from app.skills.repository import SkillRepository
from app.subsystems.character.repository import CharacterRepository


class CatalogRepositoryTests(unittest.TestCase):
    """Verify repository metadata and remote entry normalization."""

    def setUp(self) -> None:
        self.config = get_app_config()

    def test_character_repository_exposes_catalog_info_and_meta_urls(self) -> None:
        payload = {
            "title": "LokiDoki Characters",
            "description": "Animated AI characters for LokiDoki.",
            "repo_url": "https://github.com/JesseWebDotCom/loki-doki-characters",
            "source_repo_url": "https://github.com/JesseWebDotCom/loki-doki",
            "characters": [
                {
                    "id": "professor",
                    "display_name": "Professor",
                    "description": "Analytical and calm.",
                    "version": "1.0.0",
                    "download_url": "characters/professor/professor.zip",
                    "logo_url": "characters/professor/logo.svg",
                    "meta_url": "characters/professor/meta.json",
                    "default_voice": "en_US-lessac-medium",
                    "wakeword_model_id": "",
                }
            ],
        }
        with patch("app.subsystems.character.repository.fetch_catalog_json", return_value=payload):
            repository = CharacterRepository(self.config)
            info = repository.catalog_info().to_dict()
            entries = repository.list_available()

        self.assertEqual(info["repo_url"], payload["repo_url"])
        self.assertEqual(info["source_repo_url"], payload["source_repo_url"])
        self.assertEqual(entries[0].meta_url, "https://raw.githubusercontent.com/JesseWebDotCom/loki-doki-characters/main/characters/professor/meta.json")
        self.assertEqual(entries[0].download_url, "https://raw.githubusercontent.com/JesseWebDotCom/loki-doki-characters/main/characters/professor/professor.zip")
        self.assertEqual(entries[0].logo_url, "https://raw.githubusercontent.com/JesseWebDotCom/loki-doki-characters/main/characters/professor/logo.svg")

    def test_skill_repository_exposes_catalog_info_and_remote_metadata(self) -> None:
        payload = {
            "title": "LokiDoki Skills",
            "description": "Installable skills for LokiDoki.",
            "repo_url": "https://github.com/JesseWebDotCom/loki-doki-skills",
            "source_repo_url": "https://github.com/JesseWebDotCom/loki-doki",
            "skills": [
                {
                    "id": "home_assistant",
                    "title": "Home Assistant",
                    "description": "Control your home.",
                    "version": "1.1.0",
                    "domain": "home",
                    "domains": ["home"],
                    "platforms": ["mac", "pi_hailo"],
                    "account_mode": "multiple",
                    "download_url": "skills/home_assistant/home_assistant.zip",
                    "logo_url": "skills/home_assistant/logo.svg",
                    "meta_url": "skills/home_assistant/meta.json",
                }
            ],
        }
        with patch("app.skills.repository.fetch_catalog_json", return_value=payload):
            repository = SkillRepository(self.config)
            info = repository.catalog_info()
            entries = repository.list_available()

        self.assertEqual(info["repo_url"], payload["repo_url"])
        self.assertEqual(info["source_repo_url"], payload["source_repo_url"])
        self.assertEqual(entries[0]["account_mode"], "multiple")
        self.assertEqual(entries[0]["platforms"], ["mac", "pi_hailo"])
        self.assertEqual(entries[0]["meta_url"], "https://raw.githubusercontent.com/JesseWebDotCom/loki-doki-skills/main/skills/home_assistant/meta.json")
        self.assertEqual(entries[0]["download_url"], "https://raw.githubusercontent.com/JesseWebDotCom/loki-doki-skills/main/skills/home_assistant/home_assistant.zip")


if __name__ == "__main__":
    unittest.main()
