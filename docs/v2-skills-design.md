# V2 Skills Design

Last updated: 2026-04-11

This document is the design and current-state specification for the
LokiDoki v2 skills system.

It serves four purposes:

1. Define the architecture standards for standalone v2 skills.
2. Define the registry model: capability registry, skill registry, and runtime registry.
3. Record the current implementation state of the v2 skill surface and its v1 migration status.
4. Define the phased plan to bring all v2 skills to the target architecture.

If this file conflicts with older prototype notes, the design standards
and migration rules in this document win.

## Legend

| Label | Meaning |
|---|---|
| `real/provider` | Real live provider or API-backed capability |
| `real/local` | Real working capability, but backed by local JSON/mock/curated KB rather than final production integration |
| `limited` | Real but intentionally narrow coverage |
| `stub-fallback` | LLM-backed when enabled, deterministic stub otherwise |
| `builtin` | Deterministic built-in utility, no external provider |
| `full port` | v2 preserves the main v1 capability surface/backend |
| `partial port` | v2 uses part of the v1 capability/backend but not all of it |
| `replacement` | v2 intentionally replaced the v1 path with a new backend |
| `missing` | v1 capability/package exists but is not exposed in v2 |

## Standalone Skill Architecture Rules

These rules are required for the v2 migration to be considered complete.

| Rule | Requirement |
|---|---|
| Provider-specific packaging | Every concrete skill integration must live in its own standalone package/module, named for its backend or mechanism family, following the v1 pattern such as `weather_openmeteo`, `weather_owm`, `smarthome_homeassistant`, `jokes_icanhazdadjoke`, `jokes_jokes4us`. |
| No domain-monolith handlers | We should not keep a single hardcoded domain adapter like "the jokes skill" or "the weather skill" when multiple independent providers may exist. Domain-level capabilities should route to provider-specific skills through the registry, not import one provider directly in code. |
| Unique identity per skill | Each standalone skill must have its own unique package/module name, manifest, human-readable name, description, and favicon/icon asset. Two different providers in the same domain are two different skills. |
| Shared schema/base, separate implementations | Skills should follow the common schema/base contract, but implementation code must remain separate per skill. Shared helper code is fine; shared provider-specific handler files are not. |
| Optional skill safety | v2 runtime code must not hardcode imports to optional provider skills that may or may not be installed. Skills should be discovered from manifests/registry and loaded dynamically, like v1, rather than importing specific provider modules in central runtime files. |
| User/global config contract | Every skill must receive merged config the v1 way: global defaults first, user overrides on top, exposed as per-skill `_config`/merged config. Hardcoded placeholders like `_DEFAULT_LOCATION = "your area"` are not acceptable when the skill already declares config such as `default_location` or `default_zip`. |
| No user-text reparsing inside skills | Skills must not parse `payload["chunk_text"]` with local heuristics to recover user intent or missing typed params. If a capability needs `location`, `zip`, `movie_title`, `person`, `date`, or similar fields, decomposition/resolution must emit them structurally in `params`. Machine-text repair of model output is acceptable; reinterpreting the user's text inside each skill is not. |
| Capability-to-skill separation | User-facing capabilities can stay domain-oriented like `get_weather` or `tell_joke`, but implementation selection must happen through standalone skills. Example: `get_weather` can resolve to `weather_openmeteo` or `weather_owm`; `tell_joke` can resolve to `jokes_icanhazdadjoke` or `jokes_jokes4us`. |
| Config ownership | Config keys belong to the standalone skill that declares them. Weather provider A's default location config must not be silently borrowed by weather provider B unless the schema explicitly supports shared inheritance. |

### Immediate Design Consequences

| Problem today | Required direction |
|---|---|
| `v2/orchestrator/skills/weather.py` directly imports `OpenMeteoSkill` and hardcodes `_DEFAULT_LOCATION = "your area"` | Replace with provider-specific standalone skill loading plus merged per-skill config, matching the v1 `skill_config` contract. |
| `v2/orchestrator/skills/showtimes.py` hardcodes a fixture ZIP fallback | Replace with merged config from the standalone showtimes skill, like v1 Fandango's `default_zip`. |
| Central v2 files directly import provider modules such as `from lokidoki.skills.weather_openmeteo.skill import OpenMeteoSkill` | Move toward registry/discovery-based loading so optional skills are not assumed to exist. |
| Domain wrappers mix multiple responsibilities in one file | Split provider implementations into standalone packages and keep only thin selection/execution code at the domain/capability layer. |
| Skills recover missing fields by reparsing `payload["chunk_text"]` with helpers like `_extract_location(...)` | Move all user-text understanding and typed field extraction upstream into decomposition/resolution. Skills should consume structured `params` plus merged `_config`, not re-run ad hoc parsing on raw user text. |

## Runtime V2 Capability Table

