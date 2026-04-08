from lokidoki.core.skill_executor import BaseSkill
from lokidoki.skills.datetime_local.skill import DateTimeSkill
from lokidoki.skills.weather_owm.skill import WeatherSkill
from lokidoki.skills.knowledge_wiki.skill import WikipediaSkill
from lokidoki.skills.search_ddg.skill import DuckDuckGoSkill
from lokidoki.skills.tvshows_tvmaze.skill import TVMazeSkill
from lokidoki.skills.movies_tmdb.skill import TMDBSkill
from lokidoki.skills.movies_wiki.skill import WikiMoviesSkill
from lokidoki.skills.movies_showtimes.skill import MovieShowtimesSkill
from lokidoki.skills.weather_openmeteo.skill import OpenMeteoSkill
from lokidoki.skills.smarthome_mock.skill import SmartHomeMockSkill
from lokidoki.skills.calculator.skill import CalculatorSkill
from lokidoki.skills.unit_conversion.skill import UnitConversionSkill
from lokidoki.skills.dictionary.skill import DictionarySkill
from lokidoki.skills.news_rss.skill import NewsRSSSkill
from lokidoki.skills.recipe_mealdb.skill import RecipeMealDBSkill
from lokidoki.skills.jokes.skill import JokesSkill

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
    elif skill_id == "movies_showtimes":
        skill = MovieShowtimesSkill()
    elif skill_id == "weather_openmeteo":
        skill = OpenMeteoSkill()
    elif skill_id == "smarthome_mock":
        skill = SmartHomeMockSkill()
    elif skill_id == "calculator":
        skill = CalculatorSkill()
    elif skill_id == "unit_conversion":
        skill = UnitConversionSkill()
    elif skill_id == "dictionary":
        skill = DictionarySkill()
    elif skill_id == "news_rss":
        skill = NewsRSSSkill()
    elif skill_id == "recipe_mealdb":
        skill = RecipeMealDBSkill()
    elif skill_id == "jokes":
        skill = JokesSkill()

    if skill:
        _skill_instances[skill_id] = skill
    return skill


def reset_instances() -> None:
    """Clear cached instances (for testing)."""
    _skill_instances.clear()
