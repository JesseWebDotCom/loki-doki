from lokidoki.core.skill_executor import BaseSkill
from lokidoki.skills.datetime_local.skill import DateTimeSkill
from lokidoki.skills.weather_owm.skill import WeatherSkill
from lokidoki.skills.knowledge_wiki.skill import WikipediaSkill
from lokidoki.skills.search_ddg.skill import DuckDuckGoSkill
from lokidoki.skills.tvshows_tvmaze.skill import TVMazeSkill
from lokidoki.skills.movies_tmdb.skill import TMDBSkill
from lokidoki.skills.movies_wiki.skill import WikiMoviesSkill
from lokidoki.skills.weather_openmeteo.skill import OpenMeteoSkill
from lokidoki.skills.smarthome_mock.skill import SmartHomeMockSkill

# Singleton skill instances (stateful for caching)
_skill_instances: dict[str, BaseSkill] = {}


def get_skill_instance(skill_id: str, config: dict  = None) -> BaseSkill :
    """Return a skill instance by skill_id, creating if needed."""
    if skill_id in _skill_instances:
        return _skill_instances[skill_id]

    config = config or {}
    skill: BaseSkill  = None

    if skill_id == "datetime_local":
        skill = DateTimeSkill()
    elif skill_id == "weather_owm":
        skill = WeatherSkill(api_key=config.get("owm_api_key", ""))
    elif skill_id == "knowledge_wiki":
        skill = WikipediaSkill()
    elif skill_id == "search_ddg":
        skill = DuckDuckGoSkill()
    elif skill_id == "tvshows_tvmaze":
        skill = TVMazeSkill()
    elif skill_id == "movies_tmdb":
        skill = TMDBSkill(api_key=config.get("tmdb_api_key", ""))
    elif skill_id == "movies_wiki":
        skill = WikiMoviesSkill()
    elif skill_id == "weather_openmeteo":
        skill = OpenMeteoSkill()
    elif skill_id == "smarthome_mock":
        skill = SmartHomeMockSkill()

    if skill:
        _skill_instances[skill_id] = skill
    return skill


def reset_instances() -> None:
    """Clear cached instances (for testing)."""
    _skill_instances.clear()