| Domain | Capability | Handler | Actual backend today | State | V1 lineage | Needs external/current source? | Wired today? | Notes |
|---|---|---|---|---|---|---|---|---|
| Conversation | `greeting_response`, `greet` | `core.greetings.reply` | deterministic built-in reply | `builtin` | rewrite | No | Yes | Two capability names hit the same built-in path. |
| Conversation | `acknowledgment_response`, `acknowledge` | `core.acknowledgments.reply` | deterministic built-in reply | `builtin` | rewrite | No | Yes | Two capability names hit the same built-in path. |
| Conversation | `chat`, `direct_chat` | `fallback.direct_chat` | echo/fallback conversational path | `limited` | rewrite | No | Yes | Not a rich standalone chat model. |
| Time | `get_current_time` | `core.time.get_local_time` | system clock | `builtin` | replacement of `datetime_local` | No | Yes | v2 split date/time into smaller built-ins instead of wrapping v1 `datetime_local`. |
| Time | `get_current_date` | `core.date.get_local_date` | system clock | `builtin` | replacement of `datetime_local` | No | Yes | Same architectural split as above. |
| Time | `get_time_in_location` | `core.time.location` | `zoneinfo` + static city map | `limited` | replacement of `datetime_local` | No | Yes | Catalog already marks this as needing a fuller timezone resolver. |
| Time | `time_until` | `core.time.until` | local date math + holiday lookup | `real/provider` | rewrite | No | Yes | Depends on holiday adapter for named holidays. |
| Holidays | `get_holiday` | `skills.holidays.lookup` | Nager.Date | `real/provider` | new in v2 | Yes | Yes | Live public-holiday API. |
| Holidays | `list_holidays` | `skills.holidays.list` | Nager.Date | `real/provider` | new in v2 | Yes | Yes | Live public-holiday API. |
| Spelling/Dictionary | `spell_word` | `core.dictionary.spell` | deterministic word echo | `limited` | rewrite | No | Yes | Only repeats the target word; not a phonetic spelling engine. |
| Spelling/Dictionary | `lookup_definition`, `define_word` | `skills.dictionary.lookup` | `dictionaryapi.dev` | `real/provider` | full port of v1 `dictionary` | Yes | Yes | Alias pair to the same v1-backed adapter. |
| Math | `calculate_tip` | `core.calculator.tip` | local arithmetic | `builtin` | rewrite | No | Yes | Prototype-local math, no provider needed. |
| Math | `calculate` | `core.calculator.evaluate` | safe eval via v1 calculator logic | `real/provider` | full port of v1 `calculator` | No | Yes | Alias form of the calculator surface. |
| Units | `convert_units`, `convert` | `core.units.convert` | offline conversion tables | `real/provider` | full port of v1 `unit_conversion` | No | Yes | Alias pair to the same offline conversion backend. |
| Currency | `convert_currency` | `skills.finance.convert_currency` | Frankfurter | `real/provider` | new in v2 | Yes | Yes | Live exchange-rate provider. |
| Currency | `get_exchange_rate` | `skills.finance.exchange_rate` | Frankfurter | `real/provider` | new in v2 | Yes | Yes | Live exchange-rate provider. |
| Weather | `get_weather`, `get_forecast` | `skills.weather.forecast` | Open-Meteo + local cache | `real/provider` | replacement of v1 `weather_owm`; partial port of v1 `weather_openmeteo` | Yes | Yes, but config is partial | Runtime uses the v1 Open-Meteo skill, but not the old OWM path. Default-location config from v1 is not fully carried through. |
| Knowledge | `knowledge_query`, `query` | `core.knowledge.lookup` | Wikipedia + DDG scored in parallel | `real/provider` | partial port of v1 `knowledge_wiki` + partial port of v1 `search_ddg` | Yes | Yes | Stronger than v1 wiki-only because it adds DDG, but generic `search_web` is still not a first-class capability. |
| News | `get_news_headlines` | `skills.news.google_rss` | Google News RSS via v1 news adapter | `real/provider` | full port of v1 `news_rss` | Yes | Yes | Current news source is wired. |
| News | `get_briefing` | `skills.news.briefing` | Google News RSS | `real/provider` | partial port of v1 `news_rss` | Yes | Yes | Short top-stories briefing. |
| News | `search_news` | `skills.news.search` | Google News RSS search | `real/provider` | replacement for v1 `search_ddg.search_news` | Yes | Yes | V2 uses Google News RSS instead of general DDG news search. |
| Recipes | `find_recipe` | `skills.recipes.themealdb` | TheMealDB via v1 adapter | `real/provider` | full port of v1 `recipe_mealdb` | Yes | Yes | Live recipe provider. |
| Jokes | `tell_joke` | `skills.jokes.icanhazdadjoke` | icanhazdadjoke via v1 adapter | `real/provider` | full port of v1 `jokes` | Yes | Yes | Live joke provider. |
| TV | `lookup_tv_show` | `skills.tv.tvmaze` | TVMaze + local cache | `real/provider` | partial port of v1 `tvshows_tvmaze` | Yes | Yes | Details path exists, but v1 episode-listing surface is not fully preserved. |
| TV | `get_tv_schedule` | `skills.tv.schedule` | TVMaze schedule fields + local cache | `real/provider` | partial port of v1 `tvshows_tvmaze` | Yes | Yes, but limited | Catalog already notes richer episode/channel/date scheduling is still missing. |
| Movies | `get_movie_showtimes` | `skills.movies.showtimes` | Fandango adapter subset + cache | `real/provider` | partial port of v1 `movies_fandango`; replacement for v1 `movies_showtimes` | Yes | Yes, but config is partial | v2 only uses a subset of Fandango mechanisms and hardcodes a default ZIP instead of using v1 config. |
| Media | `get_streaming` | `skills.media.streaming` | curated local catalog, then TVMaze fallback for TV | `real/local` | replacement | Yes | Partially | Registry text says live web search, but movies are not wired to a live availability provider. |
| Media | `recall_recent_media` | `context.media.recall_recent` | recent conversation context | `real/local` | new in v2 | No | Partially | Depends on ephemeral conversation context, not persisted media memory. |
| People | `lookup_person_birthday`, `lookup_birthday` | `core.people.birthday` | people resolver / prototype people data | `real/local` | partial replacement of v1 `people_lookup` | No, but needs real people DB | Partially | Surface exists, but runtime still instantiates empty `PeopleDBAdapter()` instead of the real SQLite-backed adapter. |
| People | `lookup_fact` | `skills.people.fact` | Wikidata entity/property lookup | `real/provider` | replacement | Yes | Yes | Structured coverage is limited to a small set of fact properties. |
| Calendar | `create_event` | `device.calendar.create` | local JSON calendar store | `real/local` | new in v2 | No, but needs native integration | Partially | Not yet wired to EventKit/CalDAV/native calendar APIs. |
| Calendar | `get_events` | `device.calendar.get` | local JSON calendar store | `real/local` | new in v2 | No, but needs native integration | Partially | Prototype-local only. |
| Calendar | `update_event` | `device.calendar.update` | local JSON calendar store | `real/local` | new in v2 | No, but needs native integration | Partially | Prototype-local only. |
| Calendar | `delete_event` | `device.calendar.delete` | local JSON calendar store | `real/local` | new in v2 | No, but needs native integration | Partially | Prototype-local only. |
| Alarms | `set_alarm` | `device.alarm.set` | local JSON alarm store | `real/local` | new in v2 | No, but needs OS integration | Partially | Prototype-local only. |
| Alarms | `set_timer` | `device.timer.set` | local JSON timer store | `real/local` | new in v2 | No, but needs OS integration | Partially | Prototype-local only. |
| Alarms | `set_reminder` | `device.reminder.set` | local JSON reminder store | `real/local` | new in v2 | No, but needs OS integration | Partially | Prototype-local only. |
| Alarms | `cancel_alarm` | `device.alarm.cancel` | local JSON alarm store | `real/local` | new in v2 | No, but needs OS integration | Partially | Prototype-local only. |
| Alarms | `list_alarms` | `device.alarm.list` | local JSON alarm store | `real/local` | new in v2 | No, but needs OS integration | Partially | Prototype-local only. |
| Contacts | `search_contacts` | `device.contacts.search` | local JSON contacts store | `real/local` | new in v2 | No, but needs native contacts integration | Partially | Prototype-local only. |
| Messaging | `read_messages` | `device.messages.read` | local JSON message store | `real/local` | new in v2 | No, but needs real transport/source | Partially | Read path is local prototype data. |
| Messaging | `send_text_message`, `send_text` | `skills.messaging.send_text` | local JSON message sender | `real/local` | new in v2 | Yes, for real sending | No | Message drafting/write works in prototype, but not real SMS/iMessage transport. |
| Email | `read_emails` | `device.emails.read` | local JSON inbox store | `real/local` | new in v2 | Yes, for real inbox | No | Prototype inbox only. |
| Email | `generate_email` | `skills.writing.email` | Ollama LLM when enabled, stub otherwise | `stub-fallback` | new in v2 | No provider required beyond LLM | Partial | Usable only when LLM is enabled; otherwise deterministic stub. |
| Calls | `make_call` | `device.phone.call` | local call-log backend | `real/local` | new in v2 | Yes, for real dialer | No | Not wired to actual telephony. |
| Notes | `create_note` | `device.notes.create` | local JSON notes store | `real/local` | new in v2 | No, but needs native notes integration | Partially | Prototype-local only. |
| Notes | `append_to_list` | `device.notes.append_list` | local JSON notes/list store | `real/local` | new in v2 | No, but needs native notes integration | Partially | Prototype-local only. |
| Notes | `read_list` | `device.notes.read_list` | local JSON notes/list store | `real/local` | new in v2 | No, but needs native notes integration | Partially | Prototype-local only. |
| Notes | `search_notes` | `device.notes.search` | local JSON notes store | `real/local` | new in v2 | No, but needs native notes integration | Partially | Prototype-local only. |
| Music | `play_music` | `device.music.play` | local playback-state store | `real/local` | new in v2 | Yes, for real playback control | No | Not wired to Spotify/OS playback. |
| Music | `control_playback` | `device.music.control` | local playback-state store | `real/local` | new in v2 | Yes, for real playback control | No | Prototype-local only. |
| Music | `get_now_playing` | `device.music.now_playing` | local playback-state store | `real/local` | new in v2 | Yes, for real playback control | No | Prototype-local only. |
| Music | `set_volume` | `device.music.volume` | local playback-state store | `real/local` | new in v2 | Yes, for real playback control | No | Prototype-local only. |
| Music | `lookup_track` | `skills.music.lookup_track` | MusicBrainz | `real/provider` | new in v2 | Yes | Yes | Real metadata provider. |
| Navigation | `get_directions` | `skills.navigation.directions` | Nominatim + OSRM | `real/provider` | new in v2 | Yes | Yes | Driving-oriented path. |
| Navigation | `get_eta` | `skills.navigation.eta` | Nominatim + OSRM | `real/provider` | new in v2 | Yes | Yes | Simplified origin assumption. |
| Navigation | `find_nearby` | `skills.navigation.nearby` | Nominatim + Overpass | `real/provider` | new in v2 | Yes | Yes | Real live map data. |
| Transit | `get_transit` | `skills.navigation.transit` | curated metro KB | `real/local` | replacement | Yes | No | Registry copy still says live web search, but runtime is local KB only. |
| Travel | `search_flights` | `skills.travel.flights.search` | curated airline route KB | `real/local` | replacement | Yes | No | Registry says live web search, but runtime is local routes only. Upgrade target is Amadeus/Google Flights. |
| Travel | `get_flight_status` | `skills.travel.flight_status` | OpenSky live states API | `real/provider` | new in v2 | Yes | Yes | Real provider, but response is callsign/airborne-state oriented. |
| Travel | `search_hotels` | `skills.travel.hotels.search` | curated hotel KB | `real/local` | replacement | Yes | No | Registry says live web search, but runtime is local curated picks. |
| Travel | `get_visa_info` | `skills.travel.visa` | curated visa KB | `real/local` | replacement | Yes | No | Registry says live web search, but runtime is local visa rules only. |
| Health | `look_up_symptom` | `skills.health.symptom` | MedlinePlus search | `real/provider` | new in v2 | Yes | Yes | Live medical source. |
| Health | `check_medication` | `skills.health.medication` | RxNorm approximate + properties | `real/provider` | new in v2 | Yes | Yes | Live medical source. |
| Fitness | `log_workout` | `device.fitness.log` | local JSON workout log | `real/local` | new in v2 | No, but needs native fitness integration | Partially | Prototype-local only. |
| Fitness | `get_fitness_summary` | `device.fitness.summary` | local JSON workout log | `real/local` | new in v2 | No, but needs native fitness integration | Partially | Prototype-local only. |
| Smart Home | `control_device` | `skills.home_assistant.toggle` | v1 mock smart-home backend | `real/local` | partial port of v1 `smarthome_mock` | Yes, for production HA | No | Works only against prototype/mock state, not real Home Assistant or Matter. |
| Smart Home | `get_device_state` | `skills.home_assistant.state` | v1 mock smart-home backend | `real/local` | partial port of v1 `smarthome_mock` | Yes, for production HA | No | Same limitation as above. |
| Smart Home | `get_indoor_temperature` | `skills.sensors.indoor_temperature` | v1 mock thermostat state | `real/local` | partial port of v1 `smarthome_mock` | Yes, for production HA | No | Same limitation as above. |
| Smart Home | `detect_presence` | `skills.presence.detect` | local presence JSON store | `real/local` | replacement | Yes, for production HA | No | Catalog notes this is store-backed, not a real HA occupancy feed. |
| Smart Home | `set_scene` | `skills.home_assistant.scene` | v2 local scene composition over mock backend | `real/local` | partial port of v1 `smarthome_mock` | Yes, for production HA | No | Needs real HA scene integration. |
| Food | `find_recipe` | `skills.recipes.themealdb` | TheMealDB | `real/provider` | full port of v1 `recipe_mealdb` | Yes | Yes | Included above for completeness. |
| Food | `substitute_ingredient` | `skills.food.substitute` | tiny local substitution table | `limited` | new in v2 | No | Yes | Coverage is intentionally narrow. |
| Food | `get_nutrition` | `skills.food.nutrition` | Open Food Facts | `real/provider` | new in v2 | Yes | Yes | Real nutrition provider. |
| Food | `order_food` | `skills.food.order` | local order draft store | `real/local` | new in v2 | Yes, for real ordering | No | Not wired to delivery providers. |
| Finance | `get_stock_price` | `skills.finance.stock_price` | Yahoo quote endpoint | `real/provider` | new in v2 | Yes | Yes | Real quote provider. |
| Finance | `get_stock_info` | `skills.finance.stock_info` | Yahoo quote endpoint | `real/provider` | new in v2 | Yes | Yes | Real quote metadata, not full company profile. |
| Sports | `get_score` | `skills.sports.score` | ESPN scoreboard JSON | `real/provider` | new in v2 | Yes | Yes | Registry text says live web search, but the actual backend is ESPN. |
| Sports | `get_standings` | `skills.sports.standings` | ESPN standings JSON | `real/provider` | new in v2 | Yes | Yes | Registry text says live web search, but the actual backend is ESPN. |
| Sports | `get_schedule` | `skills.sports.schedule` | ESPN scoreboard JSON | `real/provider` | new in v2 | Yes | Yes | Registry text says live web search, but the actual backend is ESPN. |
| Sports | `get_player_stats` | `skills.sports.player_stats` | placeholder/error path | `limited` | new in v2 | Yes | No | Registry advertises `ddg_search`, but the handler still returns “provider wiring still in progress.” |
| Writing | `summarize_text`, `summarize` | `skills.writing.summarize` | Ollama LLM when enabled, stub otherwise | `stub-fallback` | new in v2 | No provider required beyond LLM | Partial | Alias pair to the same handler. |
| Writing | `translate` | `skills.writing.translate` | MyMemory translation API | `real/provider` | new in v2 | Yes | Yes | Real provider today, not local/self-hosted. |
| Code | `code_assistance`, `assist` | `skills.code.assistant` | Ollama LLM when enabled, stub otherwise | `stub-fallback` | new in v2 | No provider required beyond LLM | Partial | Alias pair to the same handler. |
| Planning | `create_plan` | `skills.planning.create_plan` | Ollama LLM when enabled, stub otherwise | `stub-fallback` | new in v2 | No provider required beyond LLM | Partial | Works only with LLM enabled. |
| Decision | `weigh_options` | `skills.decision.weigh_options` | Ollama LLM when enabled, stub otherwise | `stub-fallback` | new in v2 | No provider required beyond LLM | Partial | Works only with LLM enabled. |
| Support | `emotional_support`, `empathize` | `skills.support.empathy` | Ollama LLM when enabled, stub otherwise | `stub-fallback` | new in v2 | No provider required beyond LLM | Partial | Alias pair to the same handler. |
| Shopping | `find_products` | `skills.shopping.find_products` | curated catalog + local JSON overlay | `real/local` | new in v2 | Yes, for real/current recommendations | No | Explicitly a local stopgap until a real commerce/catalog provider is added. |

