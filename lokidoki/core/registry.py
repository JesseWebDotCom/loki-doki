import json
import os
from pathlib import Path


class SkillRegistry:
    """Dynamic skill discovery and intent aggregation.

    Scans a skills directory for manifest.json files and builds
    a unified intent map for LLM routing.
    """

    def __init__(self, skills_dir: str = "lokidoki/skills"):
        self._skills_dir = Path(skills_dir)
        self.skills: dict[str, dict] = {}
        self._intent_index: dict[str, str] = {}  # "skill_id.intent" -> skill_id

    def scan(self) -> None:
        """Scan the skills directory for manifest.json files."""
        self.skills.clear()
        self._intent_index.clear()

        if not self._skills_dir.exists():
            return

        for entry in sorted(self._skills_dir.iterdir()):
            if not entry.is_dir():
                continue
            manifest_path = entry / "manifest.json"
            if not manifest_path.exists():
                continue
            try:
                with open(manifest_path, "r") as f:
                    manifest = json.load(f)
                skill_id = manifest.get("skill_id", entry.name)
                self.skills[skill_id] = manifest
                for intent in manifest.get("intents", []):
                    qualified = f"{skill_id}.{intent}"
                    self._intent_index[qualified] = skill_id
            except (json.JSONDecodeError, OSError):
                continue

    def get_all_intents(self) -> list[str]:
        """Return all qualified intents across registered skills."""
        return list(self._intent_index.keys())

    def get_skill_by_intent(self, qualified_intent: str) -> dict :
        """Look up a skill manifest by its qualified intent (e.g. 'weather_owm.get_weather')."""
        skill_id = self._intent_index.get(qualified_intent)
        if skill_id is None:
            return None
        return self.skills.get(skill_id)

    def get_skills_by_category(self, category: str) -> list[tuple[str, dict]]:
        """Return ``(skill_id, manifest)`` for every skill that declares
        ``category`` in its manifest ``categories`` list, in registry
        scan order. Used by the orchestrator to resolve a capability
        ("web_search", "encyclopedia") to whichever skill the user has
        installed for it — no skill IDs are hardcoded in routing code.
        """
        out: list[tuple[str, dict]] = []
        for sid, manifest in self.skills.items():
            cats = manifest.get("categories") or []
            if category in cats:
                out.append((sid, manifest))
        return out

    def get_mechanisms(self, skill_id: str) -> list[dict]:
        """Return mechanisms for a skill, sorted by priority (ascending)."""
        manifest = self.skills.get(skill_id)
        if not manifest:
            return []
        mechs = manifest.get("mechanisms", [])
        return sorted(mechs, key=lambda m: m.get("priority", 999))

    def get_intent_map_string(self) -> str:
        """Generate a token-efficient intent map string for LLM prompts."""
        parts = []
        for skill_id, manifest in self.skills.items():
            intents = ",".join(manifest.get("intents", []))
            parts.append(f"{skill_id}:[{intents}]")
        return " | ".join(parts)
