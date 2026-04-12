# Chunk 12 — Skills Phases 4-8: Providers + Device + Polish

**Source:** `docs/v2-skills-design.md` Phases 4-8.
**Prereqs:** C11.

---

This is the long-tail backlog. Each sub-phase can be its own chat session.

## Phase 4 — Replace Curated/Prototype Local KBs
- `search_flights` -> real flight provider (Amadeus/Google Flights)
- `search_hotels` -> real hotel provider
- `get_visa_info` -> structured visa source
- `get_streaming` -> real movie streaming provider
- `find_products` -> real catalog search

## Phase 5 — Replace Prototype Device Stores
- Calendar, alarms, reminders, notes, contacts, messages, email, calls, music -> profile-aware native adapters
- Keep JSON stores for dev/test only
- Smart-home -> real Home Assistant integration

## Phase 6 — Finish Provider-Limited Capabilities
- `get_player_stats` -> real sports provider
- `lookup_fact` -> broader Wikidata coverage
- `substitute_ingredient` -> better source
- `get_time_in_location` -> full timezone resolver
- `get_tv_schedule` -> richer TVMaze integration

## Phase 7 — LLM Skill Productionization
- Official contract for writing/code/support/planning/decision skills
- Replace stubs with real LLM calls or transparent "unavailable"
- Capability-specific eval corpora

## Phase 8 — Source Transparency + Offline Policy
- Enforce source metadata on factual capabilities
- Per-capability online/offline matrix
- Expand drift CI guard
- Phase gates per capability family

---

## Gate: v2 skills surface is fully working, each family has a concrete acceptance gate.