## V1 Skill Package Port Status

| V1 package | V1 intent surface | V2 status | How it maps today | Notes |
|---|---|---|---|---|
| `calculator` | arithmetic evaluation | `full port` | `calculate`, plus tip math added separately | v2 reuses the v1 calculator backend. |
| `datetime_local` | date/time/timezone | `replacement` | split into built-ins + `get_time_in_location` | Functionality mostly preserved, but not as a direct adapter. |
| `dictionary` | definition lookup | `full port` | `lookup_definition`, `define_word` | Direct v1-backed adapter. |
| `jokes` | joke lookup | `full port` | `tell_joke` | Direct v1-backed adapter. |
| `knowledge_wiki` | Wikipedia knowledge lookup | `partial port` | folded into `knowledge_query`/`query` | v2 adds DDG in parallel, so this is preserved but not standalone. |
| `movies_fandango` | showtimes, now playing, movie overview, theater details, coming soon | `partial port` | only `get_movie_showtimes` | Most of the richer Fandango surface is not exposed in v2. |
| `movies_showtimes` | DDG-based showtimes | `replacement` | superseded by Fandango-based `get_movie_showtimes` | Old generic search path is no longer the runtime surface. |
| `movies_tmdb` | movie detail/search | `missing` | none | No v2 movie detail/search capability today. |
| `movies_wiki` | movie detail/search | `missing` | none | No v2 movie detail/search capability today. |
| `news_rss` | headlines/news search | `full port` | `get_news_headlines`, `get_briefing`, `search_news` | Direct v1-backed adapter with some reshaping. |
| `people_lookup` | relationship lookup, family listing | `missing` | partial conceptual replacement via birthday/person resolver only | Real relationship/family lookup surface from v1 is not exposed in v2. |
| `recipe_mealdb` | recipe lookup | `full port` | `find_recipe` | Direct v1-backed adapter. |
| `search_ddg` | generic web search, news search | `partial port` | used internally by `knowledge_query`; orphan helper exists in `search_web.py` | There is no first-class `search_web` capability in the v2 registry. |
| `smarthome_mock` | mock device state/actions | `partial port` | `control_device`, `get_device_state`, `get_indoor_temperature`, `set_scene` | Still mock/local, not real HA integration. |
| `trivia_opentdb` | trivia | `missing` | none | Directory exists, but no manifest/implementation surfaced in the repo audit. |
| `tvshows_tvmaze` | TV detail, episode listing | `partial port` | `lookup_tv_show`, `get_tv_schedule` | Schedule exists; richer episode/detail surface is not fully preserved. |
| `unit_conversion` | unit conversion | `full port` | `convert_units`, `convert` | Direct v1-backed adapter. |
| `weather_openmeteo` | weather/forecast | `partial port` | `get_weather`, `get_forecast` | Core backend preserved, but v1 config/default-location behavior is not fully wired. |
| `weather_owm` | weather/forecast via OWM | `missing` | none | Intentionally replaced by Open-Meteo in v2. |

