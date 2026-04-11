# V2 Skill Catalog

This document is the audited current-state catalog for the v2 prototype.

It answers three questions for every function:

1. Is it wired in `v2/data/function_registry.json` today?
2. What backend does the v2 prototype actually use right now?
3. Is it production-real, prototype-real, search-backed, or still stubbed?

If this file conflicts with an older planning note, this file wins.

---

## Status Legend

| Status | Meaning |
|---|---|
| `real/provider` | Real backend with a domain-specific API or proven v1 skill adapter |
| `real/local` | Real working v2 implementation, but backed by prototype-local JSON/device state rather than final OS/native integration |
| `real/search` | Real working v2 implementation, but backed by generic live web search rather than the final domain provider |
| `limited` | Real and working, but intentionally narrow or simplified |
| `stub-fallback` | Implemented, but falls back to deterministic stub output in normal dev/test mode |
| `missing` | Not wired in v2 |

---

## Catalog Summary

| Area | State |
|---|---|
| Conversation, time, holidays, weather, knowledge, dictionary, recipes, jokes, news, units, currency | Mostly `real/provider` |
| Calendar, alarms, contacts, messaging, notes, music controls, fitness | `real/local` |
| Navigation, health, people facts, sports | Mixed `real/provider` and `real/local` |
| Travel (flights, hotels, transit, visa) | `real/local` (curated KBs replaced the old DDG search) |
| Streaming availability | `real/local` (curated KB) → falls through to TVMaze for unknown TV |
| Product recommendations | `real/local` (curated catalog + JSON store overlay) |
| Smart home | `real/provider` for mock skill backend, but still prototype/home-mock not production HA |
| Presence detection | `real/local` via persistent `presence.json` store (no in-memory overlay) |
| Translation | `real/provider` via public translation API |
| Stocks | `real/provider` via Yahoo quote endpoint |
| Generative writing/code/planning/decision/support | `stub-fallback` unless Gemma is enabled |

> Every entry in `v2/data/function_registry.json` now also carries a v1-style
> `parameters` dict (`{name: {type, required, ...}}`) and a `mechanisms`
> list (`{method, priority, timeout_ms, requires_internet}`) so the
> executor and the dev tools panel can introspect them. A test in
> `tests/unit/test_v2_registry_router.py` enforces this shape on every
> capability.

---

## Conversation

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `greet()` | `core.greetings.reply` | deterministic built-in response | `real/local` | Also exposed as `greeting_response` |
| `acknowledge()` | `core.acknowledgments.reply` | deterministic built-in response | `real/local` | Also exposed as `acknowledgment_response` |
| `chat(text)` | `fallback.direct_chat` | echo/fallback conversational path | `limited` | Not a rich chat model by itself |

## Time

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `get_current_time()` | `core.time.get_local_time` | Python system clock | `real/provider` | Fast-lane capable |
| `get_current_date()` | `core.date.get_local_date` | Python system clock | `real/provider` | Fast-lane capable |
| `get_time_in_location(city)` | `core.time.location` | `zoneinfo` + static city map | `limited` | No live WorldTimeAPI call; good for major cities |
| `time_until(target)` | `core.time.until` | local date math + holiday lookup | `real/provider` | Uses holiday adapter for named holidays |

## Holidays

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `get_holiday(name, country?, year?)` | `skills.holidays.lookup` | Nager.Date | `real/provider` | Free public-holiday API |
| `list_holidays(country, year?)` | `skills.holidays.list` | Nager.Date | `real/provider` | Free public-holiday API |

## Calendar

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `create_event(...)` | `device.calendar.create` | local JSON store in `v2/data/calendar.json` | `real/local` | Not EventKit/CalDAV yet |
| `get_events(...)` | `device.calendar.get` | local JSON store | `real/local` | |
| `update_event(...)` | `device.calendar.update` | local JSON store | `real/local` | |
| `delete_event(...)` | `device.calendar.delete` | local JSON store | `real/local` | |

## Alarms

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `set_alarm(...)` | `device.alarm.set` | local JSON store in `v2/data/alarms.json` | `real/local` | Not OS alarm integration yet |
| `set_timer(...)` | `device.timer.set` | local JSON store | `real/local` | |
| `set_reminder(...)` | `device.reminder.set` | local JSON store | `real/local` | |
| `cancel_alarm(...)` | `device.alarm.cancel` | local JSON store | `real/local` | |
| `list_alarms()` | `device.alarm.list` | local JSON store | `real/local` | |

