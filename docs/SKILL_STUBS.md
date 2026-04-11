# v2 Skill Stubs — what to wire up for real

The v2 prototype's executor dispatches every routed capability through
[`v2/orchestrator/skills/`](orchestrator/skills/) — a thin adapter layer
that wraps the production v1 LokiDoki skills (with their fallback chains
and offline caches) for everything that has a v1 backend, and falls
through to the v2 Ollama client for the generative skills. Only a small
handful of capabilities are still pure stubs.

This file tracks every stub and what it needs in order to ship for real.

> Routing, parameter extraction, the executor's retry/timeout layer, and
> the Gemma fallback path are all production-ready — the gap is only in
> the handler bodies. Replacing a stub means swapping the function in
> [`v2/orchestrator/execution/executor.py::_HANDLER_REGISTRY`](orchestrator/execution/executor.py)
> for a real implementation that returns the v2 handler shape
> (`{"output_text": str, ...}`).

---

## ✅ Real backends (already shipping)

These capabilities now dispatch into real adapter modules under
[`v2/orchestrator/skills/`](orchestrator/skills/). Each adapter wraps a
v1 LokiDoki skill (or, for `get_time_in_location`, the stdlib
`zoneinfo` module) and walks the v1 fallback chain (live API → local
cache → graceful failure).

| Capability | Adapter | v1 backend | Fallback chain |
|---|---|---|---|
| `get_weather` | [skills/weather.py](orchestrator/skills/weather.py) | `OpenMeteoSkill` | open-meteo geocode → forecast → local cache → graceful failure |
| `knowledge_query` | [skills/knowledge.py](orchestrator/skills/knowledge.py) | `WikipediaSkill` | mediawiki API → web scraper → graceful failure |
| `get_movie_showtimes` | [skills/showtimes.py](orchestrator/skills/showtimes.py) | `FandangoShowtimesSkill` | movie_showtimes → napi_theaters_with_showtimes → local cache → graceful failure |
| `control_device` | [skills/smarthome.py](orchestrator/skills/smarthome.py) | `SmartHomeMockSkill` | local JSON state (offline, deterministic) |
| `get_device_state` | [skills/smarthome.py](orchestrator/skills/smarthome.py) | `SmartHomeMockSkill` | local JSON state (offline, deterministic) |
| `get_indoor_temperature` | [skills/smarthome.py](orchestrator/skills/smarthome.py) | `SmartHomeMockSkill` thermostat | local JSON state (offline, deterministic) |
| `lookup_definition` | [skills/dictionary.py](orchestrator/skills/dictionary.py) | `DictionarySkill` | dictionaryapi.dev → graceful failure |
| `get_news_headlines` | [skills/news.py](orchestrator/skills/news.py) | `NewsRSSSkill` | Google News RSS → graceful failure |
| `find_recipe` | [skills/recipes.py](orchestrator/skills/recipes.py) | `RecipeMealDBSkill` | TheMealDB → graceful failure |
| `tell_joke` | [skills/jokes.py](orchestrator/skills/jokes.py) | `JokesSkill` | icanhazdadjoke → graceful failure |
| `lookup_tv_show` | [skills/tv_show.py](orchestrator/skills/tv_show.py) | `TVMazeSkill` | TVMaze API → local cache → graceful failure |
| `convert_units` (routed) | [skills/units.py](orchestrator/skills/units.py) | `UnitConversionSkill` | offline lookup tables (no network) |
| `calculate_math` (routed) | [skills/calculator.py](orchestrator/skills/calculator.py) | `CalculatorSkill` | AST safe-eval (no network) |
| `get_time_in_location` | [skills/time_in_location.py](orchestrator/skills/time_in_location.py) | stdlib `zoneinfo` | static city → IANA tz table (no network) |
| `lookup_person_birthday` | (built-in resolver) | v2 `PeopleDBAdapter` roster | in-memory roster (offline, deterministic) |
| `recall_recent_media` | (built-in resolver) | v2 `MovieContextAdapter` | conversation context (offline, deterministic) |

---

## 🤖 LLM-backed (real model when enabled, stub otherwise)

These capabilities have no v1 LokiDoki equivalent — they each need a
generative model. They live in
[`skills/llm_skills.py`](orchestrator/skills/llm_skills.py) and dispatch
through the existing v2 Ollama client
([`v2/orchestrator/fallbacks/ollama_client.py`](orchestrator/fallbacks/ollama_client.py)).

When `CONFIG.gemma_enabled` is `True` they call Ollama with a
capability-specific prompt template. When it's `False` (the default in
tests + dev) or when the call fails / returns empty, they degrade to a
deterministic stub answer.