## Key Gaps To Prioritize

| Priority | Gap | Why it matters |
|---|---|---|
| High | Wire real people storage into runtime resolver | `lookup_birthday` and any future family/relationship surface depend on a real people graph, but runtime still uses empty in-memory `PeopleDBAdapter()`. |
| High | Add first-class generic web-search capability | v1 `search_ddg.search_web` no longer exists as a routable v2 capability even though DDG is still present in the codebase. |
| High | Wire a real player-stats provider | `get_player_stats` is still effectively unimplemented. |
| High | Replace local travel KBs with real providers | `search_flights`, `search_hotels`, and `get_visa_info` all present as user-facing capabilities but are still curated/local. |
| High | Replace local streaming catalog with a real movie provider | `get_streaming` is only live for some TV via TVMaze; movie streaming is curated. |
| Medium | Restore movie detail/search surface | v1 had TMDB and Wikipedia movie-detail/search packages; v2 currently has no equivalent capability. |
| Medium | Restore relationship/family lookup surface | v1 `people_lookup` offered relationship-oriented queries that do not currently exist in v2. |
| Medium | Remove config regressions in weather/showtimes | v1 had default-location/default-ZIP config; v2 currently hardcodes fallback values in key places. |
| Medium | Replace mock smart-home runtime with real HA/file-backed adapter | Current smart-home surface is still prototype-only. |
| Medium | Populate source metadata/citations end-to-end | Even provider-backed skills do not consistently surface citations through the v2 response object yet. |