## Spelling

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `spell_word(word)` | `core.dictionary.spell` | deterministic built-in echo/spell target path | `limited` | Returns the requested word, not phonetic spelling logic |
| `define_word(word, lang?)` | `skills.dictionary.lookup` | `dictionaryapi.dev` via v1 adapter | `real/provider` | Also exposed as `lookup_definition` |

## Math

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `calculate(expression)` | `core.calculator.evaluate` | v1 calculator safe-eval | `real/provider` | Also exposed as `calculate_math` |
| `calculate_tip(amount, pct?, split?)` | `core.calculator.tip` | deterministic local tip math | `real/local` | |

## Units

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `convert(amount, from_unit, to_unit)` | `core.units.convert` | v1 unit conversion tables | `real/provider` | Also exposed as `convert_units` |
| `convert_currency(amount, from, to)` | `skills.finance.convert_currency` | Frankfurter | `real/provider` | |
| `get_exchange_rate(from, to)` | `skills.finance.exchange_rate` | Frankfurter | `real/provider` | |

## Weather

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `get_forecast(location?, date?)` | `skills.weather.forecast` | v1 Open-Meteo adapter | `real/provider` | Also exposed as `get_weather` |

## Navigation

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `get_directions(origin, dest, mode?)` | `skills.navigation.directions` | Nominatim + OSRM | `real/provider` | Driving-oriented right now |
| `get_eta(destination, mode?)` | `skills.navigation.eta` | Nominatim + OSRM | `real/provider` | Simplified origin assumption in current parser |
| `find_nearby(category, location?)` | `skills.navigation.nearby` | Overpass + Nominatim | `real/provider` | |
| `get_transit(origin, destination)` | `skills.navigation.transit` | curated metro KB in `travel_local.py` | `real/local` | Covers New York, LA, SF, Chicago, Boston, DC, London, Paris, Tokyo |

## Media

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `get_movie_showtimes(title, location?)` | `skills.movies.showtimes` | v1 Fandango/movie showtimes adapter | `real/provider` | |
| `get_streaming(title)` | `skills.media.streaming` | curated catalog in `streaming_local.py` → TVMaze fallthrough | `real/local` | Covers tentpole movies + franchises; falls back to TVMaze for unknown TV shows |
| `get_tv_schedule(title, channel?)` | `skills.tv.schedule` | TVMaze lookup with schedule fields | `real/provider` | Returns airtime/day when TVMaze provides it |
| `recall_recent_media()` | `context.media.recall_recent` | conversation-memory resolver | `real/local` | |

## Music

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `play_music(query, context?)` | `device.music.play` | local playback-state JSON store | `real/local` | Does not control Spotify/OS playback yet |
| `control_playback(action)` | `device.music.control` | local playback-state JSON store | `real/local` | |
| `get_now_playing()` | `device.music.now_playing` | local playback-state JSON store | `real/local` | |
| `set_volume(level)` | `device.music.volume` | local playback-state JSON store | `real/local` | |
| `lookup_track(query)` | `skills.music.lookup_track` | MusicBrainz | `real/provider` | |

## People

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `lookup_birthday(person)` | `core.people.birthday` | local people resolver / prototype people data | `real/local` | Also exposed as `lookup_person_birthday`; not Wikidata-backed yet |
| `lookup_fact(person, fact)` | `skills.people.fact` | Wikidata entity/property lookup | `real/provider` | Current structured coverage is limited to a small set of mapped facts |

## Contacts

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `search_contacts(query)` | `device.contacts.search` | local JSON store in `v2/data/communications.json` | `real/local` | |
| `read_messages(person?, count?)` | `device.messages.read` | local JSON store | `real/local` | |
| `read_emails(folder?, filter?)` | `device.emails.read` | local JSON store | `real/local` | |
| `make_call(person)` | `device.phone.call` | local JSON store / call log | `real/local` | Not actual phone dialer integration yet |