| Capability | Prompt template | Stub fallback |
|---|---|---|
| `generate_email` | "You are drafting a short professional email…" | Subject + body refund-email template |
| `code_assistance` | "You are a senior software engineer…" | Stub Python `def solve(): pass` block |
| `summarize_text` | "Summarize the following in 2-3 short sentences…" | "Summary (stub): the source's main point in one sentence." |
| `create_plan` | "Produce a short plan (3-5 bullets or day-by-day)…" | 3-day arrival/main/wrap-up plan |
| `weigh_options` | "Respond with Option A / Option B / Recommendation…" | "Both options have merit (stub)…" |
| `emotional_support` | "You are an empathetic, non-clinical companion…" | "I hear you, and that sounds really hard (stub)…" |

**To upgrade to real model output**: set `CONFIG.gemma_enabled = True`
in [`v2/orchestrator/core/config.py`](orchestrator/core/config.py) and
make sure Ollama is running with `gemma3:270m` (or override
`gemma_model` to a thinking-mode Qwen for better quality on these
generative tasks).

---

## ❌ Pure stubs (still need work)

| Capability | Handler | What the stub returns | What it needs to ship |
|---|---|---|---|
| `send_text_message` | `_send_text_handler` (executor.py) | `"Texting <name> now (stub: real messaging backend not wired up)."` | Wire to a real messaging provider (Twilio, iMessage shortcut, signal-cli, …). Resolve recipient against the people DB. Add a recipient-confirmation flow before send. |
| `find_products` | `_find_products_handler` (executor.py) | `"Top picks (stub): Option A, Option B, Option C…"` | Wire to a real shopping API (Amazon Product Advertising, Best Buy, …) or a curated dataset. Resolve category, budget, use case from chunk text. |
| `detect_presence` | [skills/smarthome.py](orchestrator/skills/smarthome.py) `detect_presence` | `"I don't see anyone in the <room> right now."` | Replace the in-memory `_PRESENCE` overlay table with real Home Assistant `binary_sensor.<room>_occupancy` (or Frigate / camera presence). The adapter scaffold is in place — only the data source needs swapping. |

---

## Cross-cutting work

Before any of the LLM-backed skills can ship at production quality, the
following platform-level pieces still need attention:

1. **Typed parameter extraction layer** — adapters currently dig
   parameters out of `chunk_text` with light string parsing. A real
   implementation should route through a per-capability typed extractor
   that handles synonyms, location resolution, date parsing, etc.
2. **Per-skill provider configuration** — each v1 skill expects its
   credentials / endpoint config to come through `parameters["_config"]`.
   The v2 adapter layer doesn't yet inject user/global config — it
   should pull from the same settings store as `lokidoki/orchestrator.py`.
3. **Streaming responses** — generative skills (`generate_email`,
   `code_assistance`, `summarize_text`, `create_plan`, `weigh_options`,
   `emotional_support`) would benefit from token-by-token streaming. The
   trace listener already has a `subscribe()` hook the executor could use.
4. **Skill-level cost / timeout overrides** — the executor's
   `CONFIG.handler_timeout_s` is uniform (4 s). LLM-backed skills will
   need higher ceilings; cheap sensor reads can be much faster. Consider
   per-skill overrides in `v2/orchestrator/core/config.py`.
5. **Cache promotion** — the v1 skills each maintain their own
   per-instance in-memory cache. The v2 adapters reuse those caches by
   holding the v1 skill as a process singleton, but a real deployment
   should promote the cache to disk so it survives restarts.

---

## When you replace a stub

1. Edit [`v2/orchestrator/execution/executor.py`](orchestrator/execution/executor.py)
   — replace the stub function body (or swap the `_HANDLER_REGISTRY`
   entry) with the real implementation. Keep the function signature
   (`payload: dict[str, Any] -> dict[str, Any]` with an `output_text`
   key) so the executor's retry / timeout / error normalization keeps
   working.
2. Remove the row from this file's stub catalog table.
3. Add a real integration test under `tests/integration/`. The existing
   regression fixture is sufficient for routing — what's missing is
   end-to-end tests that exercise the real provider.
4. If the provider can fail or rate-limit, raise `TransientHandlerError`
   from [`v2/orchestrator/execution/errors.py`](orchestrator/execution/errors.py)
   so the executor's retry loop kicks in. Hard failures should raise
   `HandlerError` to short-circuit.
5. For tests that should NOT hit the network, install a fake v1 skill
   instance in [`tests/integration/conftest.py::_patch_v2_skill_singletons`](../tests/integration/conftest.py)
   the same way the existing adapters do.