## Phased Design To Reach Fully Working V2 Skills

The goal is not just to make every capability "respond", but to make every v2 skill meet the same bar:

- routable through `v2/data/function_registry.json`
- backed by the real runtime adapter, not a placeholder or orphan helper
- implemented as a standalone provider-specific skill package, not a domain-monolith file
- fed by the correct provider or native/local integration for its domain
- loaded dynamically rather than hard-imported as though every optional skill is installed
- receiving merged per-skill config with v1 global-then-user override semantics
- consuming typed structured params from decomposition/resolution rather than reparsing raw `chunk_text`
- carrying source metadata where external facts are involved
- covered by unit + integration tests and a phase gate

The safest path is to land this in dependency order.

### Phase 1 — Foundation And Contract Cleanup

| Item | Design |
|---|---|
| Goal | Make the registry, handler wiring, and capability contracts truthful before adding new providers. |
| Why first | Right now several capability descriptions promise "live web search" while the runtime uses curated local KBs. That makes the system hard to reason about and will sabotage future migration work. |
| Work | Define the canonical v2 standalone-skill contract: every concrete integration is its own provider-specific skill package with unique name, description, icon/favicon, manifest, and config schema. This should mirror the v1 provider naming style rather than domain-monolith files. |
| Work | Separate domain capabilities from provider implementations. Capability names can stay user-facing (`get_weather`, `tell_joke`), but implementation entries in the registry must point to standalone skills such as `weather_openmeteo`, `weather_owm`, `jokes_icanhazdadjoke`, `jokes_jokes4us`. |
| Work | Normalize `function_registry.json` descriptions/mechanisms so they match the real handler behavior for travel, streaming, sports, and people. Remove or clearly mark legacy alias capabilities that only exist for compatibility. Add a `maturity` or `state` field to every registry entry so the runtime, dev tools, and docs all read from one canonical value. |
| Work | Standardize one contract for all skills: `output_text`, `success`, `mechanism_used`, `data`, and `sources`. Require this in every adapter, including built-ins and local skills. |
| Work | Remove central hard imports of optional provider skills from runtime files. Runtime selection should discover installed standalone skills from manifests/registry and only load what actually exists. |
| Work | Audit orphan modules such as `v2/orchestrator/skills/search_web.py` and either register them as first-class capabilities or delete/inline them so there is no shadow surface that is not actually routable. |
| Work | Restore v1 config passthrough where already supported by the old skill packages: weather default location, Fandango `default_zip`, preferred theater, and other per-user/default config fields. Replace hardcoded fallbacks like `_DEFAULT_LOCATION = "your area"` and hardcoded fixture ZIP defaults with merged per-skill config resolution. |
| Work | Ban skill-local user-text heuristics for missing parameters. If a skill currently contains helper code that reparses `chunk_text` to find `location`, `zip`, `title`, `origin`, `destination`, or similar fields, move that logic upstream into decomposer schema + resolver output so the skill only reads structured `params`. |
| Gate | Every entry in `function_registry.json` accurately describes its real backend and mechanisms; no capability points to dead or misleading semantics. |
| Gate | Every skill result type includes the same provenance fields, even if `sources=[]` for local skills. |
| Gate | No central runtime module assumes a specific optional provider skill is installed by importing it directly. |
| Gate | Every standalone skill with config needs reads merged global/user config instead of hardcoded pseudo-defaults. |
| Gate | No skill recovers missing user intent by reparsing raw `chunk_text`; required user fields arrive structurally in `params` or are intentionally absent. |

