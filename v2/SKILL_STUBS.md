# v2 Skill Stubs — what to wire up for real

The v2 prototype ships deterministic stub handlers for every capability so the
routing layer has a real destination for every prompt category in
`docs/v2_prototype.md` and the ChatGPT routing-table regression fixtures
(`tests/fixtures/v2_regression_prompts.json`). The stubs return canned
strings that the regression suite can assert on, but they do **not**
integrate with real backends yet.

This file tracks every stub and what it needs in order to ship for real.

> Routing, parameter extraction, the executor's retry/timeout layer, and the
> Gemma fallback path are all production-ready — the gap is only in the
> handler bodies. Replacing a stub means swapping the function in
> `v2/orchestrator/execution/executor.py::_HANDLER_REGISTRY` for a real
> implementation that calls the relevant provider.

---

## Stub catalog

| # | Capability | Handler | What the stub returns | What it needs to ship |
|---|---|---|---|---|
| 1 | `get_weather` | `_weather_handler` | `"Weather forecast: clear with a high near 72°F."` | Wire to a real weather provider (e.g. open-meteo). Resolve location from chunk text or user profile. Resolve date (today / tomorrow / day-of-week). |
| 2 | `get_movie_showtimes` | `_showtimes_handler` | Stub showtimes string (4:30 / 7:00 / 9:45 PM) for the extracted title | Wire to a real showtimes provider (Fandango, TMDb, etc.). Add zip-code / city resolution. Real title disambiguation against TMDb. |
| 3 | `lookup_person_birthday` | `_person_birthday_handler` | `"<Name>'s birthday is <Month Day>."` from the people-DB roster | Replace the in-memory roster (`v2/orchestrator/adapters/people_db.py::_DEFAULT_ROSTER`) with the real LokiDoki SQLite people store. |
| 4 | `knowledge_query` | `_knowledge_handler` | `"Knowledge query (stub): <chunk text>"` | Wire to a real retrieval skill (web + wiki + lokidoki memory) and a thinking-mode Qwen synthesizer. This is the LLM-fallback "explain / define / compare / troubleshoot" path. |
| 5 | `convert_units` (routed path) | `_convert_units_handler` | Re-uses the fast-lane matcher | The fast lane already does deterministic conversion. Routed path only fires inside compound utterances; consider extending the fast lane's lookup tables (more units) rather than adding logic here. |
| 6 | `get_indoor_temperature` | `_indoor_temperature_handler` | `"Indoor temperature is currently 68°F (stub)."` | Wire to the Home Assistant climate sensor (or whichever sensor LokiDoki integrates). Resolve room scope from chunk text. |
| 7 | `detect_presence` | `_detect_presence_handler` | `"I don't see anyone in the <room> right now (stub)."` | Wire to a presence/occupancy sensor (HA `binary_sensor.<room>_occupancy`, Frigate, etc.). Resolve room from chunk text. |
| 8 | `get_device_state` | `_device_state_handler` | `"<device> is currently closed (stub)."` | Wire to Home Assistant entity-state read (`get_state(entity_id)`). Resolve device entity from chunk text against the smart-home device registry. Detect open/closed/locked/on/off semantics from the verb. |
| 9 | `get_time_in_location` | `_time_in_location_handler` | `"It's currently 9:30 PM in <City> (stub: location-aware time not yet wired up)."` | Resolve city → IANA timezone (e.g. via `pytz` or a static city table) and return the actual local time. |
| 10 | `generate_email` | `_generate_email_handler` | Canned refund-email template | Route to thinking-mode Qwen with an email-drafting prompt template. Resolve recipient, tone, and purpose from chunk text. |
| 11 | `code_assistance` | `_code_assistance_handler` | Stub Python `def solve(): pass` block | Route to a code-tuned LLM (Qwen-Coder or similar). Resolve language, intent (generate / debug / explain / optimize), and any user-provided code from the chunk text. |
| 12 | `summarize_text` | `_summarize_text_handler` | `"Summary (stub): the article's main point in one sentence."` | Resolve the source text (clipboard? URL? prior message?) and route to a summarizer. |
| 13 | `create_plan` | `_create_plan_handler` | 3-day arrival/main/wrap-up template | Route to thinking-mode Qwen with a plan-generation prompt template. Resolve plan type (trip / workout / study / meal / week), duration, and user constraints. |
| 14 | `weigh_options` | `_weigh_options_handler` | `"Both options have merit (stub). Pros and cons would be weighed..."` | Extract the two options from the chunk text (split on `or`), then route to thinking-mode Qwen with a structured pro/con prompt. |
| 15 | `find_products` | `_find_products_handler` | `"Top picks (stub): Option A, Option B, Option C..."` | Wire to a real shopping API (TBD: Amazon Product Advertising, Best Buy, etc.) or a curated recommendations dataset. Resolve category, budget, and use case from chunk text. |
| 16 | `emotional_support` | `_emotional_support_handler` | `"I hear you, and that sounds really hard (stub)..."` | Route to thinking-mode Qwen with an empathy-tuned system prompt. Pull tone signal from `signals.tone_signal` and adjust language accordingly. Consider escalation cues (crisis language → safety prompt). |

---

## Cross-cutting work

Before any of the above can ship, the following platform-level pieces still
need attention:

1. **Parameter extraction layer** — most stubs currently dig parameters out
   of `chunk_text` with light string parsing. A real implementation should
   route through a typed parameter extractor (per-capability schema) that
   can handle synonyms, location resolution, date parsing, etc.
2. **Per-skill provider configuration** — each skill needs its own
   credentials / endpoint config in `lokidoki/settings/` (or the equivalent
   v2 config layer).
3. **Real LLM client wiring** — `v2/orchestrator/fallbacks/ollama_client.py`
   already speaks to Ollama for the Gemma fallback. Skills that need a
   thinking-mode Qwen call should reuse the same client + a per-skill prompt
   template (see `v2/orchestrator/fallbacks/prompts.py`).
4. **Streaming responses** — generative skills (`generate_email`,
   `code_assistance`, `summarize_text`, `create_plan`, `weigh_options`,
   `emotional_support`) would benefit from token-by-token streaming. The
   trace listener already has a `subscribe()` hook the executor could use.
5. **Skill-level cost / timeout overrides** — the executor's
   `CONFIG.handler_timeout_s` is uniform (4 s). LLM-backed skills will need
   higher ceilings; cheap sensor reads can be much faster. Consider per-skill
   overrides in `v2/orchestrator/core/config.py`.

---

## When you replace a stub

1. Edit `v2/orchestrator/execution/executor.py` — replace the stub function
   body with the real implementation. Keep the function signature
   (`payload: dict[str, Any] -> dict[str, Any]` with an `output_text` key)
   so the executor's retry / timeout / error normalization keeps working.
2. Remove the row from this file's stub catalog table.
3. Add a real integration test under `tests/integration/`. The existing
   regression fixture is sufficient for routing — what's missing is
   end-to-end tests that exercise the real provider.
4. If the provider can fail or rate-limit, raise `TransientHandlerError`
   from `v2/orchestrator/execution/errors.py` so the executor's retry loop
   kicks in. Hard failures should raise `HandlerError` to short-circuit.