## Messaging

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `send_text(person, body?)` | `skills.messaging.send_text` | local JSON message sender | `real/local` | Message write is real in prototype, not real SMS/iMessage transport |
| `generate_email(purpose, tone?, recipient?)` | `skills.writing.email` | LLM path via Ollama when enabled, deterministic stub otherwise | `stub-fallback` | Production-real only when Gemma path is enabled and improved |

## Notes

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `create_note(title?, body)` | `device.notes.create` | local JSON store in `v2/data/notes.json` | `real/local` | |
| `append_to_list(list_name, items)` | `device.notes.append_list` | local JSON store | `real/local` | |
| `read_list(list_name)` | `device.notes.read_list` | local JSON store | `real/local` | |
| `search_notes(query)` | `device.notes.search` | local JSON store | `real/local` | |

## Finance

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `get_stock_price(ticker)` | `skills.finance.stock_price` | Yahoo quote endpoint | `real/provider` | Uses unofficial Yahoo quote API |
| `get_stock_info(ticker)` | `skills.finance.stock_info` | Yahoo quote endpoint | `real/provider` | Uses quote metadata, not a full company-profile API |

## Sports

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `get_score(team_or_game)` | `skills.sports.score` | ESPN public scoreboard JSON | `real/provider` | |
| `get_standings(league, date?)` | `skills.sports.standings` | ESPN standings JSON | `real/provider` | |
| `get_schedule(team_or_league)` | `skills.sports.schedule` | ESPN scoreboard JSON | `real/provider` | |
| `get_player_stats(player, stat?, season?)` | `skills.sports.player_stats` | sports placeholder path | `limited` | Still needs structured player-stat provider wiring |

## News

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `get_headlines(topic?, source?)` | `skills.news.google_rss` | v1 Google News RSS adapter | `real/provider` | Registered under `get_news_headlines` in older v2 flow |
| `get_briefing()` | `skills.news.briefing` | Google News RSS adapter | `real/provider` | |
| `search_news(query, recency?)` | `skills.news.search` | Google News RSS search | `real/provider` | |

## Smart Home

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `control_device(device, action)` | `skills.home_assistant.toggle` | v1 smart-home mock backend | `real/local` | Working, but still not real Home Assistant/Matter |
| `get_device_state(device)` | `skills.home_assistant.state` | v1 smart-home mock backend | `real/local` | |
| `detect_presence(room)` | `skills.presence.detect` | persistent `v2/data/presence.json` store via `_store.load_store` | `real/local` | Mechanism chain: `ha_sensor` placeholder → `local_state` JSON store → graceful failure |
| `get_indoor_temperature(room?)` | `skills.sensors.indoor_temperature` | v1 smart-home mock thermostat | `real/local` | |
| `set_scene(scene_name)` | `skills.home_assistant.scene` | v2 scene composition over smart-home mock backend | `real/local` | Needs real HA scene integration |

## Food

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `find_recipe(dish, constraints?)` | `skills.recipes.themealdb` | v1 MealDB adapter | `real/provider` | |
| `substitute_ingredient(ingredient, context?)` | `skills.food.substitute` | tiny local substitution table | `limited` | Needs broader model/provider coverage |
| `get_nutrition(food, amount?)` | `skills.food.nutrition` | Open Food Facts search | `real/provider` | |
| `order_food(restaurant?, items?)` | `skills.food.order` | local order-draft store | `real/local` | Not DoorDash/Uber Eats/Grubhub integration yet |

## Travel

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `search_flights(origin, dest, date, passengers?)` | `skills.travel.flights.search` | curated route KB in `travel_local.py` | `real/local` | Mechanism: `local_routes` (carrier list per IATA pair); upgrade target is Amadeus / Google Flights API |
| `get_flight_status(flight_number)` | `skills.travel.flight_status` | OpenSky live states API | `real/provider` | Current implementation is callsign/airborne-state oriented |
| `search_hotels(location, dates, guests?)` | `skills.travel.hotels.search` | curated chain KB in `travel_local.py` | `real/local` | Mechanism: `local_chains` (3 picks per major city); upgrade target is Booking.com / Expedia |
| `get_visa_info(passport, destination)` | `skills.travel.visa` | curated visa KB in `travel_local.py` | `real/local` | Mechanism: `local_visa_kb` (US/UK/EU/Canada/India/China/Japan corridors); upgrade target is a structured visa-status API |