### Phase 2 — Core Runtime Wiring

| Item | Design |
|---|---|
| Goal | Replace placeholder runtime adapters with the real adapters that already exist in the codebase. |
| Why second | Several skills are blocked not by missing providers, but by runtime wiring that still uses empty/default adapters. |
| Work | Introduce a dynamic skill-loader seam for v2 so provider-specific skills are selected from the registry/runtime manifest rather than imported directly by executor modules. |
| Work | Extend decomposition/resolution so capabilities receive typed parameter extraction for the fields their skills actually need. This is the right place to infer `location`, `zip`, `movie title`, `flight number`, `origin`, `destination`, `city`, and similar inputs. |
| Work | Wire `LokiPeopleDBAdapter` into `v2/orchestrator/resolution/resolver.py` instead of `PeopleDBAdapter()`, passing the authenticated user and the real `MemoryProvider` path through the context, as called out in `docs/v2-graduation-plan.md`. |
| Work | Replace `HomeAssistantAdapter()` defaults with either `LokiSmartHomeAdapter` or a real HA-backed adapter seam. The key requirement is that resolver/device lookup no longer depends on hardcoded demo devices. |
| Work | Replace ephemeral `ConversationMemoryAdapter(context)` usage with a backed implementation for recent-entity recall so `recall_recent_media` and follow-up resolution survive across turns. |
| Work | Add source propagation from adapters into the v2 response object and synthesis path, closing the citations gap already identified in the graduation plan. |
| Gate | People, device, and conversation-memory resolution all use real runtime-backed adapters, not empty/test defaults. |
| Gate | External-provider skills surface usable `sources` metadata end-to-end. |
| Gate | The v2 runtime can execute a provider-specific standalone skill without a compile-time import in the central executor. |
| Gate | Skills no longer need fallback helpers like `_extract_location(payload)` to interpret raw user text. |

