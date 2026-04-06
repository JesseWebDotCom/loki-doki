from lokidoki.core.skill_executor import BaseSkill
from lokidoki.skills.datetime_local.skill import DateTimeSkill
from lokidoki.skills.weather_owm.skill import WeatherSkill
from lokidoki.skills.knowledge_wiki.skill import WikipediaSkill

# Singleton skill instances (stateful for caching)
_skill_instances: dict[str, BaseSkill] = {}


def get_skill_instance(skill_id: str, config: dict | None = None) -> BaseSkill | None:
    """Return a skill instance by skill_id, creating if needed."""
    if skill_id in _skill_instances:
        return _skill_instances[skill_id]

    config = config or {}
    skill: BaseSkill | None = None

    if skill_id == "datetime_local":
        skill = DateTimeSkill()
    elif skill_id == "weather_owm":
        skill = WeatherSkill(api_key=config.get("owm_api_key", ""))
    elif skill_id == "knowledge_wiki":
        skill = WikipediaSkill()

    if skill:
        _skill_instances[skill_id] = skill
    return skill


def reset_instances() -> None:
    """Clear cached instances (for testing)."""
    _skill_instances.clear()