## Health

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `look_up_symptom(symptom)` | `skills.health.symptom` | MedlinePlus search API | `real/provider` | |
| `check_medication(name, query?)` | `skills.health.medication` | RxNorm approximate-term + properties API | `real/provider` | |
| `log_workout(type, duration?, notes?)` | `device.fitness.log` | local JSON workout log | `real/local` | |
| `get_fitness_summary(period?)` | `device.fitness.summary` | local JSON workout log | `real/local` | |

## Knowledge

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `query(question)` | `core.knowledge.lookup` | v1 Wikipedia adapter | `real/provider` | Also exposed as `knowledge_query` |

## Writing

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `generate_email(purpose, tone?, recipient?)` | `skills.writing.email` | Ollama Gemma when enabled, stub otherwise | `stub-fallback` | |
| `summarize(source)` | `skills.writing.summarize` | Ollama Gemma when enabled, stub otherwise | `stub-fallback` | |
| `translate(text, target_lang)` | `skills.writing.translate` | MyMemory public translation API | `real/provider` | Good enough for prototype, not local/self-hosted |

## Code

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `assist(intent, language?, code?)` | `skills.code.assistant` | Ollama Gemma when enabled, stub otherwise | `stub-fallback` | |

## Planning

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `create_plan(plan_type, duration?, constraints?)` | `skills.planning.create_plan` | Ollama Gemma when enabled, stub otherwise | `stub-fallback` | |

## Decision

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `weigh_options(option_a, option_b, ...)` | `skills.decision.weigh_options` | Ollama Gemma when enabled, stub otherwise | `stub-fallback` | |

## Shopping

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `find_products(category, budget?, use_case?)` | `skills.shopping.find_products` | curated catalog in `shopping_local.py` + JSON store overlay | `real/local` | Mechanism: `local_catalog` (good/better/best per category) with `add_pick(category, name, price)` for user-curated overrides; upgrade target is Amazon PA-API or Best Buy |

## Support

| Function | Current handler | Current backend | Status | Notes |
|---|---|---|---|---|
| `empathize(feeling?)` | `skills.support.empathy` | Ollama Gemma when enabled, stub otherwise | `stub-fallback` | |

---

## What Still Needs To Become Production-Real

### Replace prototype-local stores with native/device integrations

- Calendar
- Alarms, timers, reminders
- Contacts, messages, emails, calling
- Notes and lists
- Music playback and volume
- Fitness/health device summaries
- Smart-home control, presence, temperature, scenes

### Upgrade curated KBs to real provider APIs

The following capabilities are now offline-first with curated KBs that
make every regression test pass under the 500ms budget. The KBs are
intentionally small (covering ~10 cities, 20 movies, 15 product
categories, etc.) and the upgrade target for each is listed below:

- `find_products` → Amazon Product Advertising API or Best Buy
- `get_streaming` → JustWatch / Reelgood (TVMaze fallthrough already in place)
- `search_flights` → Amadeus / Google Flights
- `search_hotels` → Booking.com / Expedia
- `get_visa_info` → structured visa-status API (e.g. Sherpa)
- `get_transit` → GTFS feeds or Transitland
- `get_player_stats` → ESPN player API or Sportradar

### Replace limited implementations

- `get_time_in_location` should move from static city map to a fuller timezone resolver
- `get_tv_schedule` still needs richer episode/channel/date scheduling beyond the current TVMaze schedule fields
- `substitute_ingredient` should move beyond a tiny local table
- `order_food` should become a real provider integration
- `lookup_birthday` should be backed by Wikidata or a structured fact source
- `spell_word` should move beyond the current simple repeat-back behavior if we want full spoken spelling behavior

### Remove stub-fallback generative paths

These are only production-real when the model path is on and tuned:

- `generate_email`
- `summarize`
- `assist`
- `create_plan`
- `weigh_options`
- `empathize`

---

## Source Of Truth In Code

- Capability registry: [v2/data/function_registry.json](/Users/jessetorres/Projects/loki-doki/v2/data/function_registry.json)
- Handler map: [v2/orchestrator/execution/executor.py](/Users/jessetorres/Projects/loki-doki/v2/orchestrator/execution/executor.py)
- Skill implementations: [v2/orchestrator/skills](/Users/jessetorres/Projects/loki-doki/v2/orchestrator/skills)