### Phase 3 — Finish The Incomplete V1 Ports

| Item | Design |
|---|---|
| Goal | Close the feature holes where v1 had meaningful functionality and v2 currently has none or only a partial slice. |
| Why third | Once the runtime plumbing is solid, we can safely expand the capability surface without building on fake adapters. |
| Work | Break provider-specific implementations out into standalone packages where v2 still uses domain-monolith files. Example targets: jokes providers, weather providers, movie-detail providers, generic web search providers, smart-home providers. |
| Work | Reintroduce a first-class `search_web` capability using the existing DDG adapter pattern. This should become a canonical v2 capability, not just an internal helper used by knowledge lookup. |
| Work | Restore the relationship/family-query surface from v1 `people_lookup` as explicit v2 capabilities such as `lookup_relationship` and `list_family`, backed by the now-wired real people DB adapter. |
| Work | Restore a movie detail/search surface. The cleanest design is a provider abstraction with `movies_tmdb` as the preferred live backend and `movies_wiki` as the no-key fallback. Expose capability names like `lookup_movie` and `search_movies`, rather than mirroring provider names into the user-facing surface. |
| Work | Expand the TV surface so v1's episode-oriented functionality is represented in v2. `lookup_tv_show` and `get_tv_schedule` are not enough if the product still wants season/episode detail and more precise scheduling. |
| Work | Decide whether `weather_owm` remains intentionally retired. If yes, document that permanently; if not, add it as an alternate provider behind the same weather capability contract. |
| Gate | Every meaningful v1 user-facing surface is either ported, deliberately replaced, or explicitly retired in the registry and this document. |
| Gate | No v1 skill package remains in a "mystery missing" state. |
| Gate | Multi-provider domains are represented by separate standalone skills, not a single hardcoded domain file. |

### Phase 4 — Replace Curated/Prototype Local Knowledge Stops

| Item | Design |
|---|---|
| Goal | Eliminate user-facing capabilities that currently pretend to be current/live while running against static local catalogs. |
| Why fourth | These are the biggest trust gaps in the current v2 surface. |
| Work | Replace `search_flights` local route KB with a real flight search provider abstraction. The contract should support route search, date, passengers, and later filters like cabin/non-stop. Keep the current local KB only as a true offline fallback, not the default path. |
| Work | Replace `search_hotels` local chain KB with a hotel-search provider abstraction. Preserve the current local KB only as an offline or no-provider fallback. |
| Work | Replace `get_visa_info` local KB with a structured visa source. Since visa rules are highly time-sensitive, this capability should not claim to be current unless it is provider-backed and source-attributed. |
| Work | Replace `get_streaming`'s curated movie catalog with a real streaming-availability provider. TVMaze can remain the TV fallback, but movie streaming needs a true current source. |
| Work | Replace `find_products` curated picks with a provider-backed search/recommendation layer. If ranking quality is not good enough, keep curated overlays as post-filtering/reranking, not as the primary dataset. |
| Gate | Travel, streaming, and shopping capabilities default to current provider-backed data whenever internet is available. |
| Gate | Local curated KBs remain only as explicit fallback mechanisms with honest registry metadata. |

### Phase 5 — Replace Prototype Device Stores With Real Integrations

| Item | Design |
|---|---|
| Goal | Turn device-style skills from JSON demos into real local/native integrations for the active profile. |
| Why fifth | These skills work today, but they are still product prototypes rather than working assistant capabilities. |
| Work | Replace local calendar/alarm/reminder/notes/contact/message/email/call/music backends with profile-aware adapters. On mac, this likely means native or file-backed integrations; on Pi, it may mean local services or plugin-backed implementations. |
| Work | Keep the current JSON stores as dev/test adapters so the v2 pipeline remains hermetic in tests. The runtime should choose adapters by profile, not by hardcoded prototype defaults. |
| Work | Split each device capability into an interface layer plus per-profile adapters. Avoid letting the v2 pipeline import profile-specific code directly from handlers. |
| Work | Upgrade smart-home control, state, temperature, presence, and scenes onto a real Home Assistant integration while preserving CPU-only fallback behavior required by the repo contract. |
| Gate | Device skills perform real actions or read real state on supported profiles. |
| Gate | JSON-store adapters remain available only for test/dev mode, not as the production runtime default. |

### Phase 6 — Finish The Provider-Limited Capabilities

| Item | Design |
|---|---|
| Goal | Remove the remaining `limited` and placeholder paths that still block a "fully working v2" claim. |
| Why sixth | By this point the plumbing and major provider migrations are done, so the remaining gaps are narrow but important. |
| Work | Wire a real player-stats provider for `get_player_stats`. This is already called out in the catalog as still needing structured provider wiring. |
| Work | Expand `lookup_fact` beyond its current small Wikidata property map so the capability can answer a broader set of fact questions without silently degrading. |
| Work | Expand `substitute_ingredient` beyond the tiny local table, ideally to a structured culinary source or a constrained LLM-assisted rule set with citations. |
| Work | Upgrade `get_time_in_location` from a static city map to a fuller timezone resolver that can safely handle more user phrasings and locations. |
| Work | Improve `get_tv_schedule` beyond the current TVMaze schedule fields if the product still expects richer episode/date/channel answers. |
| Gate | No capability remains in the registry with a known placeholder implementation or "provider wiring still in progress" path. |
| Gate | All remaining `limited` labels are intentional product decisions, not unfinished engineering. |

### Phase 7 — LLM Skill Productionization

| Item | Design |
|---|---|
| Goal | Make the generative skill family reliable enough to count as fully working rather than "stub-fallback when disabled." |
| Why seventh | The repository already treats these separately from provider/domain skills, and they need different gates. |
| Work | Decide the official runtime contract for writing/code/support/planning/decision skills: required model, timeout budget, failure behavior, and minimum quality bar. |
| Work | Move away from generic canned stubs as the normal non-pytest path. In production-like runtime, these should either hit the configured local LLM or return a transparent "LLM unavailable" failure instead of pretending to succeed. |
| Work | Add capability-specific eval corpora for email drafting, summarization, code assistance, planning, and empathy so regressions are measurable. |
| Work | Thread citation/source support where these skills summarize or transform externally sourced material. |
| Gate | LLM-backed skills are either truly available with the configured local models or transparently unavailable; they are no longer effectively demo stubs. |
| Gate | Capability-specific evals exist and pass. |

### Phase 8 — Source Transparency, Offline Policy, And Phase Gates

| Item | Design |
|---|---|
| Goal | Make the final v2 skills surface trustworthy: correct provenance, honest online/offline behavior, and enforceable release gates. |
| Why last | This phase turns the rebuilt skill surface into a maintainable contract instead of a one-time migration. |
| Work | Enforce a policy that any capability answering current or factual external questions must attach source metadata. Local/prototype skills should say they are local when relevant. |
| Work | Add a per-capability online/offline matrix to the registry and dev tools so users and developers can tell whether a skill is provider-backed, fallback-backed, or offline-safe. |
| Work | Add a regression test that compares this audit document against the registry state for key fields like capability existence, handler name, and declared maturity. |
| Work | Turn the high-level gaps in this document into phase gates: a capability family should not be marked done until provider wiring, source metadata, tests, and profile/runtime selection are all green. |
| Gate | The registry, docs, and runtime behavior stay in sync automatically enough that drift is caught in CI. |
| Gate | The team can truthfully say the v2 skill surface is fully working because each family has a concrete acceptance gate, not just a handler that returns text. |

### Suggested Delivery Order

| Order | Phase | Rationale |
|---|---|---|
| 1 | Foundation And Contract Cleanup | Stops further drift and gives the team one truthful contract. |
| 2 | Core Runtime Wiring | Unlocks people/device/memory correctness for many skills. |
| 3 | Finish The Incomplete V1 Ports | Closes the obvious product holes before deeper provider work. |
| 4 | Replace Curated/Prototype Local Knowledge Stops | Removes the biggest current-data trust gaps. |
| 5 | Replace Prototype Device Stores With Real Integrations | Turns demos into actual assistant actions. |
| 6 | Finish The Provider-Limited Capabilities | Cleans up the remaining placeholder paths. |
| 7 | LLM Skill Productionization | Makes the generative family truly operational. |
| 8 | Source Transparency, Offline Policy, And Phase Gates | Locks the whole surface into a maintainable production contract. |

## Source References

- [v2/data/function_registry.json](/Users/jessetorres/Projects/loki-doki/v2/data/function_registry.json:1)
- [docs/v2-skill-catalog.md](/Users/jessetorres/Projects/loki-doki/docs/v2-skill-catalog.md:1)
- [docs/v2-graduation-plan.md](/Users/jessetorres/Projects/loki-doki/docs/v2-graduation-plan.md:60)
- [v2/orchestrator/execution/executor.py](/Users/jessetorres/Projects/loki-doki/v2/orchestrator/execution/executor.py:1)
- [v2/orchestrator/resolution/resolver.py](/Users/jessetorres/Projects/loki-doki/v2/orchestrator/resolution/resolver.py:1)
- [v2/orchestrator/skills](/Users/jessetorres/Projects/loki-doki/v2/orchestrator/skills)
- [lokidoki/skills](/Users/jessetorres/Projects/loki-doki/lokidoki/skills)
